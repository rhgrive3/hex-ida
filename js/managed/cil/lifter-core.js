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
// have different ordering semantics, so integral operand authority may only
// come from a push that states it: the int32/int64 evaluation-stack categories, or an
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

function cilFieldStorageByteWidth(fieldType, nativePointerBits) {
  const primitiveWidths = {
    boolean:1, i1:1, u1:1, char:2, i2:2, u2:2,
    i4:4, u4:4, r4:4, i8:8, u8:8, r8:8,
  };
  const primitive = fieldType?.primitive;
  if (Object.hasOwn(primitiveWidths, primitive)) return primitiveWidths[primitive];
  if ((primitive === 'i' || primitive === 'u') && (nativePointerBits === 32 || nativePointerBits === 64)) {
    return nativePointerBits / 8;
  }
  return null;
}

function fieldEffectKeys(resolution, nativePointerBits) {
  if (!resolution.complete) return { fieldResolved:false };
  const byteWidth = cilFieldStorageByteWidth(resolution.fieldType, nativePointerBits);
  return {
    fieldName:resolution.fieldName,
    ...(resolution.declaringType ? { declaringType:resolution.declaringType } : {}),
    fieldType:resolution.fieldType,
    fieldProvenance:resolution.provenance,
    ...(byteWidth == null ? {} : { byteWidth }),
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