import { createMemoryAccess } from '../../../../semantics/effects/index.js';
import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import {
  FP_EVEX_BASES, SIMD_EVEX_BASES, FP_EVEX_PP, SIMD_EVEX_PP, FP_MXCSR_BASES, FP_COMPARE_BASES, EVEX_MOVE_BASES,
  baseFamily, registerName, vectorIndex, isVectorOperand, isMaskOperand, evexInfo, memoryAddress,
  trustedCapstoneInstruction, physicalIds,
} from './extended-state-helpers.js';

// Finite frozen long-64 EVEX identities proven against trusted structured Capstone detail.
// Synthetic/untrusted family spellings remain fail-closed via trustedCapstoneInstruction().
const PROVEN_GENERIC_EVEX_FAMILIES = new Set([
  'v4fmaddps',
  'v4fmaddss',
  'v4fnmaddps',
  'v4fnmaddss',
  'valignd',
  'vblendmpd',
  'vblendmps',
  'vbroadcastf32x4',
  'vbroadcastf32x8',
  'vbroadcastf64x4',
  'vbroadcasti32x4',
  'vbroadcasti32x8',
  'vgatherpf0dpd',
  'vgatherpf0dps',
  'vgatherpf0qpd',
  'vgatherpf0qps',
  'vgatherpf1dpd',
  'vgatherpf1dps',
  'vgatherpf1qpd',
  'vgatherpf1qps',
  'vp4dpwssds',
  'vp4dpwssd',
  'vpblendmb',
  'vpblendmd',
  'vpblendmq',
  'vpblendmw',
  'vpshufbitqmb',
  'vptestmb',
  'vptestmd',
  'vptestmq',
  'vptestmw',
  'vptestnmb',
  'vptestnmd',
  'vptestnmq',
  'vptestnmw',
  'vscatterpf0dpd',
  'vscatterpf0dps',
  'vscatterpf0qpd',
  'vscatterpf0qps',
  'vscatterpf1dpd',
  'vscatterpf1dps',
  'vscatterpf1qpd',
  'vscatterpf1qps'
]);

export function classifyEvexCategory(name) {
  const lower = name.toLowerCase();
  const base = baseFamily(lower);
  if (SIMD_EVEX_BASES.has(base)) return 'simd';
  if (FP_EVEX_BASES.has(base)) return 'fp';
  if (/^vp(?!er[\w]*p[sd])/.test(lower) || /^valign|^vbroadcasti|^vextracti|^vinserti|^vshufi|^vcompress[bwdq]|^vexpand[bwdq]/.test(lower) || /^k[a-z]/.test(lower)) {
    return 'simd';
  }
  return 'fp';
}

function inferredEvexAccess(operand, index, { compare, isPrefetch, family, base, info }) {
  if (isPrefetch) return Object.freeze({ read: true, write: false, inferred: true });
  if (/^vu?comi/.test(family)) return Object.freeze({ read: true, write: false, inferred: true });
  if (index === 0 && (/2m$/.test(family) || /qmb$/.test(family) || /^vp(?:testm|cmp)/.test(family))) {
    return Object.freeze({ read: false, write: true, inferred: true });
  }
  const access = String(operand?.access || 'unknown');
  if (access !== 'unknown') {
    const write = access === 'write' || access === 'read-write';
    const mergeRead = index === 0 && write && Boolean(info.maskRegister && !info.zeroing) && !compare;
    return Object.freeze({ read: access === 'read' || access === 'read-write' || mergeRead, write, inferred: false });
  }
  if (operand?.type === 'register') {
    if (compare && index > 0) return Object.freeze({ read: true, write: false, inferred: true });
    if (compare && index === 0) return Object.freeze({ read: false, write: true, inferred: true });
    if (isMaskOperand(operand) && index > 0) return Object.freeze({ read: true, write: false, inferred: true });
    if (index === 0) return Object.freeze({ read: Boolean(info.maskRegister && !info.zeroing), write: true, inferred: true });
    return Object.freeze({ read: true, write: false, inferred: true });
  }
  if (operand?.type === 'memory') {
    if (index === 0) return Object.freeze({ read: false, write: true, inferred: true });
    if (index > 0) return Object.freeze({ read: true, write: false, inferred: true });
  }
  return Object.freeze({ read: false, write: false, inferred: false });
}

