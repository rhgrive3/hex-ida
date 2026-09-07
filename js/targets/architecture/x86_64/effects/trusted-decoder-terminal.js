import {
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
} from '../../../../semantics/effects/index.js';

const CAPSTONE_ABI = 'capstone-5-wasm32-x86-detail/v1';
const DECODER_SEMANTIC = 'capstone-5-x86-structured-v2';

const FLAG_BITS = Object.freeze([
  ['AF', 0n, 14n, 26n, 55n, 44n, 50n],
  ['CF', 1n, 16n, 22n, 30n, 45n, 37n],
  ['SF', 2n, 12n, 25n, 53n, 41n, 34n],
  ['ZF', 3n, 13n, 51n, 54n, 42n, 35n],
  ['PF', 4n, 15n, 29n, 56n, 43n, 36n],
  ['OF', 5n, 11n, 21n, 52n, 40n, 33n],
  ['TF', 6n, 17n, 27n, null, null, 49n],
  ['IF', 7n, 18n, 24n, 32n, null, 48n],
  ['DF', 8n, 19n, 23n, 31n, null, 39n],
  ['NT', 9n, 20n, 28n, null, null, 38n],
  ['RF', 10n, null, 46n, null, null, 47n],
  ['AC', null, null, 58n, null, null, null],
]);

const FPU_FLAG_BITS = Object.freeze([
  ['C0', 0n, 4n, 8n, 12n, 16n],
  ['C1', 1n, 5n, 9n, 13n, 17n],
  ['C2', 2n, 6n, 10n, 14n, 18n],
  ['C3', 3n, 7n, 11n, 15n, 19n],
]);

const NONDETERMINISTIC = new Set([
  'rdrand', 'rdseed', 'rdtsc', 'rdtscp', 'rdpmc',
  'xstore', 'xcryptcbc', 'xcryptcfb', 'xcryptctr', 'xcryptecb', 'xcryptofb',
]);

const IO_READ = /^(?:in|ins|insb|insd|insw)$/;
const IO_WRITE = /^(?:out|outs|outsb|outsd|outsw)$/;
const STACK_READ = new Map([['popf',16],['popfq',64]]);
const STACK_WRITE = new Map([['pushf',16],['pushfq',64]]);
const BIT_STRING = new Set(['bt','btc','btr','bts']);
const X87_FAMILY = /^f(?!s|x)/;

function bit(mask, position) {
  return position != null && (mask & (1n << position)) !== 0n;
}

function trusted(instruction) {
  return instruction?.detailAvailable === true
    && instruction?.detailStatus === 'complete'
    && instruction?.decoderSemanticVersion === DECODER_SEMANTIC
    && instruction?.detail?.abiContractVersion === CAPSTONE_ABI
    && Array.isArray(instruction?.detail?.operands)
    && instruction?.rawBytes instanceof Uint8Array
    && instruction.rawBytes.length === instruction.length;
}

function registerName(register) {
  return String(register?.physicalId || register?.id || '').trim().toLowerCase();
}

function decoderRegisterSets(instruction) {
  const detail = instruction.detail || {};
  const reads = new Set((detail.registersRead || detail.implicitReads || []).map(registerName).filter(Boolean));
  const writes = new Set((detail.registersWritten || detail.implicitWrites || []).map(registerName).filter(Boolean));

  // Older structured-v2 rows do not yet carry cs_regs_access output. Operand
  // access remains authoritative when present and fills the explicit surface.
  for (const operand of detail.operands || []) {
    if (operand?.type !== 'register') continue;
    const name = registerName(operand.register);
    if (!name) continue;
    if (operand.access === 'read' || operand.access === 'read-write') reads.add(name);
    if (operand.access === 'write' || operand.access === 'read-write') writes.add(name);
  }
  return { reads, writes };
}

function flagSets(instruction, family) {
  const reads = new Set();
  const writes = new Set();
  const raw = BigInt(instruction?.detail?.eflags ?? 0n);
  let nondeterministic = false;

  if (X87_FAMILY.test(family)) {
    for (const [name, modify, reset, set, undef, test] of FPU_FLAG_BITS) {
      if (bit(raw, test)) reads.add(`fpsw.${name.toLowerCase()}`);
      if (bit(raw, modify) || bit(raw, reset) || bit(raw, set) || bit(raw, undef)) writes.add(`fpsw.${name.toLowerCase()}`);
      if (bit(raw, undef)) nondeterministic = true;
    }
    return { reads, writes, nondeterministic };
  }

  for (const [name, modify, prior, reset, set, undef, test] of FLAG_BITS) {
    if (bit(raw, prior) || bit(raw, test)) reads.add(`rflags.${name.toLowerCase()}`);
    if (bit(raw, modify) || bit(raw, reset) || bit(raw, set) || bit(raw, undef)) writes.add(`rflags.${name.toLowerCase()}`);
    if (bit(raw, undef)) nondeterministic = true;
  }
  return { reads, writes, nondeterministic };
}

