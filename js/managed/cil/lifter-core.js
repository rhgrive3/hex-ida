import { createOriginSet } from '../../core/identity/origin.js';
import { createManagedExceptionRegionId, createManagedMethodId, createVMOperationId } from '../shared/identity.js';
import { createVMEffectBundle, createVMEffectBudgetTracker, createVMEffectFunction } from '../shared/vm-effects.js';
import { createCilFieldSignatureResolver, createCilLocalTypeResolver } from './call-signatures.js';
import { cilTokenText } from './metadata-layout.js';
import { cilImageLookups } from './image-lookup.js';
import { cilStackValueWidth } from './stack-width.js';
import { decodeCilInstructionBoundary } from './instruction-boundary.js';

function fail(code) { throw new TypeError(code); }

// ECMA-335 §I.12.3.2.1 evaluation-stack normalization: only int32/int64 carry
// a stack width this contract can pin. Wider/narrower types must not borrow a
// fabricated 32-bit identity (#5353).
function slotBitsForType(slotType) {
  if (!slotType || typeof slotType !== 'object') return null;
  if (slotType.stackType === 'int32') return 32;
  if (slotType.stackType === 'int64') return 64;
  return null;
}

// ECMA-335 §III.3: polymorphic integer opcodes take their operand and result
// width from the evaluation stack, not from the opcode. Only a run of
// stack pushes with no intervening pop, call, or control transfer proves the
// shape of the stack top, so width claims are restricted to that run; anything
// else stays unresolved instead of laundering into a fabricated 32-bit exact
// effect (#4043).
function operandWidths(run, count) {
  if (run.length < count) return null;
  const top = run.slice(run.length - count);
  return top.every((bits) => bits != null) ? top : null;
}

// ECMA-335 §III.3:1.5: plain `ceq`/`cgt`/`clt` compare the values currently on
// the stack, and `cgt`/`clt` are SIGNED unless the instruction is spelled `.un`.
// A managed reference (`ldnull`, `newobj`, a pointer field) and a floating value
// have different ordering semantics, so integral operand authority may only come
// from a push that states it: the int32/int64 evaluation-stack categories, or an
// integer literal. Anything else stays unresolved instead of minting a signed
// comparison the image never proved (#8785).
// Both the width and the float kind of the stack top must be proven for the
// same run of pushes so IEEE-754 arithmetic never inherits a fabricated integer
// identity. Only `r4`/`r8` float authority from a push that states it
// (`stackType:'float'` with a matching primitive, or an explicit `type.kind:'float'`)
// is accepted; everything else stays unresolved and keeps the existing
// width-based fail-closed behavior. (#8924)
const FLOAT_STACK_PRIMITIVE = Object.freeze({ r4:32, r8:64 });
function cilFloatStackWidth(value) {
  if (!value || typeof value !== 'object') return null;
  const bits = cilStackValueWidth(value);
  if (value.stackType === 'float') {
    const primitiveBits = FLOAT_STACK_PRIMITIVE[value.primitive];
    return primitiveBits != null ? primitiveBits : null;
  }
  if (value.type?.kind === 'float') {
    const typeBits = Number.isSafeInteger(value.type.widthBits) ? value.type.widthBits : null;
    return typeBits != null && (bits == null || bits === typeBits) ? typeBits : null;
  }
  return null;
}
function floatOperandWidths(widthRun, floatRun, count) {
  if (widthRun.length < count || floatRun.length < count) return null;
  const widths = widthRun.slice(widthRun.length - count);
  const floats = floatRun.slice(floatRun.length - count);
  if (!floats.every((w, i) => w != null && widths[i] != null && widths[i] === w)) return null;
  return new Set(floats).size === 1 ? floats : null;
}
function floatMachineType(width) {
  return {
    kind: 'float',
    widthBits: width,
    format: width === 64 ? 'binary64' : 'binary32',
  };
}

function cilStackValueIsIntegral(value) {
  if (cilStackValueWidth(value) == null) return false;
  if (value.isNull === true || value.stringToken != null || value.stringRef != null) return false;
  if (value.pointee != null || value.typeToken != null || value.valueType != null || value.referenceKind != null) return false;
  if (value.floating === true || value.type?.kind === 'float') return false;
  if (value.stackType != null) return value.stackType === 'int32' || value.stackType === 'int64';
  return value.constant != null && Number.isSafeInteger(Number(value.constant));
}

// Both the width and the integral category of the stack top must be proven for
// the same run of pushes, so a compare cannot borrow an integer shape from an
// unrelated reference push of the same size.
function integerOperandWidths(widthRun, integerRun, count) {
  if (widthRun.length < count || integerRun.length < count) return null;
  const widths = widthRun.slice(widthRun.length - count);
  const integers = integerRun.slice(integerRun.length - count);
  return widths.every((bits, i) => bits != null && integers[i] === true) ? widths : null;
}

// Field load/store value shape (#3971): the FieldSig decides the
// evaluation-stack value. int32/int64 widths come from the canonical type
// grammar; the float family pins r4/r8; reference and native-size values stay
// unstated until the image's pointer-width authority (#7775) attaches them —
// a resolved field never borrows a fabricated 32-bit integer identity.
const FLOAT_STACK_BITS = Object.freeze({ r4:32, r8:64 });
function fieldStackValue(fieldType) {
  const value = { ...fieldType };
  if (value.bits == null && value.stackType === 'float') {
    const bits = FLOAT_STACK_BITS[value.primitive];
    if (bits != null) value.bits = bits;
  }
  return value;
}

function fieldEffectKeys(resolution) {
  if (!resolution.complete) return { fieldResolved:false };
  return {
    fieldName:resolution.fieldName,
    ...(resolution.declaringType ? { declaringType:resolution.declaringType } : {}),
    fieldType:resolution.fieldType,
    fieldProvenance:resolution.provenance,
  };
}