function activeVectorWidth(operands) {
  const widths = operands.filter(isVectorOperand).map((operand) => Number(operand.widthBits || 0)).filter((width) => [128, 256, 512].includes(width));
  return widths.length ? Math.max(...widths) : null;
}

function maskedMemoryFaults(direction, widthBits, maskRegister) {
  return x86MemoryFaults(direction, widthBits).map((fault) => Object.freeze({
    ...fault,
    condition: maskRegister ? { kind: 'x86-evex-active-mask-memory-access', maskRegister, memoryFault: fault.condition } : fault.condition,
    detail: Object.freeze({ ...fault.detail, ...(maskRegister ? { faultSuppression: 'inactive-mask-elements-do-not-access-memory' } : {}) })
  }));
}

function evexMemoryAccess(ctx, operand) {
  const address = memoryAddress(ctx, operand);
  if (!address) return null;
  return Object.freeze({ access: createMemoryAccess({ space: address.space, addressExpr: address.expression, widthBits: Number(operand.widthBits), endian: 'little' }), address });
}

function evexRoundingMode(code) { return ['rn', 'rd', 'ru', 'rz'][code] ?? null; }

function evexVectorWrite(ctx, operand, value) {
  const index = vectorIndex(operand);
  const full = index == null ? null : x86RegisterOperand(`zmm${index}`);
  return full ? ctx.writeRegister(full, value) : false;
}

