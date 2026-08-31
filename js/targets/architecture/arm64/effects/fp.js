export {
  ARM64_FP_EFFECT_MNEMONICS,
  decodeArm64FpImmediate,
  arm64FpImmediateBitPattern,
} from './fp-core.js';
import { liftArm64FpEffects as liftArm64FpEffectsCore } from './fp-core.js';

const FP_ENV_INTRINSICS = new Set([
  'fadd','fsub','fmul','fdiv','fsqrt','fmadd','fmsub','fnmadd','fnmsub',
  'fmax','fmin','fmaxnm','fminnm','frecpe','frecps','frsqrte','frsqrts',
  'fcvt','scvtf','ucvtf',
  'fcvtas','fcvtau','fcvtms','fcvtmu','fcvtns','fcvtnu','fcvtps','fcvtpu','fcvtzs','fcvtzu',
  'frinta','frintm','frintn','frintp','frintx','frinti','frintz',
]);
const FP_TERNARY = new Set(['fmadd','fmsub','fnmadd','fnmsub']);
const FP_BINARY = new Set(['fadd','fsub','fmul','fdiv','fmax','fmin','fmaxnm','fminnm','frecps','frsqrts']);
const FP_FINITE_SHAPE = new Set([
  ...FP_ENV_INTRINSICS,
  'fmov','fabs','fneg','fcsel','fcmp','fcmpe','fccmp','fccmpe',
]);

function operandsOf(instruction) {
  if (Array.isArray(instruction?.ops)) return instruction.ops;
  if (Array.isArray(instruction?.parsed)) return instruction.parsed;
  if (Array.isArray(instruction?.operandsParsed)) return instruction.operandsParsed;
  return [];
}

function invalidStructuredRegisterWidth(op) {
  return op?.k === 'reg'
    && (typeof op.bits !== 'number' || !Number.isSafeInteger(op.bits) || op.bits <= 0);
}

function invalidStructuredFpImmediate(op) {
  return op?.k === 'imm' && op.float != null
    && (typeof op.float !== 'number' || !Number.isFinite(op.float));
}

function invalidFiniteShape(mnemonic, ops) {
  if (!FP_FINITE_SHAPE.has(mnemonic)) return false;
  if (ops.some((op) => op?.shift != null || op?.extend != null)) return true;
  if (ops.some(invalidStructuredRegisterWidth)) return true;
  if (ops.some(invalidStructuredFpImmediate)) return true;
  if (ops.some((op) => op?.k === 'reg' && (!Number.isInteger(op.num) || op.num < 0 || op.num >= 32))) return true;
  if (ops.some((op) => op?.k === 'reg' && op.cls === 'zr' && op.num !== 31)) return true;
  if (['fmov','fabs','fneg'].includes(mnemonic)) return ops.length !== 2;
  if (mnemonic === 'fcsel') return ops.length !== 4;
  if (['fcmp','fcmpe'].includes(mnemonic)) return ops.length !== 2;
  if (['fccmp','fccmpe'].includes(mnemonic)) return ops.length !== 4;
  if (!FP_ENV_INTRINSICS.has(mnemonic)) return false;
  const expectedSources = FP_TERNARY.has(mnemonic) ? 3 : FP_BINARY.has(mnemonic) ? 2 : 1;
  const ordinary = ops.length === expectedSources + 1
    && ops.slice(1).every((op) => op?.k === 'reg' || op?.k === 'imm');
  const fixedPoint = ['scvtf','ucvtf','fcvtzs','fcvtzu'].includes(mnemonic)
    && ops.length === 3 && ops[1]?.k === 'reg' && ops[2]?.k === 'imm';
  return !ordinary && !fixedPoint;
}

export function liftArm64FpEffects(instruction, context = {}) {
  const mnemonic = String(instruction?.mnemonic || '').trim().toLowerCase();
  const ops = operandsOf(instruction);
  if (invalidFiniteShape(mnemonic, ops)) {
    return liftArm64FpEffectsCore({ ...instruction, ops: [] }, context);
  }
  return liftArm64FpEffectsCore(instruction, context);
}

export const arm64FpMachineEffects = liftArm64FpEffects;