function typedLocationAccess(kind, index, slotType, unknownEffects) {
  const access = { kind, index };
  if (!slotType?.complete) {
    // Without a resolved slot type, no width can be claimed: the access keeps
    // its kind/index identity but never borrows a fabricated 32-bit width,
    // and the bundle is downgraded to partial (#5353).
    unknownEffects.push({
      category:'locals',
      reason:slotType?.reason || 'cil-slot-type-unresolved',
      ...(index != null ? { slotIndex:index } : {}),
    });
    return access;
  }
  const bits = slotBitsForType(slotType.slotType);
  return bits != null ? { ...access, bits } : access;
}

function methodTokenText(bodyIndex, methodAuthority) {
  const token = methodAuthority?.methodToken;
  if (Number.isSafeInteger(token) && token >= 0x06000001 && token <= 0x06ffffff) {
    return `0x${token.toString(16).padStart(8, '0')}`;
  }
  return `0x06${(bodyIndex + 1).toString(16).padStart(6, '0')}`;
}

const CIL_FIELD_DEF_TABLE = 0x04;
const CIL_MEMBER_REF_TABLE = 0x0a;
const CIL_ACCESS_STATIC = 0x0010;
const CIL_TYPE_BEFORE_FIELD_INIT = 0x00100000;

// Static-field access carries the declaring type's initializer authority
// (#8048, ECMA-335 I.8.9.5): a non-`beforefieldinit` type triggers its
// `.cctor` at first static-field access, a `beforefieldinit` type may run it
// at any point up to the first access. The one-time initialization state is
// not provable per-instruction, so an access that may trigger a declared
// initializer fails closed to partial instead of publishing an unconditional
// pure load/store. An access from inside the declaring type's own `.cctor` is
// already on the initializing path and must not invent a recursive trigger. A
// type with no `.cctor` runs no declaring-type initializer code (base-type
// chain authority is a separate slice).
function resolveCilStaticFieldInitialization(cilImage, token, currentMethod) {
  const table = token >>> 24;
  const rid = token & 0x00ffffff;
  if (!Number.isSafeInteger(rid) || rid < 1) {
    return { resolved:false, reason:'cil-static-field-token-unresolved' };
  }
  if (table === CIL_MEMBER_REF_TABLE) {
    return { resolved:false, reason:'cil-static-field-owner-external' };
  }
  if (table !== CIL_FIELD_DEF_TABLE) {
    return { resolved:false, reason:'cil-static-field-token-unresolved' };
  }
  // Row identity lookups are indexed once per parsed image instead of being
  // rescanned per method instruction (#8791).
  const lookups = cilImageLookups(cilImage);
  if (!lookups.hasMethodRows) {
    return { resolved:false, reason:'cil-method-definitions-unavailable' };
  }
  const field = lookups.fieldByToken.get(`0x${token.toString(16).padStart(8, '0')}`);
  if (!field) return { resolved:false, reason:'cil-static-field-row-missing' };
  const ownerType = lookups.typeByToken.get(field.declaringTypeToken);
  if (!ownerType) return { resolved:false, reason:'cil-static-field-owner-type-missing' };
  const initializers = ownerType.token == null ? [] : lookups.initializersByOwner.get(ownerType.token) ?? [];
  if (initializers.length > 1) {
    return { resolved:false, reason:'cil-type-initializer-ambiguous' };
  }
  const initializer = initializers[0] ?? null;
  if (initializer && (initializer.accessFlags & CIL_ACCESS_STATIC) === 0) {
    return { resolved:false, reason:'cil-type-initializer-not-static' };
  }
  const selfInitializing = currentMethod?.name === '.cctor'
    && currentMethod?.declaringTypeToken === ownerType.token;
  return {
    resolved:true,
    reason:null,
    declaringTypeToken:ownerType.token,
    declaringType:`${ownerType.namespace ? `${ownerType.namespace}.` : ''}${ownerType.name}`,
    initializerPresent:initializer != null,
    beforeFieldInit:(ownerType.accessFlags & CIL_TYPE_BEFORE_FIELD_INIT) !== 0,
    selfInitializing,
  };
}

function resolveCilCalleeIdentity(cilImage, token) {
  const tokenText = cilTokenText(token);
  if (!tokenText) return null;
  const lookups = cilImageLookups(cilImage);
  if (!lookups.hasMethodRows || !lookups.methodTokens.has(tokenText)) return null;
  return { tokenText, methodId: createManagedMethodId(cilImage.moduleId, tokenText) };
}