export function liftEvex(instruction, context, family) {
  const info = evexInfo(instruction);
  if (!info || !family.startsWith('v')) return null;
  const category = classifyEvexCategory(family);
  const base = baseFamily(family);
  const isPrefetch = /gatherpf|scatterpf/.test(family);
  const compare = /^v(?:p?cmp|ptest|fpclass|u?comi)/.test(family);

  // A synthetic/unqualified `v*` spelling is not evidence that this generic
  // EVEX owner applies. Keep the finite dedicated EVEX families available to
  // their existing provenance-negative tests, but require the Capstone
  // identity proof before claiming every broader family (for example
  // `vpmulld`). Canonical decoder rows carry that proof and remain owned.
  const knownDedicatedFamily = FP_EVEX_BASES.has(base) || SIMD_EVEX_BASES.has(base);
  const trusted = trustedCapstoneInstruction(instruction, family);
  if (!trusted && !knownDedicatedFamily) return null;

  if (!trusted) {
    const ctx = createX86EffectContext(instruction, context);
    return ctx.partial('x86-evex-trusted-decoder-provenance-required', ['registers', 'memory', 'other'], { metadata: { family: category, operation: family, evexPhysicalStateModeled: true } });
  }

  const ctx = createX86EffectContext(instruction, context);
  if (!PROVEN_GENERIC_EVEX_FAMILIES.has(family)) {
    return ctx.partial('x86-evex-family-requires-dedicated-semantics', ['memory', 'registers', 'flags', 'other'], {
      metadata:{ family:category, operation:family, exactArchitecturalSummary:false, requiresDedicatedOperandRoles:true },
    });
  }
  const operands = ctx.operands;
  const hasMemory = operands.some((operand) => operand?.type === 'memory');
  const activeWidth = activeVectorWidth(operands);
  const isFp = category === 'fp';
  const embeddedRoundingOrSae = isFp && info.broadcastOrRounding && !hasMemory;

  const inputs = [], registersRead = [], registerTargets = [], memoryReads = [], memoryWrites = [];
  let faults = [];

  for (let index = 0; index < operands.length; index += 1) {
    const operand = operands[index];
    const role = inferredEvexAccess(operand, index, { compare, isPrefetch, family, base, info });
    if (operand?.type === 'register') {
      if (role.read) {
        const value = ctx.readRegister(operand);
        if (!value) return ctx.partial('x86-evex-register-read-unmodelled', ['registers'], { metadata: { family: category, operation: family, operandIndex: index } });
        inputs.push(value);
        registersRead.push(...physicalIds(operand.register));
      }
      if (role.write) registerTargets.push({ operand, index });
    } else if (operand?.type === 'immediate') {
      inputs.push(ctx.constant(Number(operand.widthBits || operand.encodedWidthBits || 8), operand.value));
    } else if (operand?.type === 'memory') {
      const modeled = evexMemoryAccess(ctx, operand);
      if (!modeled) return ctx.partial('x86-evex-memory-address-unmodelled', ['memory', 'registers'], { metadata: { family: category, operation: family, operandIndex: index } });
      const width = Number(operand.widthBits || 0);
      if (!width) return ctx.partial('x86-evex-memory-width-unmodelled', ['memory'], { metadata: { family: category, operation: family, operandIndex: index } });
      if (role.read && !isPrefetch) { memoryReads.push(modeled.access); faults.push(...maskedMemoryFaults('read', width, info.maskRegister)); }
      if (role.write) { memoryWrites.push(modeled.access); faults.push(...maskedMemoryFaults('write', width, info.maskRegister)); }
      for (const register of [operand.memory?.base, operand.memory?.index]) registersRead.push(...physicalIds(register));
    }
  }

  for (const register of ctx.instruction.detail?.implicitReads || []) {
    const operand = x86RegisterOperand(register.id);
    const value = operand ? ctx.readRegister(operand) : null;
    if (value) { inputs.push(value); registersRead.push(...physicalIds(operand.register)); }
  }

  const resultWidth = activeWidth || 64;
  const value = ctx.intrinsic(`x86.evex.${family}`,
    inputs.length ? inputs : [ctx.constant(8, 0)],
    { kind: 'int', bits: resultWidth, signed: false },
    {
      sideEffects:'none', mayTrap:false,
      stateScope:{ registers:[...new Set(registersRead)], memory:[] },
      metadata:{ operation:family, exactArchitecturalSummary:true, ...(info.maskRegister ? { maskRegister:info.maskRegister, zeroing:info.zeroing } : {}), ...(embeddedRoundingOrSae ? { roundingMode:evexRoundingMode(info.lengthOrRoundingCode), sae:true } : {}) }
    });

  const writes = [];
  for (const target of registerTargets) {
    const wrote = evexVectorWrite(ctx, target.operand, value);
    if (!wrote) return ctx.partial('x86-evex-register-write-unmodelled', ['registers'], { metadata: { family: category, operation: family, operandIndex: target.index } });
    writes.push(...physicalIds(target.operand.register));
  }

  if (info.maskRegister) {
    const mask = x86RegisterOperand(info.maskRegister);
    const maskValue = mask ? ctx.readRegister(mask) : null;
    if (maskValue) { inputs.push(maskValue); registersRead.push(...physicalIds(mask.register)); }
  }

  return ctx.finish({
    completeness:'exact-with-intrinsic',
    metadata:{
      family:category, operation:family, evexPhysicalStateModeled:true,
      maxVectorLengthBits:512, maskRegister:info.maskRegister, zeroing:info.zeroing,
      embeddedRoundingOrSae, ...(embeddedRoundingOrSae ? { roundingMode:evexRoundingMode(info.lengthOrRoundingCode), sae:true } : {}),
      registersRead:[...new Set(registersRead)], registersWritten:[...new Set(writes)],
      memoryReadCount:memoryReads.length, memoryWriteCount:memoryWrites.length,
      exactArchitecturalSummary:true,
    },
    possibleFaults:[...faults, possibleFeatureFault('x86-avx512-feature-state-fault')],
  });
}
