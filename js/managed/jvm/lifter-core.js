import { createOriginSet } from '../../core/identity/origin.js';
import { createManagedExceptionRegionId, createManagedMethodId, createVMOperationId } from '../shared/identity.js';
import { createVMEffectBundle, createVMEffectFunction } from '../shared/vm-effects.js';
import { resolveJvmFieldRef } from './field-reference.js';
import { decodeJvmInstructionBoundary } from './instruction-boundary.js';

function fail(code) { throw new TypeError(code); }

function collectJvmInstructionStarts(bytecode) {
  const starts = new Set();
  let offset = 0;
  while (offset < bytecode.length) {
    const boundary = decodeJvmInstructionBoundary(bytecode, offset);
    if (!boundary.complete || boundary.end <= offset) break;
    starts.add(offset);
    offset = boundary.end;
  }
  return starts;
}

function appendJvmBranchEffect(
  controlEffects,
  unknownEffects,
  instructionStarts,
  bytecodeLength,
  kind,
  targetOffset,
) {
  if (
    !Number.isSafeInteger(targetOffset) ||
    targetOffset < 0 ||
    targetOffset >= bytecodeLength ||
    !instructionStarts.has(targetOffset)
  ) {
    unknownEffects.push({
      category: 'other',
      reason: 'invalid-jvm-branch-target',
    });
    return false;
  }
  controlEffects.push({ kind, targetOffset });
  return true;
}

// JVM verification constraint: a local-variable instruction may only name a
// slot inside the Code attribute's local frame. A category-2 value occupies
// two consecutive slots, so its index must leave room for the second half
// (#5394). Publishing an out-of-frame access as `exact` would turn malformed
// bytecode into a fabricated dataflow fact.
function requireLocalAccess(maxLocals, index, slots, unknownEffects) {
  const locals = Number(maxLocals);
  const valid = Number.isSafeInteger(index) && index >= 0
    && Number.isSafeInteger(locals) && locals > 0
    && index + slots <= locals;
  if (!valid) {
    // The location access itself is withheld; the verifier maps this finding
    // onto jvm-local-index-out-of-range (branch-target precedent, #3899).
    unknownEffects.push({
      category: 'other',
      reason: `jvm-local-index-out-of-frame:${index}:${slots}`,
    });
    return false;
  }
  return true;
}

