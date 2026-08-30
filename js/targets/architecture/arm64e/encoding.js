import { createMachineEffectBundle } from '../../../semantics/effects/index.js';

const ARITY = Object.freeze(Object.fromEntries([
  ...['pacia','pacib','pacda','pacdb','autia','autib','autda','autdb','braa','brab','blraa','blrab'].map((mnemonic) => [mnemonic, 2]),
  ...['paciza','pacizb','pacdza','pacdzb','autiza','autizb','autdza','autdzb','xpaci','xpacd','braaz','brabz','blraaz','blrabz'].map((mnemonic) => [mnemonic, 1]),
  ...['paciasp','pacibsp','pacia1716','pacib1716','autiasp','autibsp','autia1716','autib1716','xpaclri','retaa','retab','eretaa','eretab'].map((mnemonic) => [mnemonic, 0]),
  ['pacga', 3],
]));

const CONTROL = new Set(['braa','brab','braaz','brabz','blraa','blrab','blraaz','blrabz','retaa','retab','eretaa','eretab']);
const POINTER_TRANSFORM_TWO = new Set(['pacia','pacib','pacda','pacdb','autia','autib','autda','autdb']);
const POINTER_TRANSFORM_ONE = new Set(['paciza','pacizb','pacdza','pacdzb','autiza','autizb','autdza','autdzb','xpaci','xpacd']);
const AUTHENTICATED_BRANCH_TWO = new Set(['braa','brab','blraa','blrab']);
const AUTHENTICATED_BRANCH_ONE = new Set(['braaz','brabz','blraaz','blrabz']);

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

function normalizeRegisterIdentity(raw) {
  if (raw == null || (typeof raw !== 'string' && typeof raw !== 'number')) return null;
  let text = String(raw).trim().toLowerCase().replace(/^%/, '');
  if (text === 'lr') text = 'x30';
  if (text === 'fp') text = 'x29';
  if (text === 'sp' || text === 'xzr') return text;
  if (/^x(?:[0-9]|[12][0-9]|30)$/.test(text)) return text;
  return null;
}

function structuredRegisterIdentity(operand) {
  if (operand?.k !== 'reg') return null;
  if (operand.cls === 'sp') return operand.num == null || operand.num === 31 ? 'sp' : null;
  if (operand.cls === 'zr') return operand.num == null || operand.num === 31 ? 'xzr' : null;
  if (operand.cls === 'gp' && Number.isInteger(operand.num) && operand.num >= 0 && operand.num <= 30) return `x${operand.num}`;
  return null;
}

function selectedPresentationRegisterIdentity(operand) {
  if (!operand || typeof operand !== 'object' || Array.isArray(operand)) return { present:false, identity:null };
  const raw = operand.registerId
    ?? operand.register
    ?? operand.reg
    ?? operand.name
    ?? operand.text
    ?? operand.value?.registerId
    ?? operand.value?.reg;
  return { present:raw != null, identity:normalizeRegisterIdentity(raw) };
}

function registerClassOf(operand) {
  if (operand == null) return null;
  if (operand && typeof operand === 'object' && !Array.isArray(operand)) {
    if (operand.shift != null || operand.extend != null) return null;
    const explicitWidth = operand.bits
      ?? operand.widthBits
      ?? operand.value?.bits
      ?? operand.value?.widthBits;
    if (explicitWidth != null && Number(explicitWidth) !== 64) return null;
    if (operand.k === 'reg') {
      const structuredIdentity = structuredRegisterIdentity(operand);
      if (structuredIdentity == null) return null;
      const presented = selectedPresentationRegisterIdentity(operand);
      if (presented.present && presented.identity !== structuredIdentity) return null;
      if (operand.cls === 'sp') return 'sp';
      if (operand.cls === 'zr') return 'zr';
      return 'x';
    }
  }

  const raw = typeof operand === 'string'
    ? operand
    : operand.registerId ?? operand.register ?? operand.reg ?? operand.name ?? operand.text ?? operand.value?.registerId ?? operand.value?.reg;
  const identity = normalizeRegisterIdentity(raw);
  if (identity === 'sp') return 'sp';
  if (identity === 'xzr') return 'zr';
  if (identity != null) return 'x';
  return null;
}

function expectedRegisterClasses(mnemonic) {
  if (POINTER_TRANSFORM_TWO.has(mnemonic)) return ['x-or-zr','x-or-sp'];
  if (POINTER_TRANSFORM_ONE.has(mnemonic)) return ['x-or-zr'];
  if (AUTHENTICATED_BRANCH_TWO.has(mnemonic)) return ['x-or-zr','x-or-sp'];
  if (AUTHENTICATED_BRANCH_ONE.has(mnemonic)) return ['x-or-zr'];
  if (mnemonic === 'pacga') return ['x-or-zr','x-or-zr','x-or-sp'];
  return [];
}

function registerClassFailure(mnemonic, operands) {
  const expectedClasses = expectedRegisterClasses(mnemonic);
  for (let index = 0; index < expectedClasses.length; index++) {
    const actualClass = registerClassOf(operands[index]);
    const expectedClass = expectedClasses[index];
    const valid = expectedClass === 'x-or-sp'
      ? actualClass === 'x' || actualClass === 'sp'
      : actualClass === 'x' || actualClass === 'zr';
    if (!valid) {
      return Object.freeze({
        reason:`arm64e-${mnemonic}-operand-register-class-invalid`,
        mnemonic,
        operandIndex:index,
        expectedRegisterClass:expectedClass,
        actualRegisterClass:actualClass,
        control:CONTROL.has(mnemonic),
      });
    }
  }
  return null;
}

export function arm64ePointerAuthenticationOperandArities() {
  return ARITY;
}

export function arm64ePointerAuthenticationOperandShapeFailure(decoded) {
  const mnemonic = mnemonicOf(decoded);
  if (!Object.hasOwn(ARITY, mnemonic)) return null;
  const operands = operandList(decoded);
  const expected = ARITY[mnemonic];
  const actual = operands.length;
  if (actual !== expected) {
    return Object.freeze({
      reason:`arm64e-${mnemonic}-operand-shape-invalid`,
      mnemonic,
      expectedOperandCount:expected,
      actualOperandCount:actual,
      control:CONTROL.has(mnemonic),
    });
  }
  return registerClassFailure(mnemonic, operands);
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
        ...(failure.expectedOperandCount == null ? {} : {
          expectedOperandCount:failure.expectedOperandCount,
          actualOperandCount:failure.actualOperandCount,
        }),
        ...(failure.operandIndex == null ? {} : {
          operandIndex:failure.operandIndex,
          expectedRegisterClass:failure.expectedRegisterClass,
          actualRegisterClass:failure.actualRegisterClass,
        }),
      },
    },
    metadata:{
      semanticVersion:'2',
      family:'arm64e-pointer-authentication',
      mnemonic:failure.mnemonic,
      failClosed:true,
      encodingValidation:failure.operandIndex == null ? 'operand-arity' : 'operand-register-class',
    },
  }, context?.machineEffectsOptions ?? context?.options ?? {});
}
