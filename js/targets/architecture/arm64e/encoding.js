import { createMachineEffectBundle } from '../../../semantics/effects/index.js';

const ARITY = Object.freeze(Object.fromEntries([
  ...['pacia','pacib','pacda','pacdb','autia','autib','autda','autdb','braa','brab','blraa','blrab'].map((mnemonic) => [mnemonic, 2]),
  ...['paciza','pacizb','pacdza','pacdzb','autiza','autizb','autdza','autdzb','xpaci','xpacd','braaz','brabz','blraaz','blrabz'].map((mnemonic) => [mnemonic, 1]),
  ...['paciasp','pacibsp','pacia1716','pacib1716','autiasp','autibsp','autia1716','autib1716','xpaclri','retaa','retab'].map((mnemonic) => [mnemonic, 0]),
  ['pacga', 3],
]));

const CONTROL = new Set(['braa','brab','braaz','brabz','blraa','blrab','blraaz','blrabz','retaa','retab']);

function mnemonicOf(decoded) {
  return String(decoded?.mnemonic ?? decoded?.opcode ?? '').trim().toLowerCase();
}

function operandList(decoded) {
  if (Array.isArray(decoded?.operands) && decoded.operands.length > 0) return decoded.operands;
  if (Array.isArray(decoded?.ops)) return decoded.ops;
  if (Array.isArray(decoded?.operands)) return decoded.operands;
  const text = decoded?.operands ?? decoded?.opStr ?? decoded?.op_str ?? decoded?.operandString ?? decoded?.args;
  return String(text || '').split(',').map((part) => part.trim()).filter(Boolean);
}

export function arm64ePointerAuthenticationOperandArities() {
  return ARITY;
}

export function arm64ePointerAuthenticationOperandShapeFailure(decoded) {
  const mnemonic = mnemonicOf(decoded);
  if (!Object.hasOwn(ARITY, mnemonic)) return null;
  const expected = ARITY[mnemonic];
  const actual = operandList(decoded).length;
  if (actual === expected) return null;
  return Object.freeze({
    reason:`arm64e-${mnemonic}-operand-shape-invalid`,
    mnemonic,
    expectedOperandCount:expected,
    actualOperandCount:actual,
    control:CONTROL.has(mnemonic),
  });
}

export function arm64ePointerAuthenticationOperandShapeFailureBundle(decoded, context = {}) {
  const failure = arm64ePointerAuthenticationOperandShapeFailure(decoded);
  if (!failure) return null;
  const instructionId = String(context?.instructionId ?? decoded?.instructionId ?? '').trim();
  if (!instructionId) throw new TypeError('arm64e-instruction-id-required');
  const origin = context?.origin ?? decoded?.origin ?? { instructionIds:[instructionId] };
  const categories = failure.control ? ['control','registers'] : ['registers'];
  return createMachineEffectBundle({
    instructionId,
    architectureId:'arm64e',
    mode:String(context?.mode ?? decoded?.mode ?? 'arm64e').trim() || 'arm64e',
    operations:[],
    controlEffect:failure.control ? { kind:'unknown', reason:failure.reason } : { kind:'fallthrough' },
    possibleFaults:[],
    origin,
    completeness:'partial',
    unknownEffects:{
      categories,
      reason:failure.reason,
      detail:{
        mnemonic:failure.mnemonic,
        expectedOperandCount:failure.expectedOperandCount,
        actualOperandCount:failure.actualOperandCount,
      },
    },
    metadata:{
      semanticVersion:'2',
      family:'arm64e-pointer-authentication',
      mnemonic:failure.mnemonic,
      failClosed:true,
      encodingValidation:'operand-arity',
    },
  }, context?.machineEffectsOptions ?? context?.options ?? {});
}
