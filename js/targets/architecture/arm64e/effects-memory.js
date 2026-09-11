import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createRegisterValue,
} from '../../../semantics/effects/index.js';
import {
  Arm64AddressingError,
  arm64ConstantExpr,
  arm64RegisterOperand,
  arm64Temporary,
  arm64TemporaryExpr,
  buildArm64EffectiveAddress,
  createArm64RegisterWrite,
} from '../arm64/effects/addressing.js';
import { ARM64E_PAUTH_KEYS } from './effects.js';

export const ARM64E_EFFECTS_MEMORY_SEMANTIC_VERSION = '1';

const POINTER_BITS = 64;
const KEY_BITS = 128;
const PAUTH_STATE_BITS = 64;
const PAUTH_STATE_ID = 'PAuthState';
const SIGNED_IMM9_MIN = -256n;
const SIGNED_IMM9_MAX = 255n;

// FEAT_PAuth authenticated loads: LDRAA/LDRAB authenticate the base register
// with a zero modifier (Key A / Key B), add a signed unscaled imm9 offset,
// load a 64-bit doubleword, and write the base back only in the pre-index
// form. They are ARM64e extension-owned memory semantics, not PAC encodings,
// so they stay outside the PAC encoding registry on purpose.
const AUTHENTICATED_LOADS = Object.freeze({
  ldraa: { key: 'ia', keyId: 'APIAKey' },
  ldrab: { key: 'ib', keyId: 'APIBKey' },
});

export const ARM64E_AUTHENTICATED_LOAD_MNEMONICS = Object.freeze(Object.keys(AUTHENTICATED_LOADS));

function mnemonicOf(decoded) {
  const raw = typeof decoded?.mnemonic === 'string' ? decoded.mnemonic : typeof decoded?.opcode === 'string' ? decoded.opcode : null;
  return raw ? raw.trim().toLowerCase() : '';
}