// JVMS §6.5 ldc/ldc_w/ldc2_w: the indexed runtime constant pool entry is the
// pushed value's authority. The entry tag is the value's type (§4.4):
// ldc/ldc_w accept Integer/Float/Class/String/MethodHandle/MethodType;
// ldc2_w accepts only Long/Double. Resolving the entry into the produced
// value keeps compiler-generated constants lossless in the final Semantic IR
// instead of input-less complete unary nodes with the value and type dropped
// (#8004). A reference kind (Class/String/MethodHandle/MethodType) is kept
// distinct from a primitive constant; a CONSTANT_Dynamic's actual value is
// bootstrap-computed and therefore not statically resolvable, and any entry
// that cannot be resolved losslessly fails closed (partial), never exact.
function resolveJvmLdcConstant(jvmClass, cpIndex, isCategory2) {
  const pool = jvmClass.constantPool;
  if (!Array.isArray(pool) || !Number.isInteger(cpIndex) || cpIndex <= 0 || cpIndex >= pool.length) return null;
  const entry = pool[cpIndex];
  if (!entry || typeof entry.tag !== 'number') return null;
  const utf8 = (idx) => {
    if (!Number.isInteger(idx) || idx <= 0 || idx >= pool.length) return null;
    const item = pool[idx];
    return item && item.tag === 1 && typeof item.value === 'string' ? item.value : null;
  };
  const className = (idx) => {
    if (!Number.isInteger(idx) || idx <= 0 || idx >= pool.length) return null;
    const item = pool[idx];
    return item && item.tag === 7 ? utf8(item.nameIndex) : null;
  };
  const primitive = (extra) => ({ constant: entry.value, ...extra });
  // jsonSafe drops non-finite numbers; NaN/±Infinity float constants are
  // exact knowledge, so they keep their canonical string form instead.
  const floatPrimitive = (extra) => ({
    constant: Number.isFinite(entry.value) ? entry.value : String(entry.value),
    ...extra,
  });
  switch (entry.tag) {
    case 3: // Integer
      return isCategory2 ? null : primitive({});
    case 4: // Float
      return isCategory2 ? null : floatPrimitive({
        type: { kind: 'float', widthBits: 32, format: 'binary32' },
      });
    case 5: // Long
      return isCategory2 ? primitive({}) : null;
    case 6: // Double
      return isCategory2 ? floatPrimitive({
        type: { kind: 'float', widthBits: 64, format: 'binary64' },
      }) : null;
    case 7: { // Class
      if (isCategory2) return null;
      const name = utf8(entry.nameIndex);
      if (name == null) return null;
      return { stackType: 'reference', valueType: 'class', constant: name };
    }
    case 8: { // String
      if (isCategory2) return null;
      const value = utf8(entry.stringIndex);
      if (value == null) return null;
      return { stackType: 'reference', valueType: 'string', constant: value };
    }
    case 15: { // MethodHandle
      if (isCategory2) return null;
      if (!Number.isInteger(entry.referenceKind) || entry.referenceKind < 1 || entry.referenceKind > 9) return null;
      if (!Number.isInteger(entry.referenceIndex) || entry.referenceIndex <= 0 || entry.referenceIndex >= pool.length) return null;
      const ref = pool[entry.referenceIndex];
      if (!ref || (ref.tag !== 9 && ref.tag !== 10 && ref.tag !== 11)) return null;
      const owner = className(ref.classIndex);
      const nameAndType = pool[ref.nameAndTypeIndex];
      if (owner == null || !nameAndType || nameAndType.tag !== 12) return null;
      const name = utf8(nameAndType.nameIndex);
      const descriptor = utf8(nameAndType.descriptorIndex);
      if (name == null || descriptor == null) return null;
      return {
        stackType: 'reference',
        valueType: 'method-handle',
        referenceKind: entry.referenceKind,
        constant: `${owner}.${name}:${descriptor}`,
      };
    }
    case 16: { // MethodType
      if (isCategory2) return null;
      const descriptor = utf8(entry.descriptorIndex);
      if (descriptor == null) return null;
      return { stackType: 'reference', valueType: 'method-type', constant: descriptor };
    }
    default: // CONSTANT_Dynamic and non-loadable tags are not losslessly resolvable here
      return null;
  }
}