export function liftCilMethod(bodyIndex, cilImage, options = {}, methodAuthority = null) {
  const methodBody = cilImage.methodBodies[bodyIndex];
  if (!methodBody) fail('cil-invalid-method-body-index');

  // Native-size width authority (#7775): `O`, `&`, `native int`, and
  // `native unsigned int` map to the target processor's native pointer size
  // (ECMA-335 I.12.1.1). A `32BITREQUIRED` image may only be loaded into a
  // 32-bit process (II.25.3.3.1), so its object references are 32-bit; a
  // known 64-bit target keeps 64; any other case keeps the width unstated
  // instead of minting an unsupported 64-bit exact claim.
  const nativePointerBits = cilImage.requires32Bit === true ? 32
    : cilImage.requires64Bit === true ? 64
      : null;

  const methodId = createManagedMethodId(cilImage.moduleId, methodTokenText(bodyIndex, methodAuthority));
  // Enclosing MethodDef identity for initializer self-access discharge (#8048).
  const currentMethodToken = methodTokenText(bodyIndex, methodAuthority);
  const currentMethod = cilImageLookups(cilImage).methodByToken.get(currentMethodToken) ?? null;
  const returnSignature = methodAuthority?.complete ? methodAuthority?.signature : null;
  const returnStackSlots = returnSignature ? (returnSignature.returnValue === null ? 0 : 1) : null;
  const bytecode = methodBody.bytecode;
  const view = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
  // IL stream base for provenance ranges. The parser records the code start
  // separately from the method header; bodies built before that field fall
  // back to the header for compatibility (#5396).
  const codeBase = methodBody.codeOffset ?? methodBody.headerOffset;

  // Operand reads must stay inside the method bytecode. A truncated operand
  // fails closed with a typed error instead of lifting an index-less exact
  // effect or leaking a raw RangeError (#5350).
  const need = (count) => {
    if (pc + count > bytecode.length) fail('cil-truncated-operand');
  };

  let pc = 0;
  let opSeq = 0;
  let currentStackHeight = 0;
  let pushWidthRun = [];
  let pushIntegerRun = [];
  let pushFloatRun = [];
  const bundles = [];
  // ECMA-335 §II.25.1.2: modifier prefixes bind to the following instruction.
  // Keep them pending so their operands cannot become fabricated bundles (#5096).
  const pendingModifiers = [];
  let stoppedOnUnsupported = false;

  // Slot-typing authorities (#5353): arguments come from the enclosing
  // MethodDef signature (resolved by the caller into methodAuthority), locals
  // from the fat header's LocalVarSigTok → StandAloneSig chain.
  const resolveLocal = createCilLocalTypeResolver(cilImage);
  const resolveField = createCilFieldSignatureResolver(cilImage);
  const localSlots = resolveLocal(methodBody);
  const localSlotType = (index) => {
    if (!localSlots.complete) {
      return { complete:false, reason:localSlots.reason };
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= localSlots.locals.length) {
      return { complete:false, reason:'cil-local-index-out-of-frame' };
    }
    return { complete:true, slotType:localSlots.locals[index] };
  };
  const argumentSlotType = (index) => {
    if (!methodAuthority?.complete) {
      return { complete:false, reason:'cil-argument-signature-unresolved' };
    }
    const signature = methodAuthority.signature;
    // ECMA-335 §III.3.19: ldarg.0 addresses `this` on instance methods.
    if (signature.hasThis && index === 0) {
      return { complete:true, slotType:{ stackType:'object-ref' } };
    }
    const parameterIndex = signature.hasThis ? index - 1 : index;
    if (!Number.isSafeInteger(parameterIndex) || parameterIndex < 0
      || parameterIndex >= signature.parameters.length) {
      return { complete:false, reason:'cil-argument-index-out-of-frame' };
    }
    return { complete:true, slotType:signature.parameters[parameterIndex] };
  };

  const exceptionRegions = (methodBody.exceptionClauses || []).map((cl, idx) => ({
    id: createManagedExceptionRegionId(methodId, idx),
    startOffset: cl.tryOffset,
    endOffset: cl.tryOffset + cl.tryLength,
    handlerOffset: cl.handlerOffset,
    handlerLength: cl.handlerLength,
    handlerEndOffset: cl.handlerOffset + cl.handlerLength,
    handlerKind: cl.kind,
    // The trailing union field is the filter-code offset for filter clauses
    // and a class token only for catch clauses (ECMA-335 §II.25.4.6): mapping
    // it blindly to catchToken mislabels IL offsets and loses the filter
    // start (#5356).
    ...(cl.kind === 'filter'
      ? { filterOffset: cl.classTokenOrFilter }
      : cl.kind === 'catch'
        ? { catchToken: cl.classTokenOrFilter }
        : {}),
  }));

  // Handler/filter entries are reached by exception dispatch, never by the
  // linear walk, so the stack shape carried into them is unproven (#4043).
  const dispatchedEntryOffsets = new Set();
  for (const region of exceptionRegions) {
    for (const offset of [region.handlerOffset, region.filterOffset]) {
      if (Number.isSafeInteger(offset)) dispatchedEntryOffsets.add(offset);
    }
  }

  // #8725: admit the operation budget during materialization (as the Wasm
  // lifter does), failing closed before an over-budget bundle graph is built.
  const budget = createVMEffectBudgetTracker(options);

  while (pc < bytecode.length) {
    budget.chargeOperation();
    const opOffset = pc;
    let opcode = bytecode[pc++];
    opSeq++;

    let isPrefixFE = false;
    if (opcode === 0xfe) {
      isPrefixFE = true;
      need(1);
      opcode = (0xfe << 8) | bytecode[pc++];
    }

    const opId = createVMOperationId(methodId, opOffset, opSeq);

    let mnemonic = 'unknown';
    let completeness = 'exact';
    let locationReads = [];
    let locationWrites = [];
    let memoryEffects = [];
    let callEffects = [];
    let controlEffects = [];
    let possibleExceptions = [];
    let producedValues = [];
    let consumedValues = [];
    let unknownEffects = [];
    let compare = null;
    let stackEffectUnmodeled = false;

    if (!isPrefixFE) {
      switch (opcode) {
        case 0x00: // nop
          mnemonic = 'nop';
          break;

        case 0x01: // break
          mnemonic = 'break';
          break;

        // ldarg.0 .. ldarg.3
        case 0x02: case 0x03: case 0x04: case 0x05:
          {
            const argIdx = opcode - 0x02;
            mnemonic = `ldarg.${argIdx}`;
            const slot = argumentSlotType(argIdx);
            locationReads = [typedLocationAccess('argument', argIdx, slot, unknownEffects)];
            if (slot.complete) {
              producedValues = [{ ...slot.slotType }];
            } else {
              producedValues = [{}];
              completeness = 'partial';
            }
            currentStackHeight++;
          }
          break;

        // ldloc.0 .. ldloc.3
        case 0x06: case 0x07: case 0x08: case 0x09:
          {
            const locIdx = opcode - 0x06;
            mnemonic = `ldloc.${locIdx}`;
            const slot = localSlotType(locIdx);
            locationReads = [typedLocationAccess('local', locIdx, slot, unknownEffects)];
            if (slot.complete) {
              producedValues = [{ ...slot.slotType }];
            } else {
              producedValues = [{}];
              completeness = 'partial';
            }
            currentStackHeight++;
          }
          break;

        // stloc.0 .. stloc.3
        case 0x0a: case 0x0b: case 0x0c: case 0x0d:
          {
            const locIdx = opcode - 0x0a;
            mnemonic = `stloc.${locIdx}`;
            const slot = localSlotType(locIdx);
            locationWrites = [typedLocationAccess('local', locIdx, slot, unknownEffects)];
            consumedValues.push({ id: `stack_top` });
            if (!slot.complete) completeness = 'partial';
            currentStackHeight--;
          }
          break;

        case 0x0e: // ldarg.s
          {
            need(1);
            const argIdx = bytecode[pc++];
            mnemonic = 'ldarg.s';
            const slot = argumentSlotType(argIdx);
            locationReads = [typedLocationAccess('argument', argIdx, slot, unknownEffects)];
            if (slot.complete) {
              producedValues = [{ ...slot.slotType }];
            } else {
              producedValues = [{}];
              completeness = 'partial';
            }
            currentStackHeight++;
          }
          break;

        case 0x11: // ldloc.s
          {
            need(1);
            const locIdx = bytecode[pc++];
            mnemonic = 'ldloc.s';
            const slot = localSlotType(locIdx);
            locationReads = [typedLocationAccess('local', locIdx, slot, unknownEffects)];
            if (slot.complete) {
              producedValues = [{ ...slot.slotType }];
            } else {
              producedValues = [{}];
              completeness = 'partial';
            }
            currentStackHeight++;
          }
          break;

        case 0x13: // stloc.s
          {
            need(1);
            const locIdx = bytecode[pc++];
            mnemonic = 'stloc.s';
            const slot = localSlotType(locIdx);
            locationWrites = [typedLocationAccess('local', locIdx, slot, unknownEffects)];
            consumedValues.push({ id: 'top' });
            if (!slot.complete) completeness = 'partial';
            currentStackHeight--;
          }
          break;

        case 0x14: // ldnull
          mnemonic = 'ldnull';
          // `O` is a native-size type (ECMA-335 I.12.1.1): the width follows
          // the image's pointer-size authority, or stays unstated when the
          // target width is unresolved (#7775).
          producedValues.push({ ...(nativePointerBits == null ? {} : { bits: nativePointerBits }), isNull: true });
          currentStackHeight++;
          break;

        // ldc.i4.0 .. ldc.i4.8, ldc.i4.m1
        case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d: case 0x1e:
          {
            const val = opcode === 0x15 ? -1 : opcode - 0x16;
            mnemonic = `ldc.i4.${opcode === 0x15 ? 'm1' : val}`;
            producedValues.push({ bits: 32, constant: val });
            currentStackHeight++;
          }
          break;

        case 0x1f: // ldc.i4.s
          {
            need(1);
            let val = bytecode[pc++];
            if (val >= 128) val -= 256;
            mnemonic = 'ldc.i4.s';
            producedValues.push({ bits: 32, constant: val });
            currentStackHeight++;
          }
          break;

        case 0x20: // ldc.i4
          {
            need(4);
            const val = view.getInt32(pc, true);
            pc += 4;
            mnemonic = 'ldc.i4';
            producedValues.push({ bits: 32, constant: val });
            currentStackHeight++;
          }
          break;

        case 0x21: // ldc.i8
          {
            need(8);
            const val = view.getBigInt64(pc, true);
            pc += 8;
            mnemonic = 'ldc.i8';
            producedValues.push({ bits: 64, constant: val });
            currentStackHeight++;
          }
          break;

        case 0x25: // dup
          mnemonic = 'dup';
          consumedValues.push({ id: 'top' });
          producedValues.push({ id: 'dup1' }, { id: 'dup2' });
          currentStackHeight++;
          break;

        case 0x26: // pop
          mnemonic = 'pop';
          consumedValues.push({ id: 'top' });
          currentStackHeight--;
          break;

        case 0x28: // call
        case 0x6f: // callvirt
        case 0x73: // newobj
          {
            need(4);
            const token = view.getUint32(pc, true);
            pc += 4;
            const kind = opcode === 0x28 ? 'call' : opcode === 0x6f ? 'callvirt' : 'newobj';
            mnemonic = kind;
            const calleeIdentity = kind === 'call' ? resolveCilCalleeIdentity(cilImage, token) : null;
            callEffects.push({
              token,
              ...(calleeIdentity ? { target: calleeIdentity.tokenText, targetMethodId: calleeIdentity.methodId } : {}),
              dispatchKind: kind === 'callvirt' ? 'virtual' : kind === 'newobj' ? 'constructor' : 'direct',
            });
            if (kind === 'newobj') {
              // Constructed-object references are native-size too (#7775).
              producedValues.push({ ...(nativePointerBits == null ? {} : { bits: nativePointerBits }) });
              currentStackHeight++;
            }
          }
          break;

        case 0x2a: // ret
          mnemonic = 'ret';
          if (returnStackSlots === 1) {
            consumedValues.push({ id:'top', ...returnSignature.returnValue });
            currentStackHeight--;
          } else if (returnStackSlots == null) {
            // The enclosing MethodDef signature is the authority for whether
            // ret consumes a value. Without it, an exact operand shape would be
            // fabricated from incidental stack height (#7268).
            completeness = 'partial';
            unknownEffects.push({ category:'stack', reason:'cil-return-signature-unresolved' });
          }
          controlEffects.push({ kind: 'return' });
          break;

        // short branches: br.s (0x2B), brfalse.s (0x2C), brtrue.s (0x2D),
        // beq.s (0x2E), bge.s (0x2F), bgt.s (0x30), ble.s (0x31), blt.s (0x32), bne.un.s (0x33),
        // bge.un.s (0x34), bgt.un.s (0x35), ble.un.s (0x36), blt.un.s (0x37)
        case 0x2b: case 0x2c: case 0x2d: case 0x2e: case 0x2f: case 0x30: case 0x31: case 0x32: case 0x33:
        case 0x34: case 0x35: case 0x36: case 0x37:
          {
            need(1);
            let offset = bytecode[pc++];
            if (offset >= 128) offset -= 256;
            const targetOffset = pc + offset;
            if (opcode === 0x2b) {
              mnemonic = 'br.s';
              controlEffects.push({ kind: 'branch', targetOffset });
            } else if (opcode === 0x2c || opcode === 0x2d) {
              mnemonic = opcode === 0x2c ? 'brfalse.s' : 'brtrue.s';
              consumedValues.push({ id: 'cond' });
              currentStackHeight--;
              // brfalse jumps when the condition is zero/null, so the branch's
              // architectural target is the FALSE edge, not the TRUE edge. Encode
              // the polarity through targetOffset/falseTargetOffset (fallthrough is
              // pc) so the shared bridge emits conditional-true -> fallthrough and
              // conditional-false -> taken, instead of collapsing both onto one
              // conditional-true edge (#8790).
              if (opcode === 0x2c) controlEffects.push({ kind: 'conditional-branch', targetOffset: pc, falseTargetOffset: targetOffset });
              else controlEffects.push({ kind: 'conditional-branch', targetOffset });
            } else {
              const shortNames = {
                0x2e: 'beq.s', 0x2f: 'bge.s', 0x30: 'bgt.s', 0x31: 'ble.s', 0x32: 'blt.s',
                0x33: 'bne.un.s', 0x34: 'bge.un.s', 0x35: 'bgt.un.s', 0x36: 'ble.un.s', 0x37: 'blt.un.s',
              };
              mnemonic = shortNames[opcode] || 'bcond.s';
              consumedValues.push({ id: 'val1' }, { id: 'val2' });
              currentStackHeight -= 2;
              controlEffects.push({ kind: 'conditional-branch', targetOffset });
            }
          }
          break;

        // long branches: br (0x38), brfalse (0x39), brtrue (0x3A),
        // beq (0x3B), bge (0x3C), bgt (0x3D), ble (0x3E), blt (0x3F), bne.un (0x40),
        // bge.un (0x41), bgt.un (0x42), ble.un (0x43), blt.un (0x44)
        case 0x38: case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d: case 0x3e: case 0x3f: case 0x40:
        case 0x41: case 0x42: case 0x43: case 0x44:
          {
            need(4);
            const offset = view.getInt32(pc, true);
            pc += 4;
            const targetOffset = pc + offset;
            if (opcode === 0x38) {
              mnemonic = 'br';
              controlEffects.push({ kind: 'branch', targetOffset });
            } else if (opcode === 0x39 || opcode === 0x3a) {
              mnemonic = opcode === 0x39 ? 'brfalse' : 'brtrue';
              consumedValues.push({ id: 'cond' });
              currentStackHeight--;
              // Same polarity encoding as the short form above (#8790).
              if (opcode === 0x39) controlEffects.push({ kind: 'conditional-branch', targetOffset: pc, falseTargetOffset: targetOffset });
              else controlEffects.push({ kind: 'conditional-branch', targetOffset });
            } else {
              const longNames = {
                0x3b: 'beq', 0x3c: 'bge', 0x3d: 'bgt', 0x3e: 'ble', 0x3f: 'blt',
                0x40: 'bne.un', 0x41: 'bge.un', 0x42: 'bgt.un', 0x43: 'ble.un', 0x44: 'blt.un',
              };
              mnemonic = longNames[opcode] || 'bcond';
              consumedValues.push({ id: 'val1' }, { id: 'val2' });
              currentStackHeight -= 2;
              controlEffects.push({ kind: 'conditional-branch', targetOffset });
            }
          }
          break;

        case 0x45: // switch
          {
            need(4);
            const count = view.getUint32(pc, true);
            pc += 4;
            if (count > Math.floor((bytecode.length - pc) / 4)) fail('cil-truncated-operand');
            const deltas = [];
            for (let index = 0; index < count; index++) {
              deltas.push(view.getInt32(pc, true));
              pc += 4;
            }
            const switchBase = pc;
            mnemonic = 'switch';
            consumedValues.push({ id: 'selector', bits: 32 });
            currentStackHeight--;
            // ECMA-335: when the unsigned selector is >= the target count,
            // control continues at the instruction after the table. Without
            // this edge the default block is unreachable and the CFG/IR
            // silently drops a real execution path (#7239).
            controlEffects.push({ kind: 'switch', targetOffsets:deltas.map((delta) => switchBase + delta), defaultTargetOffset: switchBase });
          }
          break;

        // binops: add (0x58), sub (0x59), mul (0x5A), div (0x5B), rem (0x5D), and (0x5F), or (0x60), xor (0x61), shl (0x62), shr (0x63)
        case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5d: case 0x5f: case 0x60: case 0x61: case 0x62: case 0x63:
          {
            const names = {
              0x58: 'add', 0x59: 'sub', 0x5a: 'mul', 0x5b: 'div', 0x5d: 'rem',
              0x5f: 'and', 0x60: 'or', 0x61: 'xor', 0x62: 'shl', 0x63: 'shr',
            };
            mnemonic = names[opcode] || 'binop';
            const widths = operandWidths(pushWidthRun, 2);
            const lhsBits = widths ? widths[0] : null;
            const rhsBits = widths ? widths[1] : null;
            const isShift = opcode === 0x62 || opcode === 0x63;
            const resultBits = widths
              ? (isShift ? (rhsBits === 32 ? lhsBits : null) : (lhsBits === rhsBits ? lhsBits : null))
              : null;
            if (resultBits == null) {
              consumedValues.push({ id: 'rhs' }, { id: 'lhs' });
              producedValues.push({});
              completeness = 'partial';
              unknownEffects.push({ category: 'stack', reason: 'cil-arithmetic-operand-width-unresolved' });
            } else {
              consumedValues.push({ id: 'rhs', bits: rhsBits }, { id: 'lhs', bits: lhsBits });
              // ECMA-335 §III.1.5/§III.1.8/§III.1.10/§III.1.2: `add`/`sub`/`mul`/`div`
              // operate on the evaluation-stack type. When BOTH top-of-stack operands
              // are proven same-width IEEE-754 floats, the result keeps float
              // authority instead of collapsing to an integer bitvector (#8924).
              const produced = { bits: resultBits };
              const floatCapable = opcode === 0x58 || opcode === 0x59 || opcode === 0x5a || opcode === 0x5b;
              const floatKind = floatCapable ? floatOperandWidths(pushWidthRun, pushFloatRun, 2) : null;
              if (floatKind != null && floatKind[0] === resultBits) produced.type = floatMachineType(resultBits);
              producedValues.push(produced);
            }
            currentStackHeight--;
            // ECMA-335 Partition III: integral `div` throws
            // System.DivideByZeroException (divisor == 0) and
            // System.ArithmeticException (MIN_VALUE / -1); floating-point `div`
            // throws neither. This lifter has no typed operand-stack authority,
            // so the integral-vs-floating distinction that selects the
            // exception contract cannot be resolved losslessly. Publishing the
            // integral predicates would let FP division inherit them; staying
            // exception-free is the #7937 defect. Fail closed instead of
            // minting exception-free exact semantics.
            if (opcode === 0x5b) {
              completeness = 'partial';
              unknownEffects.push({ category: 'control', reason: 'cil-div-exception-authority-unresolved' });
            }
          }
          break;

        // unops: neg (0x65), not (0x66)
        case 0x65: case 0x66:
          {
            mnemonic = opcode === 0x65 ? 'neg' : 'not';
            const widths = operandWidths(pushWidthRun, 1);
            if (widths == null) {
              consumedValues.push({ id: 'val' });
              producedValues.push({});
              completeness = 'partial';
              unknownEffects.push({ category: 'stack', reason: 'cil-arithmetic-operand-width-unresolved' });
            } else {
              consumedValues.push({ id: 'val', bits: widths[0] });
              const produced = { bits: widths[0] };
              // `neg` is defined on the evaluation-stack type; preserve float
              // authority for an `r4`/`r8` operand (#8924). `not` is integer-only.
              if (opcode === 0x65) {
                const floatKind = floatOperandWidths(pushWidthRun, pushFloatRun, 1);
                if (floatKind != null && floatKind[0] === widths[0]) produced.type = floatMachineType(widths[0]);
              }
              producedValues.push(produced);
            }
          }
          break;

        case 0x72: // ldstr
          {
            need(4);
            const token = view.getUint32(pc, true);
            pc += 4;
            mnemonic = 'ldstr';
            // A string reference is an `O` native-size value (#7775). The
            // token's low bits byte-address the #US heap (II.24.2.4); when
            // that literal authority is available it must reach the canonical
            // IR — a token-only projection collapsed distinct literals (#8007).
            const userString = typeof cilImage.userStrings?.get === 'function'
              ? cilImage.userStrings.get(token & 0xffffff) ?? null
              : null;
            producedValues.push({
              ...(nativePointerBits == null ? {} : { bits: nativePointerBits }),
              stringToken: token,
              ...(typeof userString === 'string' ? {
                stringRef: userString,
                // The width authority stays exactly #7775's: the reference is
                // typed only when the native pointer size is proven.
                ...(nativePointerBits == null ? {} : { type: { kind: 'address', widthBits: nativePointerBits, addressSpace: 'managed-heap' } }),
              } : {}),
            });
            currentStackHeight++;
          }
          break;

        case 0x7a: // throw
          mnemonic = 'throw';
          consumedValues.push({ id: 'exception' });
          controlEffects.push({ kind: 'throw' });
          currentStackHeight--;
          break;

        case 0x7b: // ldfld
        case 0x7d: // stfld
          {
            need(4);
            const token = view.getUint32(pc, true);
            pc += 4;
            const isWrite = opcode === 0x7d;
            mnemonic = isWrite ? 'stfld' : 'ldfld';
            // Field value identity comes from the resolved FieldSig, never a
            // fabricated 32-bit claim; unresolved tokens stay inexact (#3971).
            const field = resolveField(token);
            if (isWrite) {
              consumedValues.push({
                id:'val',
                ...(field.complete ? fieldStackValue(field.fieldType) : {}),
              }, { id: 'obj' });
              currentStackHeight -= 2;
            } else {
              consumedValues.push({ id: 'obj' });
              producedValues.push(field.complete ? fieldStackValue(field.fieldType) : {});
            }
            memoryEffects.push({
              space: 'field',
              token,
              isWrite,
              ...fieldEffectKeys(field),
            });
            if (!field.complete) {
              completeness = 'partial';
              unknownEffects.push({ category: 'types', reason: field.reason });
            }
            possibleExceptions.push({ kind: 'null-reference', condition: 'obj==null' });
          }
          break;

        case 0x7e: // ldsfld
        case 0x80: // stsfld
          {
            need(4);
            const token = view.getUint32(pc, true);
            pc += 4;
            const isWrite = opcode === 0x80;
            mnemonic = isWrite ? 'stsfld' : 'ldsfld';
            // Static field values are typed by the resolved FieldSig too; an
            // unresolved token can never publish an exact load/store (#3971).
            const field = resolveField(token);
            if (isWrite) {
              consumedValues.push({
                id:'val',
                ...(field.complete ? fieldStackValue(field.fieldType) : {}),
              });
              currentStackHeight--;
            } else {
              producedValues.push(field.complete ? fieldStackValue(field.fieldType) : {});
              currentStackHeight++;
            }
            // Type-initializer authority rides on the static-field effect
            // (#8048); an access that may trigger a declared `.cctor` is not
            // an unconditional pure load/store and fails closed to partial.
            const initialization = resolveCilStaticFieldInitialization(cilImage, token, currentMethod);
            const typeInitialization = initialization.resolved ? {
              declaringTypeToken: initialization.declaringTypeToken,
              declaringType: initialization.declaringType,
              initializerPresent: initialization.initializerPresent,
              beforeFieldInit: initialization.beforeFieldInit,
              initializationRequired: initialization.initializerPresent && !initialization.selfInitializing,
              initializationProven: false,
              ...(initialization.initializerPresent && initialization.selfInitializing
                ? { discharged: 'declaring-type-initializer' }
                : {}),
              ...(initialization.initializerPresent && !initialization.selfInitializing
                ? { triggerTiming: initialization.beforeFieldInit ? 'allowed-before-access' : 'required-at-access' }
                : {}),
            } : {
              declaringTypeResolved: false,
            };
            memoryEffects.push({
              space: 'static-field',
              token,
              isWrite,
              typeInitialization,
              ...fieldEffectKeys(field),
            });
            if (!field.complete) {
              completeness = 'partial';
              unknownEffects.push({ category: 'types', reason: field.reason });
            }
            if (!initialization.resolved) {
              completeness = 'partial';
              unknownEffects.push({ category: 'calls', reason: initialization.reason });
            } else if (initialization.initializerPresent && !initialization.selfInitializing) {
              completeness = 'partial';
              unknownEffects.push({ category: 'calls', reason: 'cil-type-initialization-unverified' });
            }
          }
          break;

        case 0xdc: // endfinally
          mnemonic = 'endfinally';
          controlEffects.push({ kind: 'endfinally' });
          break;

        case 0xdd: // leave
          {
            need(4);
            const offset = view.getInt32(pc, true);
            pc += 4;
            mnemonic = 'leave';
            controlEffects.push({ kind: 'leave', targetOffset:pc + offset });
            currentStackHeight = 0;
          }
          break;

        case 0xde: // leave.s
          {
            need(1);
            let offset = bytecode[pc++];
            if (offset >= 128) offset -= 256;
            mnemonic = 'leave.s';
            controlEffects.push({ kind: 'leave', targetOffset:pc + offset });
            currentStackHeight = 0;
          }
          break;

        default: {
          const boundary = decodeCilInstructionBoundary(bytecode, opOffset);
          pc = boundary.end;
          mnemonic = `cil_op_0x${opcode.toString(16)}`;
          completeness = 'partial';
          stackEffectUnmodeled = true;
          unknownEffects.push({ category: 'other', reason: `unsupported-cil-opcode-0x${opcode.toString(16)}` });
          if (!boundary.complete) unknownEffects.push({ category:'other', reason:'unsupported-instruction-boundary-unresolved' });
          unknownEffects.push({ category:'other', reason:'semantic-lifting-stopped-after-unsupported-instruction' });
          stoppedOnUnsupported = true;
          break;
        }
      }
    } else {
      // 0xFE prefix opcodes
      const subOp = opcode & 0xff;
      switch (subOp) {
        case 0x01: // ceq
        case 0x02: // cgt
        case 0x04: // clt
          mnemonic = subOp === 0x01 ? 'ceq' : subOp === 0x02 ? 'cgt' : 'clt';
          {
            // The comparison predicate and its signedness are only liftable when
            // the stack top proves two integral operands of one width; without
            // that authority the bundle fails closed to partial instead of
            // publishing a complete compare that carries no canonical operator
            // (#8785). `.un` and float/unordered spellings are not decoded here,
            // so no unsigned authority is ever claimed from these mnemonics.
            const widths = integerOperandWidths(pushWidthRun, pushIntegerRun, 2);
            const operandBits = widths != null && widths[0] === widths[1] ? widths[0] : null;
            if (operandBits != null) {
              compare = subOp === 0x01
                ? { predicate: 'eq', operandBits, arity: 2 }
                : { predicate: subOp === 0x02 ? 'gt' : 'lt', signedness: 'signed', operandBits, arity: 2 };
            } else {
              completeness = 'partial';
              unknownEffects.push({ category: 'types', reason: 'cil-compare-operand-authority-unresolved' });
            }
          }
          consumedValues.push({ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 });
          // III.1.5: the result is an int32 0/1 flag, which is itself integral
          // authority for a chained comparison.
          producedValues.push({ bits: 32, stackType: 'int32' });
          currentStackHeight--;
          break;

        case 0x09: // ldarg
          {
            need(2);
            const argIdx = view.getUint16(pc, true);
            pc += 2;
            mnemonic = 'ldarg';
            const slot = argumentSlotType(argIdx);
            locationReads = [typedLocationAccess('argument', argIdx, slot, unknownEffects)];
            if (slot.complete) {
              producedValues = [{ ...slot.slotType }];
            } else {
              producedValues = [{}];
              completeness = 'partial';
            }
            currentStackHeight++;
          }
          break;

        case 0x0c: // ldloc
          {
            need(2);
            const locIdx = view.getUint16(pc, true);
            pc += 2;
            mnemonic = 'ldloc';
            const slot = localSlotType(locIdx);
            locationReads = [typedLocationAccess('local', locIdx, slot, unknownEffects)];
            if (slot.complete) {
              producedValues = [{ ...slot.slotType }];
            } else {
              producedValues = [{}];
              completeness = 'partial';
            }
            currentStackHeight++;
          }
          break;

        case 0x0e: // stloc
          {
            need(2);
            const locIdx = view.getUint16(pc, true);
            pc += 2;
            mnemonic = 'stloc';
            const slot = localSlotType(locIdx);
            locationWrites = [typedLocationAccess('local', locIdx, slot, unknownEffects)];
            consumedValues.push({ id: 'top' });
            if (!slot.complete) completeness = 'partial';
            currentStackHeight--;
          }
          break;

        case 0x11: // endfilter
          mnemonic = 'endfilter';
          consumedValues.push({ id: 'filter-result', bits: 32 });
          currentStackHeight--;
          controlEffects.push({ kind: 'endfilter' });
          break;

        case 0x1a: // rethrow
          mnemonic = 'rethrow';
          controlEffects.push({ kind: 'rethrow' });
          break;

        case 0x12: // unaligned. <alignment 1|2|4>
          {
            need(1);
            const alignment = bytecode[pc++];
            if (alignment !== 1 && alignment !== 2 && alignment !== 4) {
              fail('cil-invalid-unaligned-alignment');
            }
            pendingModifiers.push({
              kind: 'unaligned', opcode: 0xfe12, mnemonic: 'unaligned.',
              bytecodeOffset: opOffset, alignment,
            });
          }
          continue;

        case 0x13: // volatile.
          pendingModifiers.push({ kind: 'volatile', opcode: 0xfe13, mnemonic: 'volatile.', bytecodeOffset: opOffset });
          continue;

        case 0x14: // tail.
          pendingModifiers.push({ kind: 'tail', opcode: 0xfe14, mnemonic: 'tail.', bytecodeOffset: opOffset });
          continue;

        case 0x16: // constrained. <token:u4>
          {
            need(4);
            const typeToken = view.getUint32(pc, true);
            pc += 4;
            pendingModifiers.push({
              kind: 'constrained', opcode: 0xfe16, mnemonic: 'constrained.',
              bytecodeOffset: opOffset, typeToken,
            });
          }
          continue;

        case 0x1e: // readonly.
          pendingModifiers.push({ kind: 'readonly', opcode: 0xfe1e, mnemonic: 'readonly.', bytecodeOffset: opOffset });
          continue;

        default: {
          const boundary = decodeCilInstructionBoundary(bytecode, opOffset);
          pc = boundary.end;
          mnemonic = `cil_fe_0x${subOp.toString(16)}`;
          completeness = 'partial';
          stackEffectUnmodeled = true;
          unknownEffects.push({ category: 'other', reason: `unsupported-cil-fe-opcode-0x${subOp.toString(16)}` });
          if (!boundary.complete) unknownEffects.push({ category:'other', reason:'unsupported-instruction-boundary-unresolved' });
          unknownEffects.push({ category:'other', reason:'semantic-lifting-stopped-after-unsupported-instruction' });
          stoppedOnUnsupported = true;
          break;
        }
      }
    }

    // A CIL produced value whose source already proves IEEE-754 float authority
    // (`stackType:'float'`+`primitive`, `floating:true`, or an explicit
    // `type.kind:'float'`) must carry that authority as the canonical machine
    // type at the VMEffect→Semantic-IR boundary; otherwise the shared bridge
    // degrades `r4`/`r8` loads and constants to a bare width bitvector and
    // publishes float values as complete integer semantics (#8924). This is a
    // pure projection of the type the frontend already proved — it never
    // strengthens completeness and never invents a width the source lacks.
    for (const value of producedValues) {
      if (value.type == null) {
        const floatWidth = cilFloatStackWidth(value);
        if (floatWidth != null) value.type = floatMachineType(floatWidth);
      }
    }

    if (stackEffectUnmodeled || callEffects.length > 0 || controlEffects.length > 0
      || consumedValues.length > pushWidthRun.length) {
      pushWidthRun = [];
      pushIntegerRun = [];
      pushFloatRun = [];
    } else {
      pushWidthRun.length -= consumedValues.length;
      pushIntegerRun.length -= consumedValues.length;
      pushFloatRun.length -= consumedValues.length;
      for (const value of producedValues) {
        pushWidthRun.push(cilStackValueWidth(value));
        pushIntegerRun.push(cilStackValueIsIntegral(value));
        pushFloatRun.push(cilFloatStackWidth(value));
      }
    }

    const modifiers = pendingModifiers.splice(0, pendingModifiers.length);
    const metadata = {};
    let bundleStart = opOffset;
    if (modifiers.length > 0) {
      bundleStart = modifiers[0].bytecodeOffset;
      completeness = 'partial';
      for (let index = 0; index < modifiers.length; index++) {
        const modifier = modifiers[index];
        const end = index + 1 < modifiers.length ? modifiers[index + 1].bytecodeOffset : opOffset;
        metadata[modifier.kind] = {
          opcode: modifier.opcode,
          mnemonic: modifier.mnemonic,
          bytecodeOffset: modifier.bytecodeOffset,
          provenance: { start: modifier.bytecodeOffset, end },
          ...(modifier.typeToken == null ? {} : { typeToken: modifier.typeToken }),
          ...(modifier.alignment == null ? {} : { alignment: modifier.alignment }),
        };
        unknownEffects.push({
          category: 'other',
          reason: `cil-prefix-modifier-unmodeled:${modifier.kind}`,
          bytecodeOffset: modifier.bytecodeOffset,
        });
      }
      const constrained = [...modifiers].reverse().find((modifier) => modifier.kind === 'constrained');
      const hasTail = modifiers.some((modifier) => modifier.kind === 'tail');
      if (constrained || hasTail) {
        callEffects = callEffects.map((effect, index) => index !== 0 ? effect : ({
          ...effect,
          ...(hasTail ? { tailCall: true } : {}),
          ...(constrained ? { constrainedTypeToken: constrained.typeToken } : {}),
        }));
      }
      const lastOf = (kind) => [...modifiers].reverse().find((modifier) => modifier.kind === kind);
      const volatileModifier = lastOf('volatile');
      const readonlyModifier = lastOf('readonly');
      const unalignedModifier = lastOf('unaligned');
      if (volatileModifier || readonlyModifier || unalignedModifier) {
        memoryEffects = memoryEffects.map((effect, index) => index !== 0 ? effect : ({
          ...effect,
          ...(volatileModifier ? { volatile: true } : {}),
          ...(readonlyModifier ? { readonly: true } : {}),
          ...(unalignedModifier ? { alignment: unalignedModifier.alignment } : {}),
        }));
      }
    }

    const origin = createOriginSet({
      operationIds: [opId],
      byteRanges: [{ start: codeBase + bundleStart, end: codeBase + pc }],
    });

    bundles.push(createVMEffectBundle({
      schemaVersion: 1,
      contractVersion: '1.0.0',
      frontendId: 'cil',
      frontendSemanticVersion: '1.0.0',
      profileId: cilImage.vmSpecEdition,
      methodId,
      operationId: opId,
      bytecodeOffset: opOffset,
      opcode,
      mnemonic,
      consumedValues,
      producedValues,
      locationReads,
      locationWrites,
      memoryEffects,
      callEffects,
      controlEffects,
      possibleExceptions,
      origin,
      completeness,
      unknownEffects,
      metadata,
      compare,
    }, options));
    if (stoppedOnUnsupported) break;
  }

  if (pendingModifiers.length > 0) fail('cil-prefix-without-instruction');

  return createVMEffectFunction({
    methodId,
    profileId: cilImage.vmSpecEdition,
    frontendId: 'cil',
    bundles,
    entryState: {
      maxStack: methodBody.maxStack,
      isTiny: methodBody.isTiny,
      ...(returnStackSlots == null ? {} : { returnStackSlots }),
    },
    exceptionRegions,
  }, options);
}