function operandList(decoded) {
  if (Array.isArray(decoded?.operands) && decoded.operands.length > 0) return decoded.operands;
  if (Array.isArray(decoded?.ops)) return decoded.ops;
  if (Array.isArray(decoded?.operands)) return decoded.operands;
  const text = decoded?.operands ?? decoded?.opStr ?? decoded?.op_str ?? decoded?.operandString ?? decoded?.args;
  return String(text || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function pointerDestinationRegister(operand) {
  const register = arm64RegisterOperand(operand);
  if (!register) return null;
  if (register.zero) return register.bits === POINTER_BITS ? register : null;
  if (register.kind !== 'gp' || register.bits !== POINTER_BITS) return null;
  return register;
}

// Raw Capstone rows carry only `opStr`; recover the structured memory operand
// (base / signed unscaled displacement / pre-index marker) from it. Only the
// two LDRAA/LDRAB encodable shapes are recognized; anything else stays
// unstructured and fails closed downstream.
const MEMORY_TEXT = /^\[\s*(x(?:[0-9]|[12][0-9]|30))\s*(?:,\s*#(-?(?:0x[0-9a-f]+|\d+)))?\s*\]\s*(!?)$/i;
const DESTINATION_TEXT = /^(?:xzr|(x(?:[0-9]|[12][0-9]|30)))$/i;

function structuredOperandList(decoded) {
  if (Array.isArray(decoded?.ops) || Array.isArray(decoded?.operands)) return operandList(decoded);
  let parts = [];
  if (typeof decoded?.opStr === 'string') {
    // Bracket-aware split: LDRA operand text contains a comma inside the
    // memory operand, so the naive presentation split cannot be reused.
    let depth = 0;
    let current = '';
    for (const character of decoded.opStr) {
      if (character === '[') depth += 1;
      else if (character === ']') depth -= 1;
      if (character === ',' && depth === 0) { parts.push(current); current = ''; continue; }
      current += character;
    }
    parts.push(current);
    parts = parts.map((part) => part.trim()).filter(Boolean);
  } else {
    parts = operandList(decoded);
  }
  const [destinationText, memoryText] = parts;
  if (typeof destinationText !== 'string' || typeof memoryText !== 'string') return parts;
  const destinationMatch = DESTINATION_TEXT.exec(destinationText.trim());
  const memoryMatch = MEMORY_TEXT.exec(memoryText.trim());
  if (!destinationMatch || !memoryMatch) return list;
  const destination = {
    k: 'reg',
    text: destinationText.trim(),
    cls: destinationMatch[1] ? 'gp' : 'zr',
    bits: POINTER_BITS,
    num: destinationMatch[1] ? Number(destinationMatch[1].slice(1)) : 31,
  };
  const baseNumber = Number(memoryMatch[1].slice(1));
  const displacement = memoryMatch[2] == null ? null : BigInt(memoryMatch[2]);
  const preIndex = memoryMatch[3] === '!';
  const memory = {
    k: 'mem',
    text: memoryText.trim(),
    base: { k: 'reg', text: memoryMatch[1], cls: 'gp', bits: POINTER_BITS, num: baseNumber },
    index: null,
    disp: displacement == null ? null : { k: 'imm', text: `#${memoryMatch[2]}`, value: displacement },
    addressDisp: displacement,
    writebackDisp: preIndex ? displacement : null,
    shift: null,
    mode: preIndex ? 'pre' : 'offset',
  };
  return [destination, memory];
}

function memoryOperandOf(decoded) {
  const list = structuredOperandList(decoded);
  return list.find((operand) => operand?.k === 'mem' || operand?.kind === 'memory') || null;
}

function displacementValue(mem) {
  const raw = mem?.addressDisp ?? mem?.disp ?? mem?.offset;
  if (raw == null) return 0n;
  const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^-?(?:0x[0-9a-f]+|\d+)$/i.test(text)) return BigInt(text);
  }
  return null;
}

function instructionIdOf(decoded, context) {
  const instructionId = String(context?.instructionId ?? decoded?.instructionId ?? '').trim();
  if (!instructionId) throw new TypeError('arm64e-instruction-id-required');
  return instructionId;
}

function originOf(decoded, context, instructionId) {
  const origin = context?.origin ?? decoded?.origin;
  if (origin != null) return origin;
  return { instructionIds: [instructionId] };
}

function modeOf(decoded, context) {
  return String(context?.mode ?? decoded?.mode ?? 'arm64e').trim() || 'arm64e';
}

function partialMissing(decoded, context, instructionId, reason) {
  const categories = ['memory', 'registers', 'faults'];
  return createMachineEffectBundle({
    instructionId,
    architectureId: 'arm64e',
    mode: modeOf(decoded, context),
    operations: [createMachineOperation({ kind: 'unknown', reason, categories })],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [{ kind: 'pointer-authentication-fault', condition: { kind: 'unresolved-arm64e-state' } }],
    origin: originOf(decoded, context, instructionId),
    completeness: 'partial',
    unknownEffects: { categories, reason, detail: { mnemonic: mnemonicOf(decoded) } },
    metadata: {
      semanticVersion: ARM64E_EFFECTS_MEMORY_SEMANTIC_VERSION,
      family: 'arm64e-pointer-authentication',
      mnemonic: mnemonicOf(decoded),
      authenticatedLoad: true,
      unresolved: true,
      failClosed: true,
    },
  }, context?.machineEffectsOptions);
}

function authenticatedLoadFault(mnemonic, keyId) {
  return {
    kind: 'pointer-authentication-fault',
    condition: {
      kind: 'pointer-authentication-failed',
      keyIdentity: keyId,
      architectureStateInput: PAUTH_STATE_ID,
      use: 'data-address',
    },
    detail: {
      mnemonic,
      behavior: 'authenticated data address is not a valid data pointer',
    },
  };
}

function dataAbortFault(mnemonic, accessIndex) {
  return {
    kind: 'data-abort',
    condition: { kind: 'memory-access-fault', access: 'read', accessIndex },
    detail: {
      causes: ['address-size', 'translation', 'access-flag', 'permission', 'external'],
      tagChecked: true,
      mnemonic,
    },
  };
}

function keyStateReads(operations, keyCode, instructionId) {
  const keyId = ARM64E_PAUTH_KEYS[keyCode];
  const keyValue = arm64Temporary(`${instructionId}.key`, KEY_BITS);
  operations.push(createMachineOperation({
    kind: 'register-read',
    register: createRegisterValue(keyId, KEY_BITS),
    value: keyValue,
    metadata: { implicit: true, stateKind: 'pointer-authentication-key', keyIdentity: keyId },
  }));
  const architectureState = arm64Temporary(`${instructionId}.pauth-state`, PAUTH_STATE_BITS);
  operations.push(createMachineOperation({
    kind: 'register-read',
    register: createRegisterValue(PAUTH_STATE_ID, PAUTH_STATE_BITS),
    value: architectureState,
    metadata: { implicit: true, stateKind: 'pointer-authentication-architecture-state' },
  }));
  return { keyId, keyValue, architectureState };
}

export function isArm64eAuthenticatedLoadInstruction(decoded) {
  return Object.hasOwn(AUTHENTICATED_LOADS, mnemonicOf(decoded));
}

export function liftArm64eAuthenticatedLoadEffects(decoded, context = {}) {
  const mnemonic = mnemonicOf(decoded);
  const descriptor = AUTHENTICATED_LOADS[mnemonic];
  if (!descriptor) return null;
  const instructionId = instructionIdOf(decoded, context);

  const operands = structuredOperandList(decoded);
  if (operands.length !== 2) return partialMissing(decoded, context, instructionId, 'authenticated load operand shape is invalid');
  const destination = pointerDestinationRegister(operands[0]);
  if (!destination) return partialMissing(decoded, context, instructionId, 'authenticated load destination register is invalid');
  const mem = operands[1];
  if (!mem || !(mem?.k === 'mem' || mem?.kind === 'memory')) return partialMissing(decoded, context, instructionId, 'authenticated load memory operand is invalid');
  if (String(mem.mode || mem.addressingMode || 'offset').toLowerCase() === 'post') {
    return partialMissing(decoded, context, instructionId, 'authenticated load post-index addressing is not encodable');
  }
  if (mem.index != null || mem.indexRegister != null || mem.shift != null || mem.extend != null) {
    return partialMissing(decoded, context, instructionId, 'authenticated load register offset addressing is not encodable');
  }
  const displacement = displacementValue(mem);
  if (displacement == null || displacement < SIGNED_IMM9_MIN || displacement > SIGNED_IMM9_MAX) {
    return partialMissing(decoded, context, instructionId, 'authenticated load displacement is outside the signed imm9 encoding');
  }

  let addressing;
  try {
    addressing = buildArm64EffectiveAddress({ mnemonic, ops: operands }, { prefix: `${instructionId}.addr`, accessWidthBits: POINTER_BITS });
  } catch (error) {
    if (error instanceof Arm64AddressingError) return partialMissing(decoded, context, instructionId, error.code);
    throw error;
  }
  const base = addressing.base;
  if (base.kind === 'sp') return partialMissing(decoded, context, instructionId, 'authenticated load base register SP is not encodable');

  const operations = [...addressing.readOperations];
  const baseValue = addressing.readOperations[0]?.value;
  if (!baseValue) return partialMissing(decoded, context, instructionId, 'authenticated load base register value is unavailable');
  const { keyId, keyValue, architectureState } = keyStateReads(operations, descriptor.key, instructionId);

  const authenticated = arm64Temporary(`${instructionId}.authenticated`, POINTER_BITS);
  operations.push(createMachineOperation({
    kind: 'intrinsic',
    intrinsicId: 'arm64e.pointer.authenticate',
    effectSummary: createIntrinsicEffectSummary({
      inputs: [baseValue, createBitVectorValue(POINTER_BITS, 0n), keyValue, architectureState],
      outputs: [authenticated],
      registersRead: [base.physicalId, keyId, PAUTH_STATE_ID],
      registersWritten: [],
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      controlEffects: [],
      determinism: 'input-dependent',
      symbolicDetail: 'summary-only',
    }),
    metadata: {
      transform: 'authenticate',
      use: 'data-address',
      keyIdentity: keyId,
      modifier: { kind: 'constant-zero' },
      pointerRegister: base.physicalId,
      architectureStateInput: PAUTH_STATE_ID,
      cryptographicAlgorithm: 'not-modelled',
    },
  }));

  const addressValue = arm64Temporary(`${instructionId}.address`, POINTER_BITS);
  operations.push(createMachineOperation({
    kind: 'value',
    opcode: 'add',
    inputs: [authenticated, createBitVectorValue(POINTER_BITS, BigInt.asUintN(POINTER_BITS, displacement))],
    outputs: [addressValue],
    metadata: { architecture: 'arm64', purpose: 'authenticated-load-address', mode: addressing.mode },
  }));
  const addressExpr = arm64TemporaryExpr(`${instructionId}.address`, POINTER_BITS);

  const access = createMemoryAccess({
    space: 'memory',
    addressExpr,
    widthBits: POINTER_BITS,
    endian: String(context?.dataEndianness ?? decoded?.dataEndianness ?? context?.endian ?? decoded?.endian ?? 'little'),
  }, context?.machineEffectsOptions ?? context?.options ?? {});
  const raw = arm64Temporary(`${instructionId}.load.raw`, POINTER_BITS);
  operations.push(createMachineOperation({
    kind: 'memory-read',
    access,
    value: raw,
    metadata: {
      architecture: 'arm64',
      mnemonic,
      authenticatedLoad: true,
      keyIdentity: keyId,
      addressing: addressing.metadata,
      accessIndex: 0,
    },
  }));

  if (!destination.zero) {
    operations.push(createMachineOperation({
      kind: 'register-write',
      register: createRegisterValue(destination.physicalId, POINTER_BITS),
      value: raw,
      metadata: { authenticatedLoad: true, keyIdentity: keyId },
    }));
  }

  // Pre-index writeback stores the authenticated data address itself; the
  // generic addressing helpers model an unauthenticated writeback, so the
  // authenticated one is emitted here instead of reusing theirs.
  if (addressing.mode !== 'offset') {
    operations.push(createArm64RegisterWrite(base, addressValue, {
      physicalWidth: POINTER_BITS,
      metadata: { purpose: 'authenticated-load-writeback', mode: addressing.mode, keyIdentity: keyId },
    }));
  }

  return createMachineEffectBundle({
    instructionId,
    architectureId: 'arm64e',
    mode: modeOf(decoded, context),
    operations,
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [authenticatedLoadFault(mnemonic, keyId), dataAbortFault(mnemonic, 0)],
    origin: originOf(decoded, context, instructionId),
    completeness: 'exact-with-intrinsic',
    metadata: {
      semanticVersion: ARM64E_EFFECTS_MEMORY_SEMANTIC_VERSION,
      family: 'arm64e-pointer-authentication',
      mnemonic,
      authenticatedLoad: true,
      keyIdentity: keyId,
      destinationRegister: destination.zero ? null : destination.physicalId,
      writeback: addressing.mode !== 'offset' ? { mode: addressing.mode, baseRegister: base.physicalId } : null,
      architectureStateInput: PAUTH_STATE_ID,
    },
  }, context?.machineEffectsOptions);
}