function addressExpression(operand, instruction) {
  const memory = operand?.memory || {};
  return Object.freeze({
    kind:'x86-decoder-effective-address',
    base:registerName(memory.base) || null,
    index:registerName(memory.index) || null,
    scale:Number(memory.scale || 1),
    displacement:String(memory.displacement ?? 0n),
    segment:String(memory.segment || '').toLowerCase() || null,
    addressSizeBits:Number(memory.addressSizeBits || instruction?.detail?.addressSizeBits || 64),
  });
}

function memoryAccess(operand, instruction, space = 'memory', addressExpr = null) {
  return Object.freeze({
    space,
    addressExpr:addressExpr || addressExpression(operand, instruction),
    widthBits:Number(operand?.widthBits || 8),
    endian:'little',
  });
}

function specialBitStringAccess(instruction, operand, family) {
  const bitOperand = instruction.detail.operands?.[1];
  return Object.freeze({
    space:'memory',
    addressExpr:Object.freeze({
      kind:'x86-bit-string-effective-address',
      baseAddress:addressExpression(operand, instruction),
      bitIndexOperand:bitOperand?.type === 'register'
        ? Object.freeze({ kind:'register', register:registerName(bitOperand.register) })
        : bitOperand?.type === 'immediate'
          ? Object.freeze({ kind:'immediate', value:String(bitOperand.value) })
          : Object.freeze({ kind:'decoder-operand', index:1 }),
      operation:family,
    }),
    widthBits:Number(operand?.widthBits || 16),
    endian:'little',
  });
}

function stackAccess(widthBits, direction) {
  return Object.freeze({
    space:'memory',
    addressExpr:Object.freeze({
      kind:'x86-stack-address',
      base:'rsp',
      displacementBytes:direction === 'write' ? -(widthBits / 8) : 0,
    }),
    widthBits,
    endian:'little',
  });
}

function ioAccess(instruction) {
  const family = String(instruction.instructionFamily || '').toLowerCase();
  if (!IO_READ.test(family) && !IO_WRITE.test(family)) return null;
  const immediate = (instruction.detail.operands || []).find((operand) => operand?.type === 'immediate');
  const widthBits = family.endsWith('b') ? 8 : family.endsWith('w') ? 16 : family.endsWith('d') ? 32 :
    Number((instruction.detail.operands || []).find((operand) => operand?.widthBits)?.widthBits || 8);
  return Object.freeze({
    direction:IO_READ.test(family) ? 'read' : 'write',
    access:Object.freeze({
      space:'io',
      addressExpr:immediate
        ? Object.freeze({ kind:'x86-io-port-immediate', value:String(immediate.value) })
        : Object.freeze({ kind:'x86-io-port-register', register:'dx' }),
      widthBits,
      endian:'little',
    }),
  });
}

function memorySets(instruction, family) {
  const reads = [];
  const writes = [];
  for (const operand of instruction.detail.operands || []) {
    if (operand?.type !== 'memory') continue;
    if (family === 'nop') continue;
    let access;
    if (BIT_STRING.has(family)) access = specialBitStringAccess(instruction, operand, family);
    else if (family === 'cmpxchg16b') access = Object.freeze({ ...memoryAccess({ ...operand, widthBits:128 }, instruction), widthBits:128 });
    else access = memoryAccess(operand, instruction);
    if (operand.access === 'read' || operand.access === 'read-write') reads.push(access);
    if (operand.access === 'write' || operand.access === 'read-write') writes.push(access);
    if (operand.access === 'unknown') {
      if (family === 'cmpxchg16b' || BIT_STRING.has(family)) {
        reads.push(access);
        if (family !== 'bt') writes.push(access);
      } else {
        return null;
      }
    }
  }

  const stackRead = STACK_READ.get(family);
  const stackWrite = STACK_WRITE.get(family);
  if (stackRead) reads.push(stackAccess(stackRead, 'read'));
  if (stackWrite) writes.push(stackAccess(stackWrite, 'write'));

  const io = ioAccess(instruction);
  if (io?.direction === 'read') reads.push(io.access);
  if (io?.direction === 'write') writes.push(io.access);

  return { reads, writes };
}

function memorySummary(accesses) {
  return accesses.length ? { scope:'accesses', accesses } : { scope:'none' };
}

function hiddenState(ownerId, family, registersRead, registersWritten) {
  if (X87_FAMILY.test(family)) {
    registersRead.add('x86.x87.environment');
    registersWritten.add('x86.x87.environment');
  }
  if (ownerId === 'system') {
    const state = `x86.system.${family}.architectural-state`;
    registersRead.add(state);
    registersWritten.add(state);
  }
}