export function liftJvmMethod(methodIdx, jvmClass, options = {}) {
  const method = jvmClass.methods[methodIdx];
  if (!method) fail('jvm-invalid-method-index');
  const methodId = createManagedMethodId(jvmClass.moduleId, methodIdx, method.name);
  const isNative = (method.accessFlags & 0x0100) !== 0; // ACC_NATIVE

  if (isNative || !method.code) {
    const bundle = createVMEffectBundle({
      frontendId: 'jvm',
      methodId,
      operationId: createVMOperationId(methodId, 0),
      bytecodeOffset: 0,
      opcode: 0,
      mnemonic: isNative ? 'jni_native_method' : 'abstract_method',
      callEffects: isNative ? [{
        target: `${jvmClass.thisClassName}.${method.name}${method.descriptor}`,
        dispatchKind: 'jni-native',
        unresolved: true,
      }] : [],
      controlEffects: [{ kind: 'return' }],
      completeness: 'exact',
    });
    return createVMEffectFunction({
      methodId,
      profileId: jvmClass.vmSpecEdition,
      frontendId: 'jvm',
      bundles: [bundle],
      aggregateCompleteness: 'exact',
    });
  }

  const codeAttr = method.code;
  const bytecode = codeAttr.bytecode;
  const view = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
  const codeOffset = Number(codeAttr.offset ?? 0);
  const instructionStarts = collectJvmInstructionStarts(bytecode);

  let pc = 0;
  let opSeq = 0;
  let currentStackHeight = 0;
  const bundles = [];

  const exceptionRegions = (codeAttr.exceptionTable || []).map((exc, idx) => ({
    id: createManagedExceptionRegionId(methodId, idx),
    startOffset: exc.startPc,
    endOffset: exc.endPc,
    handlerOffset: exc.handlerPc,
    catchType: exc.catchType,
  }));

  while (pc < bytecode.length) {
    const opOffset = pc;
    const opcode = bytecode[pc++];
    opSeq++;

    const opId = createVMOperationId(methodId, opOffset, opSeq);

    let mnemonic = 'unknown';
    let completeness = 'exact';
    let locationReads = [];
    let locationWrites = [];
    let memoryEffects = [];
    let callEffects = [];
    let controlEffects = [];
    let producedValues = [];
    let consumedValues = [];
    let unknownEffects = [];

    switch (opcode) {
      case 0x00: // nop
        mnemonic = 'nop';
        break;

      case 0x01: // aconst_null
        mnemonic = 'aconst_null';
        producedValues.push({ bits: 64, isNull: true });
        currentStackHeight++;
        break;

      // iconst_m1 (-1), iconst_0 .. iconst_5
      case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08:
        {
          const val = opcode === 0x02 ? -1 : opcode - 0x03;
          mnemonic = `iconst_${opcode === 0x02 ? 'm1' : val}`;
          producedValues.push({ bits: 32, constant: val });
          currentStackHeight++;
        }
        break;

      // lconst_0, lconst_1 (category 2)
      case 0x09: case 0x0a:
        {
          const val = opcode === 0x09 ? 0n : 1n;
          mnemonic = `lconst_${val}`;
          producedValues.push({ bits: 64, constant: val, category: 2 });
          currentStackHeight += 2;
        }
        break;

      case 0x10: // bipush
        {
          let val = bytecode[pc++];
          if (val >= 128) val -= 256;
          mnemonic = 'bipush';
          producedValues.push({ bits: 32, constant: val });
          currentStackHeight++;
        }
        break;

      case 0x11: // sipush
        {
          const val = view.getInt16(pc, false);
          pc += 2;
          mnemonic = 'sipush';
          producedValues.push({ bits: 32, constant: val });
          currentStackHeight++;
        }
        break;

      case 0x12: // ldc
      case 0x13: // ldc_w
      case 0x14: // ldc2_w
        {
          const cpIdx = opcode === 0x12 ? bytecode[pc++] : view.getUint16(pc, false);
          if (opcode !== 0x12) pc += 2;
          const isCategory2 = opcode === 0x14;
          mnemonic = opcode === 0x12 ? 'ldc' : opcode === 0x13 ? 'ldc_w' : 'ldc2_w';
          const resolved = resolveJvmLdcConstant(jvmClass, cpIdx, isCategory2);
          if (resolved) {
            producedValues.push({
              bits: isCategory2 ? 64 : 32,
              cpIndex: cpIdx,
              category: isCategory2 ? 2 : 1,
              ...resolved,
            });
            currentStackHeight += isCategory2 ? 2 : 1;
          } else {
            // The runtime constant pool entry is the value's authority; an
            // entry that cannot be resolved losslessly (out-of-range index,
            // reserved slot, tag/opcode mismatch, broken nested reference) is
            // invalid bytecode — the fabricated stack value is withheld and
            // the bundle fails closed instead of publishing an exact
            // constant that dropped its value (#8004, branch-target
            // precedent #3899).
            completeness = 'partial';
            unknownEffects.push({
              category: 'other',
              reason: `jvm-ldc-constant-unresolved:${cpIdx}`,
            });
          }
        }
        break;

      // iload, lload, fload, dload, aload
      case 0x15: case 0x16: case 0x17: case 0x18: case 0x19:
        {
          const locIdx = bytecode[pc++];
          const isCategory2 = opcode === 0x16 || opcode === 0x18;
          const names = { 0x15: 'iload', 0x16: 'lload', 0x17: 'fload', 0x18: 'dload', 0x19: 'aload' };
          mnemonic = names[opcode];
          if (!requireLocalAccess(codeAttr.maxLocals, locIdx, isCategory2 ? 2 : 1, unknownEffects)) completeness = 'partial';
          else {
            locationReads.push({ kind: 'local', index: locIdx, bits: isCategory2 ? 64 : 32 });
            producedValues.push({ bits: isCategory2 ? 64 : 32 });
            currentStackHeight += isCategory2 ? 2 : 1;
          }
        }
        break;

      // iload_0 .. aload_3
      case 0x1a: case 0x1b: case 0x1c: case 0x1d: // iload_0..3
      case 0x1e: case 0x1f: case 0x20: case 0x21: // lload_0..3 (cat 2)
      case 0x22: case 0x23: case 0x24: case 0x25: // fload_0..3
      case 0x26: case 0x27: case 0x28: case 0x29: // dload_0..3 (cat 2)
      case 0x2a: case 0x2b: case 0x2c: case 0x2d: // aload_0..3
        {
          const base = opcode < 0x1e ? 0x1a : opcode < 0x22 ? 0x1e : opcode < 0x26 ? 0x22 : opcode < 0x2a ? 0x26 : 0x2a;
          const prefix = opcode < 0x1e ? 'iload' : opcode < 0x22 ? 'lload' : opcode < 0x26 ? 'fload' : opcode < 0x2a ? 'dload' : 'aload';
          const locIdx = opcode - base;
          const isCategory2 = prefix === 'lload' || prefix === 'dload';
          mnemonic = `${prefix}_${locIdx}`;
          if (!requireLocalAccess(codeAttr.maxLocals, locIdx, isCategory2 ? 2 : 1, unknownEffects)) completeness = 'partial';
          else {
            locationReads.push({ kind: 'local', index: locIdx, bits: isCategory2 ? 64 : 32 });
            producedValues.push({ bits: isCategory2 ? 64 : 32 });
            currentStackHeight += isCategory2 ? 2 : 1;
          }
        }
        break;

      // istore, lstore, fstore, dstore, astore
      case 0x36: case 0x37: case 0x38: case 0x39: case 0x3a:
        {
          const locIdx = bytecode[pc++];
          const isCategory2 = opcode === 0x37 || opcode === 0x39;
          const names = { 0x36: 'istore', 0x37: 'lstore', 0x38: 'fstore', 0x39: 'dstore', 0x3a: 'astore' };
          mnemonic = names[opcode];
          if (!requireLocalAccess(codeAttr.maxLocals, locIdx, isCategory2 ? 2 : 1, unknownEffects)) completeness = 'partial';
          else {
            locationWrites.push({ kind: 'local', index: locIdx, bits: isCategory2 ? 64 : 32 });
            consumedValues.push({ id: 'top' });
            currentStackHeight -= isCategory2 ? 2 : 1;
          }
        }
        break;

      // istore_0 .. astore_3
      case 0x3b: case 0x3c: case 0x3d: case 0x3e: // istore_0..3
      case 0x3f: case 0x40: case 0x41: case 0x42: // lstore_0..3 (cat 2)
      case 0x43: case 0x44: case 0x45: case 0x46: // fstore_0..3
      case 0x47: case 0x48: case 0x49: case 0x4a: // dstore_0..3 (cat 2)
      case 0x4b: case 0x4c: case 0x4d: case 0x4e: // astore_0..3
        {
          const base = opcode < 0x3f ? 0x3b : opcode < 0x43 ? 0x3f : opcode < 0x47 ? 0x43 : opcode < 0x4b ? 0x47 : 0x4b;
          const prefix = opcode < 0x3f ? 'istore' : opcode < 0x43 ? 'lstore' : opcode < 0x47 ? 'fstore' : opcode < 0x4b ? 'dstore' : 'astore';
          const locIdx = opcode - base;
          const isCategory2 = prefix === 'lstore' || prefix === 'dstore';
          mnemonic = `${prefix}_${locIdx}`;
          if (!requireLocalAccess(codeAttr.maxLocals, locIdx, isCategory2 ? 2 : 1, unknownEffects)) completeness = 'partial';
          else {
            locationWrites.push({ kind: 'local', index: locIdx, bits: isCategory2 ? 64 : 32 });
            consumedValues.push({ id: 'top' });
            currentStackHeight -= isCategory2 ? 2 : 1;
          }
        }
        break;

      case 0x57: // pop
      case 0x58: // pop2
        mnemonic = opcode === 0x57 ? 'pop' : 'pop2';
        consumedValues.push({ id: 'top' });
        currentStackHeight -= opcode === 0x57 ? 1 : 2;
        break;

      case 0x59: // dup
        mnemonic = 'dup';
        consumedValues.push({ id: 'top' });
        producedValues.push({ id: 'dup1' }, { id: 'dup2' });
        currentStackHeight++;
        break;

      // iadd (0x60), isub (0x64), imul (0x68), idiv (0x6C), irem (0x70), iand (0x7E), ior (0x80), ixor (0x82), ishl (0x78), ishr (0x7A), iushr (0x7C)
      case 0x60: case 0x64: case 0x68: case 0x6c: case 0x70: case 0x78: case 0x7a: case 0x7c: case 0x7e: case 0x80: case 0x82:
        {
          const names = {
            0x60: 'iadd', 0x64: 'isub', 0x68: 'imul', 0x6c: 'idiv', 0x70: 'irem',
            0x78: 'ishl', 0x7a: 'ishr', 0x7c: 'iushr', 0x7e: 'iand', 0x80: 'ior', 0x82: 'ixor',
          };
          mnemonic = names[opcode] || 'ibinop';
          consumedValues.push({ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 });
          producedValues.push({ bits: 32 });
          currentStackHeight--;
        }
        break;

      case 0x84: // iinc index, const
        {
          const locIdx = bytecode[pc++];
          let imm = bytecode[pc++];
          if (imm >= 128) imm -= 256;
          mnemonic = 'iinc';
          if (!requireLocalAccess(codeAttr.maxLocals, locIdx, 1, unknownEffects)) completeness = 'partial';
          else {
            locationReads.push({ kind: 'local', index: locIdx, bits: 32 });
            locationWrites.push({ kind: 'local', index: locIdx, bits: 32 });
            producedValues.push({ bits: 32, constant: imm });
          }
        }
        break;

      // ifeq (0x99), ifne (0x9A), iflt (0x9B), ifge (0x9C), ifgt (0x9D), ifle (0x9E)
      case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e:
        {
          const offset = view.getInt16(pc, false);
          pc += 2;
          const names = { 0x99: 'ifeq', 0x9a: 'ifne', 0x9b: 'iflt', 0x9c: 'ifge', 0x9d: 'ifgt', 0x9e: 'ifle' };
          mnemonic = names[opcode];
          consumedValues.push({ id: 'val', bits: 32 });
          currentStackHeight--;
          if (!appendJvmBranchEffect(
            controlEffects,
            unknownEffects,
            instructionStarts,
            bytecode.length,
            'conditional-branch',
            opOffset + offset,
          )) completeness = 'partial';
        }
        break;

      // if_icmpeq (0x9F) .. if_icmple (0xA4)
      case 0x9f: case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4:
        {
          const offset = view.getInt16(pc, false);
          pc += 2;
          const names = {
            0x9f: 'if_icmpeq', 0xa0: 'if_icmpne', 0xa1: 'if_icmplt',
            0xa2: 'if_icmpge', 0xa3: 'if_icmpgt', 0xa4: 'if_icmple',
          };
          mnemonic = names[opcode];
          consumedValues.push({ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 });
          currentStackHeight -= 2;
          if (!appendJvmBranchEffect(
            controlEffects,
            unknownEffects,
            instructionStarts,
            bytecode.length,
            'conditional-branch',
            opOffset + offset,
          )) completeness = 'partial';
        }
        break;

      case 0xa7: // goto
        {
          const offset = view.getInt16(pc, false);
          pc += 2;
          mnemonic = 'goto';
          if (!appendJvmBranchEffect(
            controlEffects,
            unknownEffects,
            instructionStarts,
            bytecode.length,
            'branch',
            opOffset + offset,
          )) completeness = 'partial';
        }
        break;

      // ireturn (0xAC) .. return (0xB1)
      case 0xac: case 0xad: case 0xae: case 0xaf: case 0xb0: case 0xb1:
        mnemonic = opcode === 0xb1 ? 'return' : 'return_val';
        if (opcode !== 0xb1) {
          consumedValues.push({ id: 'ret_val' });
        }
        controlEffects.push({ kind: 'return' });
        break;

      case 0xb2: // getstatic
      case 0xb3: // putstatic
      case 0xb4: // getfield
      case 0xb5: // putfield
        {
          const fieldIdx = view.getUint16(pc, false);
          pc += 2;
          const isWrite = opcode === 0xb3 || opcode === 0xb5;
          const isStatic = opcode === 0xb2 || opcode === 0xb3;
          const field = resolveJvmFieldRef(jvmClass, fieldIdx, { resolveDeclaredFlags: true });
          mnemonic = opcode === 0xb2 ? 'getstatic' : opcode === 0xb3 ? 'putstatic' : opcode === 0xb4 ? 'getfield' : 'putfield';

          const receiver = { id: 'obj', bits: 64, category: 1, valueKind: 'reference' };
          if (!field) {
            completeness = 'partial';
            if (isWrite) consumedValues.push({ id: 'val', typeUnknown: true });
            else producedValues.push({ id: 'field-value', typeUnknown: true });
            if (!isStatic) consumedValues.push(receiver);
            unknownEffects.push(
              { category: 'types', reason: 'unresolved-jvm-field-reference' },
              { category: 'stack', reason: 'unresolved-jvm-field-width' },
              { category: 'memory', reason: 'unresolved-jvm-field-reference' },
            );
            break;
          }

          const value = {
            bits: field.bits,
            category: field.category,
            valueKind: field.valueKind,
            descriptor: field.descriptor,
          };
          if (isWrite) {
            consumedValues.push({ id: 'val', ...value });
            if (!isStatic) consumedValues.push(receiver);
            currentStackHeight -= field.slots + (isStatic ? 0 : 1);
          } else {
            if (!isStatic) consumedValues.push(receiver);
            producedValues.push(value);
            currentStackHeight += field.slots - (isStatic ? 0 : 1);
          }
          memoryEffects.push({
            space: isStatic ? 'static-field' : 'field',
            cpIndex: fieldIdx,
            owner: field.owner,
            name: field.name,
            descriptor: field.descriptor,
            valueKind: field.valueKind,
            valueBits: field.bits,
            valueCategory: field.category,
            isWrite,
            // Canonical field location identity: downstream semantic memory
            // reasoning needs same-field write→read and distinct-field
            // non-alias facts, which the receiver-derived address alone
            // cannot express (#7861 review).
            kind: isStatic ? 'static' : 'instance',
            fieldIdentity: { owner: field.owner, name: field.name, descriptor: field.descriptor },
            // JLS §17.4.5: a resolved volatile access carries synchronizes-with
            // authority; an unresolved owner must not be silently treated as
            // plain (fail-closed partial, #7861).
            ...(field.isVolatile ? { isVolatile: true, ordering: 'synchronizes-with' } : {}),
          });
          if (field.declaredAccessFlags == null) {
            // The owner is not the current class (or the declared field is
            // ambiguous): the volatility authority is unresolvable here, so
            // the access cannot be published as an exact plain access.
            completeness = 'partial';
            unknownEffects.push({ category: 'memory', reason: 'jvm-field-volatility-unresolvable' });
          }
        }
        break;

      // invokevirtual (0xB6), invokespecial (0xB7), invokestatic (0xB8), invokeinterface (0xB9)
      case 0xb6: case 0xb7: case 0xb8: case 0xb9:
        {
          const methIdx = view.getUint16(pc, false);
          pc += 2;
          if (opcode === 0xb9) pc += 2; // skip count, 0
          const kinds = { 0xb6: 'virtual', 0xb7: 'special', 0xb8: 'static', 0xb9: 'interface' };
          mnemonic = `invoke${kinds[opcode]}`;
          callEffects.push({
            cpIndex: methIdx,
            dispatchKind: kinds[opcode],
          });
        }
        break;

      case 0xbb: // new
        {
          const classIdx = view.getUint16(pc, false);
          pc += 2;
          mnemonic = 'new';
          producedValues.push({ bits: 64, cpClassIndex: classIdx });
          currentStackHeight++;
        }
        break;

      case 0xbf: // athrow
        mnemonic = 'athrow';
        consumedValues.push({ id: 'exception' });
        controlEffects.push({ kind: 'throw' });
        currentStackHeight--;
        break;

      case 0xc0: // checkcast
      case 0xc1: // instanceof
        {
          const classIdx = view.getUint16(pc, false);
          pc += 2;
          mnemonic = opcode === 0xc0 ? 'checkcast' : 'instanceof';
          // JVM stack semantics (#5243): both opcodes pop the objectref.
          // instanceof pushes the int result; checkcast pushes the same
          // reference back (refined in place), so the def-use edge to the
          // objectref is preserved instead of vanishing. ClassCastException
          // is real control-affecting behaviour the bundle does not model as
          // control flow, so checkcast fails closed to partial.
          consumedValues.push({ id: 'obj' });
          if (opcode === 0xc1) {
            producedValues.push({ bits: 32, cpClassIndex: classIdx });
          } else {
            producedValues.push({ id: 'obj-refined', bits: 64, cpClassIndex: classIdx });
            completeness = 'partial';
            unknownEffects.push({ category: 'other', reason: 'jvm-checkcast-exception-unrepresented' });
          }
        }
        break;

      case 0xc2: // monitorenter
      case 0xc3: // monitorexit
        mnemonic = opcode === 0xc2 ? 'monitorenter' : 'monitorexit';
        consumedValues.push({ id: 'obj' });
        currentStackHeight--;
        break;

      default:
        {
          const boundary = decodeJvmInstructionBoundary(bytecode, opOffset);
          pc = Math.max(pc, boundary.end);
          mnemonic = `jvm_op_0x${opcode.toString(16)}`;
          completeness = 'partial';
          unknownEffects.push({
            category: 'other',
            reason: boundary.complete
              ? `unsupported-jvm-opcode-0x${opcode.toString(16)}`
              : `unsupported-jvm-opcode-0x${opcode.toString(16)}-malformed-boundary`,
          });
        }
        break;
    }

    const origin = createOriginSet({
      operationIds: [opId],
      byteRanges: [{ start: codeOffset + opOffset, end: codeOffset + pc }],
    });

    bundles.push(createVMEffectBundle({
      schemaVersion: 1,
      contractVersion: '1.0.0',
      frontendId: 'jvm',
      frontendSemanticVersion: '1.0.0',
      profileId: jvmClass.vmSpecEdition,
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
      possibleExceptions: [],
      origin,
      completeness,
      unknownEffects,
    }, options));
  }

  return createVMEffectFunction({
    methodId,
    profileId: jvmClass.vmSpecEdition,
    frontendId: 'jvm',
    bundles,
    entryState: {
      maxStack: codeAttr.maxStack,
      maxLocals: codeAttr.maxLocals,
    },
    exceptionRegions,
  }, options);
}