function promotedControlEffect(partial, instruction, ownerId) {
  const current = partial?.controlEffect;
  if (current && current.kind !== 'unknown') return current;
  const groups = new Set((instruction.detail?.groups || []).map((group) => String(group?.name || '').toLowerCase()));
  if (groups.has('call')) return { kind:'call', target:{ kind:'decoder-defined', family:instruction.instructionFamily } };
  if (groups.has('ret')) return { kind:'return', target:{ kind:'decoder-defined', family:instruction.instructionFamily } };
  if (groups.has('jump')) return { kind:'indirect', target:{ kind:'decoder-defined', family:instruction.instructionFamily } };
  if (groups.has('int') || groups.has('iret')) return { kind:'trap', reason:`x86-${instruction.instructionFamily}-architectural-control-transfer` };
  if (ownerId === 'control') return null;
  return { kind:'fallthrough' };
}

function possibleFaults(partial, memory, ownerId, family) {
  const faults = [...(partial?.possibleFaults || [])];
  if ((memory.reads.length || memory.writes.length) && !faults.some((fault) => fault?.kind === 'memory-access-fault')) {
    faults.push(Object.freeze({
      kind:'memory-access-fault',
      condition:Object.freeze({ kind:'x86-decoder-addressed-memory-fault', operation:family }),
      detail:Object.freeze({ causes:Object.freeze(['segment','non-canonical-address','page','protection','alignment-check']) }),
    }));
  }
  if (ownerId === 'system' && !faults.some((fault) => fault?.kind === 'x86-system-fault')) {
    faults.push(Object.freeze({
      kind:'x86-system-fault',
      condition:Object.freeze({ kind:'architectural-precondition', operation:family }),
      detail:Object.freeze({ authority:'Intel-SDM/AMD64-APM', summaryOnly:true }),
    }));
  }
  return faults;
}

/**
 * Terminalize a fail-closed family result only when it comes from the deployed
 * Capstone-5 structured decoder. The opaque intrinsic does not guess the
 * instruction value function: it freezes that computation behind a
 * summary-only intrinsic while deriving the complete architectural access
 * surface from decoder operand/register/flag metadata plus the small set of
 * architecturally implicit memory/state surfaces that Capstone does not encode
 * as ordinary operands.
 */
export function closeTrustedX86Partial(instruction, ownerId, partial, context = {}) {
  if (!partial || partial.completeness !== 'partial' || !trusted(instruction)) return partial;

  const family = String(instruction.instructionFamily || '').toLowerCase();
  const memory = memorySets(instruction, family);
  if (!memory) return partial;

  const controlEffect = promotedControlEffect(partial, instruction, ownerId);
  if (!controlEffect) return partial;

  const registers = decoderRegisterSets(instruction);
  const flags = flagSets(instruction, family);
  for (const value of flags.reads) registers.reads.add(value);
  for (const value of flags.writes) registers.writes.add(value);
  hiddenState(ownerId, family, registers.reads, registers.writes);

  const determinism = NONDETERMINISTIC.has(family) || flags.nondeterministic ? 'nondeterministic' : 'input-dependent';
  const options = context.machineEffectsOptions ?? context.options ?? {};
  const summary = createIntrinsicEffectSummary({
    inputs:[],
    outputs:[],
    registersRead:[...registers.reads],
    registersWritten:[...registers.writes],
    memoryRead:memorySummary(memory.reads),
    memoryWrite:memorySummary(memory.writes),
    controlEffects:controlEffect.kind === 'fallthrough' ? [] : [controlEffect],
    determinism,
    symbolicDetail:'summary-only',
  }, options);
  const operation = createMachineOperation({
    kind:'intrinsic',
    id:`${partial.instructionId}:trusted-decoder-terminal`,
    intrinsicId:`x86.decoder.${ownerId}.${family}`,
    effectSummary:summary,
    metadata:{
      summaryContractVersion:'x86-trusted-decoder-terminal/v1',
      decoderSemanticVersion:instruction.decoderSemanticVersion,
      decoderAbiContractVersion:instruction.detail.abiContractVersion,
      exactArchitecturalSummary:true,
      priorFailClosedReason:partial.unknownEffects?.reason || null,
    },
  }, options);

  return createMachineEffectBundle({
    instructionId:partial.instructionId,
    architectureId:partial.architectureId,
    mode:partial.mode,
    operations:[operation],
    controlEffect,
    possibleFaults:possibleFaults(partial, memory, ownerId, family),
    origin:partial.origin,
    completeness:'exact-with-intrinsic',
    metadata:{
      ...(partial.metadata || {}),
      terminalizedBy:'trusted-capstone-structured-intrinsic',
      terminalSummaryContractVersion:'x86-trusted-decoder-terminal/v1',
      priorFailClosedReason:partial.unknownEffects?.reason || null,
    },
  }, options);
}
