import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';

const FENCES = new Set(['lfence','sfence','mfence']);
const LIVE_PRIVILEGED = new Set(['cli','sti','hlt','invd','wbinvd','swapgs','lgdt','lidt','lldt','ltr']);
const SHARED_ALIAS_PRIVILEGED = new Set(['movcr','movdr']);
const SIMPLE_FLAG_CONTROLS = Object.freeze({
  clc:Object.freeze({ flag:'CF', fixedValue:0 }),
  stc:Object.freeze({ flag:'CF', fixedValue:1 }),
  cmc:Object.freeze({ flag:'CF', toggle:true }),
  cld:Object.freeze({ flag:'DF', fixedValue:0 }),
  std:Object.freeze({ flag:'DF', fixedValue:1 }),
});

const EXECUTION_ENV = 'sys:x86.execution-environment';
const MEMORY_ORDER_STATE = 'sys:x86.memory-order-state';
const CACHE_STATE = 'sys:x86.cache-state';
const SEGMENT_STATE = 'sys:x86.segment-state';
const DESCRIPTOR_STATE = 'sys:x86.descriptor-table-state';
const CET_STATE = 'sys:x86.CET-state';
const FRED_STATE = 'sys:x86.FRED-state';
const SHADOW_STACK_STATE = 'sys:x86.shadow-stack-state';
const INTERRUPTIBILITY_STATE = 'sys:x86.interruptibility-state';

const LEGACY_PREFIXES = new Set([0x26,0x2e,0x36,0x3e,0x64,0x65,0x66,0x67,0xf0,0xf2,0xf3]);
const FIXED_OPCODE = Object.freeze({
  lfence:Object.freeze([0x0f,0xae,0xe8]),
  sfence:Object.freeze([0x0f,0xae,0xf8]),
  mfence:Object.freeze([0x0f,0xae,0xf0]),
  cpuid:Object.freeze([0x0f,0xa2]),
  rdtsc:Object.freeze([0x0f,0x31]),
  rdtscp:Object.freeze([0x0f,0x01,0xf9]),
  syscall:Object.freeze([0x0f,0x05]),
  sysret:Object.freeze([0x0f,0x07]),
  sysretq:Object.freeze([0x0f,0x07]),
  cli:Object.freeze([0xfa]),
  sti:Object.freeze([0xfb]),
  hlt:Object.freeze([0xf4]),
  invd:Object.freeze([0x0f,0x08]),
  wbinvd:Object.freeze([0x0f,0x09]),
  swapgs:Object.freeze([0x0f,0x01,0xf8]),
  clc:Object.freeze([0xf8]),
  stc:Object.freeze([0xf9]),
  cmc:Object.freeze([0xf5]),
  cld:Object.freeze([0xfc]),
  std:Object.freeze([0xfd]),
});

function rawEncodingState(instruction) {
  const raw = [...(instruction?.rawBytes || [])];
  const prefixes = [];
  let cursor = 0;
  let lock = false;
  let rex = null;
  let group1 = null;
  let operandSize66 = false;
  while (cursor < raw.length) {
    const byte = raw[cursor];
    if (LEGACY_PREFIXES.has(byte)) {
      prefixes.push(byte);
      if (byte === 0xf0) lock = true;
      if (byte === 0xf0 || byte === 0xf2 || byte === 0xf3) group1 = byte;
      if (byte === 0x66) operandSize66 = true;
      // A REX byte only affects the instruction when it is the final prefix
      // immediately before the opcode/escape byte. A later legacy prefix
      // therefore makes an earlier REX placement architecturally inert.
      rex = null;
      cursor++;
      continue;
    }
    if (byte >= 0x40 && byte <= 0x4f) {
      prefixes.push(byte);
      rex = byte;
      cursor++;
      continue;
    }
    break;
  }
  return Object.freeze({
    raw:Object.freeze(raw),
    body:Object.freeze(raw.slice(cursor)),
    prefixes:Object.freeze(prefixes),
    lock,
    group1,
    operandSize66,
    rex,
  });
}


function isRex(byte) {
  return byte >= 0x40 && byte <= 0x4f;
}

function crossVendorPrefixPolicy(state, family, { memoryOperand = false } = {}) {
  const prefixes = [...state.prefixes];
  if (family === 'pause') {
    // F3 is the mandatory PAUSE opcode prefix. Avoid laundering any additional
    // legacy-prefix combination into exactness: Intel reserves several such
    // uses and AMD leaves same-group duplicates undefined.
    return prefixes.length === 1 && prefixes[0] === 0xf3;
  }

  // For system instructions without explicit memory operands, the only
  // cross-vendor optional prefix we exact-model is one final REX byte. Both
  // Intel and AMD specify a meaningless REX as ignored in 64-bit mode.
  if (!memoryOperand) {
    return prefixes.length === 0 || (prefixes.length === 1 && isRex(prefixes[0]));
  }

  // Memory system instructions may also use one address-size override and one
  // FS/GS override. REX, when present, must be the final prefix. This deliberately
  // excludes reserved/undefined REP, LOCK, operand-size, duplicate, and null
  // segment-prefix combinations from the exact denominator.
  let segmentSeen = false;
  let addressSizeSeen = false;
  let rexSeen = false;
  for (let index = 0; index < prefixes.length; index++) {
    const byte = prefixes[index];
    if (byte === 0x64 || byte === 0x65) {
      if (segmentSeen || rexSeen) return false;
      segmentSeen = true;
      continue;
    }
    if (byte === 0x67) {
      if (addressSizeSeen || rexSeen) return false;
      addressSizeSeen = true;
      continue;
    }
    if (isRex(byte)) {
      if (rexSeen || index !== prefixes.length - 1) return false;
      rexSeen = true;
      continue;
    }
    return false;
  }
  return true;
}

function sameBytes(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function fixedEncodingMatches(instruction, family) {
  const expected = FIXED_OPCODE[family];
  if (!expected) return false;
  const state = rawEncodingState(instruction);
  if (state.lock || !crossVendorPrefixPolicy(state, family) || !sameBytes(state.body, expected)) return false;
  if (FENCES.has(family) && (state.operandSize66 || state.group1 === 0xf2 || state.group1 === 0xf3)) return false;
  if (family === 'wbinvd' && state.group1 === 0xf3) return false;
  if (family === 'sysretq') return state.rex != null && (state.rex & 0x08) !== 0;
  if (family === 'sysret') return state.rex == null || (state.rex & 0x08) === 0;
  return true;
}

function pauseEncodingMatches(instruction) {
  const state = rawEncodingState(instruction);
  return !state.lock && crossVendorPrefixPolicy(state, 'pause') && sameBytes(state.body, [0x90]);
}

function modrmEncodingMatches(instruction, opcode, regField, { memoryOnly = false } = {}) {
  const state = rawEncodingState(instruction);
  const family = regField === 2 ? (opcode[1] === 0x01 ? 'lgdt' : 'lldt') : (opcode[1] === 0x01 ? 'lidt' : 'ltr');
  if (state.lock || state.body.length < opcode.length + 1) return false;
  if (!sameBytes(state.body.slice(0, opcode.length), opcode)) return false;
  const modrm = state.body[opcode.length];
  const memoryOperand = (modrm >>> 6) !== 3;
  if (!crossVendorPrefixPolicy(state, family, { memoryOperand })) return false;
  if (((modrm >>> 3) & 7) !== regField) return false;
  if (memoryOnly && !memoryOperand) return false;
  return true;
}

function liveEncodingMatches(instruction, family) {
  const raw = instruction?.rawBytes;
  if (!raw || raw.length === 0 || Number(instruction?.length) !== raw.length) return false;
  if (FIXED_OPCODE[family]) return fixedEncodingMatches(instruction, family);
  if (family === 'pause') return pauseEncodingMatches(instruction);
  if (family === 'lgdt') return modrmEncodingMatches(instruction, [0x0f,0x01], 2, { memoryOnly:true });
  if (family === 'lidt') return modrmEncodingMatches(instruction, [0x0f,0x01], 3, { memoryOnly:true });
  if (family === 'lldt') return modrmEncodingMatches(instruction, [0x0f,0x00], 2);
  if (family === 'ltr') return modrmEncodingMatches(instruction, [0x0f,0x00], 3);
  return false;
}

function systemHiddenState(family, fields) {
  return Object.freeze({ instructionFamily:family, canonicalState:Object.freeze(fields), preservation:'intrinsic-summary' });
}

function systemIntrinsic(ctx, id, inputs, outputWidths, config = {}) {
  return ctx.intrinsic(id, inputs, outputWidths, {
    registersRead:[...(config.registersRead ?? [])],
    registersWritten:[...(config.registersWritten ?? [])],
    memoryRead:config.memoryRead ?? { scope:'none' },
    memoryWrite:config.memoryWrite ?? { scope:'none' },
    controlEffects:config.controlEffects ?? [],
    determinism:config.determinism ?? 'input-dependent',
    symbolicDetail:'summary-only',
    metadata:{
      environmentDependent:config.environmentDependent !== false,
      exactArchitecturalSummary:true,
      architecture:'x86-64',
      ...(config.metadata || {}),
    },
  });
}

function malformedPartial(ctx, family, reason = `x86-${family}-encoding-evidence-unmodelled`) {
  return ctx.partial(reason, ['faults','other'], {
    detail:systemHiddenState(family, ['decoder-byte/family-consistency']),
    metadata:{ family:'system', operation:family, encodingValidated:false },
  });
}

function privilegeFault(family, condition = {}) {
  return Object.freeze({
    kind:'general-protection',
    condition:Object.freeze({ kind:'x86-privilege-check', instruction:family, ...condition }),
    detail:Object.freeze({ fault:'#GP(0)' }),
  });
}

function invalidOpcodeFault(family, condition = {}) {
  return Object.freeze({
    kind:'undefined-opcode',
    condition:Object.freeze({ kind:'x86-invalid-system-environment', instruction:family, ...condition }),
    detail:Object.freeze({ fault:'#UD' }),
  });
}

function virtualizationMetadata(family) {
  return Object.freeze({
    operation:family,
    virtualization:'may-be-intercepted-by-VMX/SVM according to guest-control state; no host result is assumed',
    environmentRegister:EXECUTION_ENV,
  });
}

function liftFence(ctx, family) {
  if (!liveEncodingMatches(ctx.instruction, family)) {
    return ctx.partial('x86-fence-generic-barrier-contract-insufficient', ['memory','other'], {
      detail:{ instructionFamily:family, missingContract:'validated system encoding required before exact x86 barrier lowering' },
      metadata:{ family:'system', operation:family, barrierOperationEmitted:false, fenceKindsCollapsed:false, encodingValidated:false },
    });
  }
  const orders = family === 'lfence'
    ? {
      priorLoads:'complete before LFENCE completes',
      priorStores:'need not be globally visible before LFENCE completes',
      followingInstructions:'do not begin execution until LFENCE completes',
      memoryRelation:'orders earlier loads before later memory instruction execution without globally draining earlier stores',
    }
    : family === 'sfence'
      ? {
        priorStores:'globally visible before later stores become globally visible',
        priorLoads:'not ordered by SFENCE',
        memoryRelation:'store-before-store fence',
      }
      : {
        priorLoadsAndStores:'globally visible before later loads/stores become globally visible',
        memoryRelation:'load/store-before-load/store fence',
      };
  ctx.addOperation({
    kind:'barrier',
    scope:{ architecture:'x86-64', instruction:family, memoryOrdering:orders, state:MEMORY_ORDER_STATE },
    metadata:{ exactArchitecturalSummary:true, fenceKind:family },
  });
  return ctx.finish({
    family:'system',
    metadata:{ operation:family, fenceKind:family, fenceKindsCollapsed:false, exactBarrierContract:true },
  });
}

function liftCpuid(ctx) {
  const eax = x86RegisterOperand('eax');
  const ebx = x86RegisterOperand('ebx');
  const ecx = x86RegisterOperand('ecx');
  const edx = x86RegisterOperand('edx');
  const leaf = ctx.readRegister(eax);
  const subleaf = ctx.readRegister(ecx);
  if (!leaf || !subleaf) return ctx.partial('x86-cpuid-input-state-unmodelled', ['registers','other']);
  if (!liveEncodingMatches(ctx.instruction, 'cpuid')) {
    const outputs = systemIntrinsic(ctx, 'x86.system.cpuid', [leaf,subleaf], [32,32,32,32], {
      registersRead:['rax','rcx'], registersWritten:['rax','rbx','rcx','rdx'], determinism:'nondeterministic',
      metadata:{ operation:'cpuid', environmentDependent:true, exactArchitecturalSummary:false },
    });
    for (const [operand,value] of [[eax,outputs[0]],[ebx,outputs[1]],[ecx,outputs[2]],[edx,outputs[3]]]) ctx.writeRegister(operand, value);
    return ctx.partial('x86-cpuid-environment-and-serialization-unmodelled', ['other'], {
      detail:systemHiddenState('cpuid', ['decoder-byte/family-consistency']),
      metadata:{ family:'system', operation:'cpuid', deterministicOutput:false, outputShapeModeled:true, ordinaryCall:false, encodingValidated:false },
    });
  }
  ctx.addOperation({
    kind:'barrier',
    scope:{ architecture:'x86-64', instruction:'cpuid', serialization:'all-prior-instructions-complete-before; subsequent-instructions-start-after' },
    metadata:{ exactArchitecturalSummary:true, serializingInstruction:true },
  });
  const outputs = systemIntrinsic(ctx, 'x86.system.cpuid', [leaf,subleaf], [32,32,32,32], {
    registersRead:['rax','rcx',EXECUTION_ENV],
    registersWritten:['rax','rbx','rcx','rdx'],
    determinism:'input-dependent',
    metadata:{
      ...virtualizationMetadata('cpuid'),
      inputs:['EAX.leaf','ECX.subleaf'],
      outputs:['EAX','EBX','ECX','EDX'],
      dependency:'architectural processor configuration / hypervisor-visible CPUID state',
      noHostConstant:true,
    },
  });
  for (const [operand,value] of [[eax,outputs[0]],[ebx,outputs[1]],[ecx,outputs[2]],[edx,outputs[3]]]) {
    if (!ctx.writeRegister(operand, value)) return ctx.partial('x86-cpuid-output-state-unmodelled', ['registers','other']);
  }
  return ctx.finish({
    family:'system',
    metadata:{ operation:'cpuid', deterministicOutput:false, outputShapeModeled:true, ordinaryCall:false, environmentExact:true },
  });
}

function liftTimestamp(ctx, family) {
  const eax = x86RegisterOperand('eax');
  const edx = x86RegisterOperand('edx');
  const ecx = x86RegisterOperand('ecx');
  if (!liveEncodingMatches(ctx.instruction, family)) {
    const outputs = systemIntrinsic(ctx, `x86.system.${family}`, [], family === 'rdtscp' ? [32,32,32] : [32,32], {
      registersWritten:family === 'rdtscp' ? ['rax','rdx','rcx'] : ['rax','rdx'], determinism:'nondeterministic',
      metadata:{ operation:family, environmentDependent:true, exactArchitecturalSummary:false },
    });
    ctx.writeRegister(eax, outputs[0]); ctx.writeRegister(edx, outputs[1]);
    if (family === 'rdtscp') ctx.writeRegister(ecx, outputs[2]);
    return ctx.partial(`x86-${family}-runtime-state-unmodelled`, ['faults','other'], {
      detail:systemHiddenState(family, ['decoder-byte/family-consistency']),
      possibleFaults:[privilegeFault(family, { rule:'CR4.TSD/CPL state unmodelled' })],
      metadata:{ family:'system', operation:family, deterministicOutput:false, outputShapeModeled:true, encodingValidated:false },
    });
  }
  if (family === 'rdtscp') {
    ctx.addOperation({
      kind:'barrier',
      scope:{ architecture:'x86-64', instruction:'rdtscp', ordering:'waits-for-prior-instructions-and-prior-loads; does-not-wait-for-prior-stores; not-fully-serializing' },
      metadata:{ exactArchitecturalSummary:true, partialOrderingInstruction:true },
    });
  }
  const outputs = systemIntrinsic(ctx, `x86.system.${family}`, [], family === 'rdtscp' ? [32,32,32] : [32,32], {
    registersRead:[EXECUTION_ENV],
    registersWritten:family === 'rdtscp' ? ['rax','rdx','rcx'] : ['rax','rdx'],
    determinism:'nondeterministic',
    metadata:{
      ...virtualizationMetadata(family),
      value:'architectural timestamp counter',
      outputs:family === 'rdtscp' ? ['EDX:EAX=TSC','ECX=IA32_TSC_AUX'] : ['EDX:EAX=TSC'],
      noHostConstant:true,
    },
  });
  if (!ctx.writeRegister(eax, outputs[0]) || !ctx.writeRegister(edx, outputs[1])) return ctx.partial(`x86-${family}-output-state-unmodelled`, ['registers','other']);
  if (family === 'rdtscp' && !ctx.writeRegister(ecx, outputs[2])) return ctx.partial('x86-rdtscp-aux-state-unmodelled', ['registers','other']);
  const possibleFaults = [privilegeFault(family, { rule:'CR4.TSD=1 and CPL>0' })];
  if (family === 'rdtscp') possibleFaults.push(invalidOpcodeFault(family, { rule:'RDTSCP architectural feature unavailable' }));
  return ctx.finish({
    family:'system',
    possibleFaults,
    metadata:{ operation:family, deterministicOutput:false, outputShapeModeled:true, environmentExact:true },
  });
}

function liftSyscall(ctx) {
  const nextRip = BigInt(ctx.instruction.address) + BigInt(ctx.instruction.length);
  const rflagsOperand = x86RegisterOperand('rflags');
  const rflags = ctx.readRegister(rflagsOperand);
  if (!liveEncodingMatches(ctx.instruction, 'syscall') || String(ctx.instruction.mnemonic || '').toLowerCase() !== 'syscall') {
    if (rflags) {
      ctx.writeRegister(x86RegisterOperand('rcx'), ctx.constant(64,nextRip));
      ctx.writeRegister(x86RegisterOperand('r11'), rflags);
    }
    return ctx.partial('x86-syscall-msr-and-privilege-state-unmodelled', ['registers','flags','control','other'], {
      controlEffect:{ kind:'unknown', reason:'x86-syscall-target-derived-from-unmodelled-system-msrs' },
      detail:systemHiddenState('syscall', ['decoder-byte/family-consistency']),
      metadata:{ family:'system', operation:'syscall', ordinaryCall:false, knownVisibleWrites:['RCX=nextRIP','R11=RFLAGS'], stackCallSemantics:false, encodingValidated:false },
    });
  }
  if (!rflags) return ctx.partial('x86-syscall-rflags-state-unmodelled', ['registers','control','other'], { controlEffect:{ kind:'unknown', reason:'x86-syscall-system-target-unmodelled' } });
  if (!ctx.writeRegister(x86RegisterOperand('rcx'), ctx.constant(64,nextRip)) || !ctx.writeRegister(x86RegisterOperand('r11'), rflags)) {
    return ctx.partial('x86-syscall-visible-register-state-unmodelled', ['registers','control','other'], { controlEffect:{ kind:'unknown', reason:'x86-syscall-system-target-unmodelled' } });
  }
  const target = Object.freeze({ kind:'x86-system-target', source:'architectural SYSCALL entry state (legacy IA32_LSTAR or FRED delivery state)' });
  const [nextRflags] = systemIntrinsic(ctx, 'x86.system.syscall-transition', [rflags], [64], {
    registersRead:[
      'rflags','sys:x86.IA32_LSTAR','sys:x86.IA32_STAR','sys:x86.IA32_FMASK','sys:x86.IA32_EFER',
      'sys:x86.IA32_PL3_SSP','sys:x86.SSP',CET_STATE,FRED_STATE,SHADOW_STACK_STATE,EXECUTION_ENV,
    ],
    registersWritten:[
      'rflags',SEGMENT_STATE,'sys:x86.IA32_PL3_SSP','sys:x86.SSP',CET_STATE,FRED_STATE,SHADOW_STACK_STATE,EXECUTION_ENV,
    ],
    memoryRead:{ scope:'all', spaces:['memory'], detail:{ kind:'conditional-system-entry-memory', condition:'FRED/CET delivery state may perform architectural stack or shadow-stack accesses' } },
    memoryWrite:{ scope:'all', spaces:['memory'], detail:{ kind:'conditional-system-entry-memory', condition:'FRED/CET delivery state may perform architectural stack or shadow-stack accesses' } },
    controlEffects:[{ kind:'indirect', target }],
    determinism:'input-dependent',
    metadata:{
      ...virtualizationMetadata('syscall'),
      transition:'legacy: RCX<-nextRIP; R11<-RFLAGS; RFLAGS<-RFLAGS & ~IA32_FMASK; RIP/CS/SS/CPL from SYSCALL MSRs; FRED: architecturally defined FRED event delivery',
      cetTransition:'conditionally save user SSP to IA32_PL3_SSP, establish supervisor shadow-stack/CET state, and update CET tracker state',
      fredTransition:'when enabled, entry target/stack/shadow-stack state and memory accesses are selected by FRED architectural state rather than guessed from the host',
      noHostConstant:true,
    },
  });
  if (!ctx.writeRegister(rflagsOperand, nextRflags)) return ctx.partial('x86-syscall-rflags-write-unmodelled', ['flags','other']);
  return ctx.finish({
    family:'system',
    controlEffect:{ kind:'indirect', target },
    possibleFaults:[
      invalidOpcodeFault('syscall', { rule:'IA32_EFER.SCE=0 or execution environment disables SYSCALL' }),
      { kind:'general-protection', condition:{ kind:'x86-fred-syscall-delivery-fault', causes:['non-canonical-entry-RIP','misaligned-SSP','shadow-stack-noncanonical-or-LASS'] }, detail:{ fault:'#GP(0)' } },
      { kind:'stack-segment', condition:{ kind:'x86-fred-syscall-stack-fault', causes:['ordinary-stack-noncanonical-or-LASS'] }, detail:{ fault:'#SS(0)' } },
      { kind:'page-fault', condition:{ kind:'x86-fred-syscall-page-fault', causes:['FRED-delivery-memory-access'] }, detail:{ fault:'#PF' } },
    ],
    metadata:{ operation:'syscall', ordinaryCall:false, knownVisibleWrites:['RCX=nextRIP','R11=pre-transition RFLAGS'], stackCallSemantics:false, environmentExact:true, fredAndCetStateModeled:true },
  });
}

function liftSysret(ctx, family) {
  if (!liveEncodingMatches(ctx.instruction, family) || !['sysret','sysretq'].includes(String(ctx.instruction.mnemonic || '').toLowerCase())) {
    return ctx.partial('x86-sysret-msr-segment-and-privilege-state-unmodelled', ['registers','flags','control','faults','other'], {
      controlEffect:{ kind:'unknown', reason:'x86-sysret-control-transfer-depends-on-unmodelled-system-state' },
      detail:systemHiddenState(family, ['decoder-byte/family-consistency']),
      metadata:{ family:'system', operation:family, ordinaryReturn:false, stackReturnSemantics:false, visibleInputs:['RCX','R11'], encodingValidated:false },
    });
  }
  const rcx = ctx.readRegister(x86RegisterOperand('rcx'));
  const r11 = ctx.readRegister(x86RegisterOperand('r11'));
  if (!rcx || !r11) return ctx.partial('x86-sysret-visible-input-state-unmodelled', ['registers','flags','control','other'], { controlEffect:{ kind:'unknown', reason:'x86-sysret-system-state-unmodelled' } });
  const target = family === 'sysretq'
    ? rcx
    : ctx.coerce(ctx.valueOp('extract', [rcx], 32, { lsb:0, widthBits:32, semantic:'x86-sysret-compat-target-ecx' }), 32, 64, false);
  const [nextRflags] = systemIntrinsic(ctx, 'x86.system.sysret-transition', [rcx,r11], [64], {
    registersRead:['rcx','r11','sys:x86.IA32_STAR','sys:x86.IA32_EFER','sys:x86.IA32_PL3_SSP',CET_STATE,FRED_STATE,SHADOW_STACK_STATE,EXECUTION_ENV],
    registersWritten:['rflags',SEGMENT_STATE,'sys:x86.SSP',CET_STATE,SHADOW_STACK_STATE,EXECUTION_ENV],
    controlEffects:[{ kind:'indirect', target }],
    determinism:'input-dependent',
    metadata:{
      ...virtualizationMetadata(family),
      operandSize:family === 'sysretq' ? 64 : 32,
      transition:family === 'sysretq' ? 'RIP<-RCX; RFLAGS<-architecturally masked R11; CS/SS/CPL from IA32_STAR' : 'RIP<-zero-extended ECX; RFLAGS<-architecturally masked R11; enter compatibility mode with CS/SS/CPL from IA32_STAR',
      cetTransition:'when user shadow stacks are enabled, SSP<-IA32_PL3_SSP and CET state transitions according to the architectural contract',
      fredRequirement:'CR4.FRED=1 selects #UD instead of SYSRET state transition',
      noHostConstant:true,
    },
  });
  if (!ctx.writeRegister(x86RegisterOperand('rflags'), nextRflags)) return ctx.partial('x86-sysret-rflags-write-unmodelled', ['flags','other']);
  return ctx.finish({
    family:'system',
    controlEffect:{ kind:'indirect', target },
    possibleFaults:[
      privilegeFault(family, { rule:'CPL != 0 or other SYSRET privilege/system-state preconditions are not satisfied' }),
      ...(family === 'sysretq' ? [{ kind:'general-protection', condition:{ kind:'x86-noncanonical-sysret-target', register:'RCX', operandSize:64 }, detail:{ fault:'#GP(0)' } }] : []),
      invalidOpcodeFault(family, { rule:'IA32_EFER.SCE=0, CR4.FRED=1, or SYSCALL/SYSRET architectural feature unavailable' }),
    ],
    metadata:{ operation:family, ordinaryReturn:false, stackReturnSemantics:false, visibleInputs:['RCX','R11'], environmentExact:true, fredAndCetStateModeled:true },
  });
}

function memorySummaryForOperand(ctx, operand, widthBits, detail) {
  if (operand?.type !== 'memory') return null;
  const resolved = x86EffectiveAddressExpression(ctx.instruction, operand);
  if (!resolved) return null;
  return Object.freeze({
    scope:'accesses',
    accesses:Object.freeze([Object.freeze({
      space:resolved.space,
      addressExpr:resolved.expression,
      widthBits,
      endian:'little',
    })]),
    detail,
  });
}

function operandAddressRegisters(operand) {
  if (operand?.type !== 'memory') return [];
  return [operand.memory?.base?.physicalId, operand.memory?.index?.physicalId].filter(Boolean);
}

function liftDescriptorTable(ctx, family) {
  const [operand] = ctx.operands;
  if (!liveEncodingMatches(ctx.instruction, family) || operand?.type !== 'memory' || operand.widthBits !== 80) {
    return malformedPartial(ctx, family);
  }
  const memoryRead = memorySummaryForOperand(ctx, operand, 80, { kind:'x86-pseudo-descriptor-load', bytes:10 });
  if (!memoryRead) return ctx.partial(`x86-${family}-address-state-unmodelled`, ['registers','memory','other']);
  const target = family === 'lgdt' ? 'sys:x86.GDTR' : 'sys:x86.IDTR';
  systemIntrinsic(ctx, `x86.system.${family}`, [], [], {
    registersRead:[EXECUTION_ENV,...operandAddressRegisters(operand)],
    registersWritten:[target,DESCRIPTOR_STATE],
    memoryRead,
    determinism:'input-dependent',
    metadata:{
      ...virtualizationMetadata(family),
      transition:`${target} <- 10-byte pseudo-descriptor operand`,
      privileged:true,
      noHostConstant:true,
    },
  });
  return ctx.finish({
    family:'system',
    possibleFaults:[privilegeFault(family, { rule:'CPL>0' }), ...x86MemoryFaults('read',80)],
    metadata:{ operation:family, privileged:true, environmentExact:true, operandWidthBits:80 },
  });
}

function liftTaskOrLdt(ctx, family) {
  const [operand] = ctx.operands;
  if (!liveEncodingMatches(ctx.instruction, family) || !operand || operand.widthBits !== 16 || !['register','memory'].includes(operand.type)) {
    return malformedPartial(ctx, family);
  }
  const registersRead = [EXECUTION_ENV,DESCRIPTOR_STATE];
  const inputs = [];
  let memoryRead = { scope:'all', spaces:['memory'], detail:{ kind:'implicit-descriptor-table-read', selectedBy:family === 'lldt' ? 'LDTR selector' : 'TR selector' } };
  if (operand.type === 'register') {
    const value = ctx.readOperand(operand, 16);
    if (!value) return ctx.partial(`x86-${family}-selector-source-unmodelled`, ['registers','other']);
    inputs.push(value);
    registersRead.push(operand.register.physicalId);
  } else {
    registersRead.push(...operandAddressRegisters(operand));
    memoryRead = { scope:'all', spaces:['memory'], detail:{ kind:'explicit-selector-plus-implicit-descriptor-table-read', explicitOperandWidthBits:16 } };
  }
  const target = family === 'lldt' ? 'sys:x86.LDTR' : 'sys:x86.TR';
  systemIntrinsic(ctx, `x86.system.${family}`, inputs, [], {
    registersRead,
    registersWritten:[target,DESCRIPTOR_STATE],
    memoryRead,
    memoryWrite:family === 'ltr'
      ? { scope:'all', spaces:['memory'], detail:{ kind:'implicit-gdt-descriptor-write', transition:'set selected available-TSS descriptor busy bit after successful load' } }
      : { scope:'none' },
    determinism:'input-dependent',
    metadata:{
      ...virtualizationMetadata(family),
      transition:`${target} selector/cache <- validated system-segment descriptor`,
      selectorSource:operand.type,
      descriptorValidation:true,
      selectorCases:family === 'lldt'
        ? { nullSelector:'invalidate/mark LDTR unusable without descriptor fetch', nonNullSelector:'validate and load LDT descriptor' }
        : { nullSelector:'#GP(0)', nonNullSelector:'validate available TSS descriptor, load TR, and mark descriptor busy' },
      descriptorBusyWrite:family === 'ltr' ? 'locked-read-modify-write of selected 16-byte TSS descriptor busy bit' : false,
      privileged:true,
      noHostConstant:true,
    },
  });
  return ctx.finish({
    family:'system',
    possibleFaults:[
      privilegeFault(family, { rule:'CPL>0' }),
      { kind:'general-protection', condition:{ kind:'x86-system-segment-selector-or-descriptor-invalid', instruction:family }, detail:{ fault:'#GP(selector)' } },
      { kind:'segment-not-present', condition:{ kind:'x86-system-segment-not-present', instruction:family }, detail:{ fault:'#NP(selector)' } },
      ...(operand.type === 'memory' ? x86MemoryFaults('read',16) : []),
      { kind:'memory-access-fault', condition:{ kind:'x86-descriptor-table-memory-fault', instruction:family }, detail:{ causes:['page','protection','non-canonical-descriptor-table-address'] } },
    ],
    metadata:{ operation:family, privileged:true, environmentExact:true, selectorWidthBits:16, selectorSource:operand.type },
  });
}

function liftCliSti(ctx, family) {
  if (!liveEncodingMatches(ctx.instruction, family)) return ctx.partial(`x86-${family}-privileged-system-state-unmodelled`, ['registers','flags','control','faults','other'], { possibleFaults:[privilegeFault(family)], metadata:{ family:'system', operation:family, treatedAsNop:false, privileged:true, encodingValidated:false } });
  systemIntrinsic(ctx, `x86.system.${family}`, [], [], {
    registersRead:['rflags',EXECUTION_ENV,...(family === 'sti' ? [INTERRUPTIBILITY_STATE] : [])],
    registersWritten:['rflags',EXECUTION_ENV,...(family === 'sti' ? [INTERRUPTIBILITY_STATE] : [])],
    determinism:'input-dependent',
    metadata:{
      ...virtualizationMetadata(family),
      transition:family === 'cli'
        ? 'clear IF when CPL<=IOPL; otherwise clear VIF only when architectural virtual-interrupt conditions permit; else #GP(0)'
        : 'set IF when CPL<=IOPL; otherwise set VIF only when architectural virtual-interrupt conditions permit and VIP permits; else #GP(0)',
      stateDiscriminators:['CPL','IOPL','CR4.PVI','RFLAGS.VIF','RFLAGS.VIP','locked-long-64-mode'],
      ...(family === 'sti' ? { interruptibilityTransition:'when STI changes IF from 0 to 1, maskable-interrupt recognition is inhibited through the following instruction boundary according to the architectural STI shadow contract' } : {}),
      privilegedOrVirtualizedFlagControl:true,
      noFixedPrivilegeAssumption:true,
    },
  });
  return ctx.finish({
    family:'system',
    possibleFaults:[privilegeFault(family, { rule:'CPL/IOPL and virtual-interrupt state select #GP(0) rather than IF/VIF update' })],
    metadata:{ operation:family, treatedAsNop:false, privileged:true, environmentExact:true },
  });
}

function liftHlt(ctx) {
  if (!liveEncodingMatches(ctx.instruction, 'hlt')) return ctx.partial('x86-hlt-privileged-system-state-unmodelled', ['registers','flags','control','faults','other'], { controlEffect:{ kind:'unknown', reason:'x86-hlt-execution-resumption-environment-unmodelled' }, possibleFaults:[privilegeFault('hlt')], metadata:{ family:'system', operation:'hlt', treatedAsNop:false, privileged:true, encodingValidated:false } });
  systemIntrinsic(ctx, 'x86.system.hlt', [], [], {
    registersRead:[EXECUTION_ENV],
    registersWritten:[EXECUTION_ENV],
    controlEffects:[{ kind:'fallthrough' }],
    determinism:'input-dependent',
    metadata:{
      ...virtualizationMetadata('hlt'),
      transition:'if CPL=0, enter halted execution state until an architecturally recognized wake event, then resume at next instruction',
      executionSuspension:true,
      noHostWakeEventAssumption:true,
    },
  });
  return ctx.finish({
    family:'system',
    possibleFaults:[privilegeFault('hlt', { rule:'CPL>0' })],
    metadata:{ operation:'hlt', treatedAsNop:false, privileged:true, environmentExact:true, executionSuspension:true },
  });
}

function liftCacheControl(ctx, family) {
  if (!liveEncodingMatches(ctx.instruction, family)) return malformedPartial(ctx, family);
  systemIntrinsic(ctx, `x86.system.${family}`, [], [], {
    registersRead:[EXECUTION_ENV,CACHE_STATE],
    registersWritten:[EXECUTION_ENV,CACHE_STATE],
    memoryWrite:family === 'wbinvd'
      ? { scope:'all', spaces:['memory'], detail:{ kind:'write-back-modified-cache-lines-before-invalidation' } }
      : { scope:'none' },
    determinism:'input-dependent',
    metadata:{
      ...virtualizationMetadata(family),
      transition:family === 'wbinvd' ? 'write back modified cache lines and invalidate caches' : 'invalidate caches without architecturally requiring writeback',
      privileged:true,
      noCacheContentsAssumption:true,
    },
  });
  return ctx.finish({
    family:'system',
    possibleFaults:[privilegeFault(family, { rule:'CPL>0' })],
    metadata:{ operation:family, treatedAsNop:false, privileged:true, environmentExact:true },
  });
}

function liftSwapgs(ctx) {
  if (!liveEncodingMatches(ctx.instruction, 'swapgs')) return malformedPartial(ctx, 'swapgs');
  systemIntrinsic(ctx, 'x86.system.swapgs', [], [], {
    registersRead:['sys:x86.GS.base','sys:x86.IA32_KERNEL_GS_BASE',EXECUTION_ENV],
    registersWritten:['sys:x86.GS.base','sys:x86.IA32_KERNEL_GS_BASE'],
    determinism:'input-dependent',
    metadata:{
      ...virtualizationMetadata('swapgs'),
      transition:'exchange GS.base and IA32_KERNEL_GS_BASE',
      privileged:true,
      noHostConstant:true,
    },
  });
  return ctx.finish({
    family:'system',
    possibleFaults:[
      privilegeFault('swapgs', { rule:'CPL>0' }),
      invalidOpcodeFault('swapgs', { rule:'not 64-bit mode, or implementation-defined architectural state such as Intel CR4.FRED forbids SWAPGS' }),
    ],
    metadata:{ operation:'swapgs', treatedAsNop:false, privileged:true, environmentExact:true },
  });
}

function liftSimpleFlagControl(ctx, family) {
  const spec = SIMPLE_FLAG_CONTROLS[family];
  if (!spec) return null;
  if (!liveEncodingMatches(ctx.instruction, family)) return malformedPartial(ctx, family);
  if (ctx.operands.length !== 0) {
    return ctx.partial(`x86-${family}-unexpected-explicit-operands`, ['flags','other'], {
      metadata:{ family:'system', operation:family, operandCount:ctx.operands.length },
    });
  }
  const value = spec.toggle
    ? ctx.valueOp('xor', [ctx.readFlag(spec.flag), ctx.constant(1, 1n)], 1, { semantic:`x86-${family}-toggle-${spec.flag}` })
    : ctx.constant(1, BigInt(spec.fixedValue));
  ctx.writeFlag(spec.flag, value, {
    operation:family,
    widthBits:1,
    definedness:spec.toggle ? 'defined' : 'fixed',
    ...(spec.toggle ? { toggle:true } : { fixedValue:spec.fixedValue }),
  });
  return ctx.finish({
    family:'system',
    metadata:{ operation:family, flag:spec.flag, flagsModified:[spec.flag], ...(spec.toggle ? { toggle:true } : { fixedValue:spec.fixedValue }) },
  });
}

const EXTENDED_SYSTEM_NAMES = new Set([
  'bndcl', 'bndcn', 'bndcu', 'bndldx', 'bndmk', 'bndmov', 'bndstx',
  'clac', 'stac', 'cldemote', 'clflush', 'clflushopt', 'clgi', 'stgi', 'clrssbsy', 'clts', 'clwb', 'clzero',
  'encls', 'enclu', 'enclv', 'endbr32', 'endbr64', 'lcall', 'ljmp',
  'in', 'out', 'insb', 'insd', 'insw', 'outsb', 'outsd', 'outsw',
  'incsspd', 'incsspq', 'invept', 'invlpg', 'invlpga', 'invpcid', 'invvpid',
  'iret', 'iretd', 'iretq', 'lahf', 'sahf', 'lar', 'lfs', 'lgs', 'lss',
  'llwpcb', 'slwpcb', 'lwpins', 'lwpval', 'lmsw', 'smsw', 'retf', 'retfq',
  'lsl', 'monitorx', 'monitor', 'movdir64b', 'movdiri', 'mwaitx', 'mwait',
  'pconfig', 'ptwrite', 'rdfsbase', 'rdgsbase', 'wrfsbase', 'wrgsbase',
  'rdmsr', 'wrmsr', 'rdpid', 'rdpkru', 'wrpkru', 'rdpmc',
  'rdsspd', 'rdsspq', 'rstorssp', 'saveprevssp', 'setssbsy', 'wrssd', 'wrssq', 'wrussd', 'wrussq',
  'sgdt', 'sidt', 'sldt', 'str', 'skinit', 'tpause', 'umonitor', 'umwait',
  'verr', 'verw', 'vmcall', 'vmclear', 'vmfunc', 'vmlaunch', 'vmload', 'vmmcall',
  'vmptrld', 'vmptrst', 'vmread', 'vmresume', 'vmrun', 'vmsave', 'vmwrite', 'vmxoff', 'vmxon',
  'wbnoinvd', 'xabort', 'xbegin', 'xend', 'xtest', 'xgetbv', 'xsetbv',
  'xsave', 'xsaveopt', 'xsavec', 'xsaves', 'xsave64', 'xsaveopt64', 'xsavec64', 'xsaves64',
  'xrstor', 'xrstors', 'xrstor64', 'xrstors64', 'serialize', 'tsxldtrk', 'tsxsusldtrk',
  'enqcmd', 'enqcmds',
  'getsec', 'rsm', 'sysenter', 'sysexit', 'sysexitq', 'rdrand', 'rdseed',
  'montmul', 'xcryptcbc', 'xcryptcfb', 'xcryptctr', 'xcryptecb', 'xcryptofb', 'xsha1', 'xsha256', 'xstore',
  'prefetch', 'prefetchnta', 'prefetcht0', 'prefetcht1', 'prefetcht2', 'prefetchw', 'prefetchwt1',
]);
const PROVEN_EXTENDED_SYSTEM_FAMILIES = new Set([]);

function liftExtendedSystem(ctx, family) {
  if (!PROVEN_EXTENDED_SYSTEM_FAMILIES.has(family)) {
    return ctx.partial('x86-extended-system-family-requires-dedicated-semantics', ['memory', 'registers', 'flags', 'control', 'faults', 'other'], {
      controlEffect:{ kind:'unknown', reason:'x86-extended-system-control-effect-unproven' },
      metadata:{ family:'system', operation:family, exactArchitecturalSummary:false, requiresDedicatedOperandRoles:true },
    });
  }
  const operands = ctx.operands;
  const inputs = [], registersRead = [], registersWritten = [], memoryReads = [], memoryWrites = [];
  const faults = [];

  if (['lcall', 'ljmp', 'retf', 'retfq', 'iret', 'iretd', 'iretq'].includes(family)) {
    const isCall = family === 'lcall';
    const isRet = ['retf', 'retfq', 'iret', 'iretd', 'iretq'].includes(family);
    const target = Object.freeze({ kind: 'indirect', source: `x86-far-${family}` });
    return ctx.finish({
      family: 'system',
      controlEffect: { kind: isCall ? 'call' : (isRet ? 'return' : 'indirect'), target },
      possibleFaults: [Object.freeze({ kind: 'general-protection', condition: { kind: 'x86-far-transfer-fault' }, detail: { fault: '#GP(0)' } })],
      metadata: { operation: family, farControlTransfer: true },
    });
  }

  if (family === 'lahf') {
    const ah = x86RegisterOperand('ah');
    const flagsVal = ctx.valueOp('flags-to-ah', [ctx.readFlag('SF'), ctx.readFlag('ZF'), ctx.readFlag('AF'), ctx.readFlag('PF'), ctx.readFlag('CF')], 8);
    ctx.writeRegister(ah, flagsVal);
    return ctx.finish({ family: 'system', metadata: { operation: 'lahf', ahWritten: true } });
  }
  if (family === 'sahf') {
    const ah = x86RegisterOperand('ah');
    const ahVal = ctx.readRegister(ah);
    if (!ahVal) return ctx.partial('x86-sahf-ah-unmodelled', ['registers']);
    ctx.writeFlag('SF', ctx.valueOp('extract', [ahVal], 1, { lsb: 7 }), { operation: 'sahf' });
    ctx.writeFlag('ZF', ctx.valueOp('extract', [ahVal], 1, { lsb: 6 }), { operation: 'sahf' });
    ctx.writeFlag('AF', ctx.valueOp('extract', [ahVal], 1, { lsb: 4 }), { operation: 'sahf' });
    ctx.writeFlag('PF', ctx.valueOp('extract', [ahVal], 1, { lsb: 2 }), { operation: 'sahf' });
    ctx.writeFlag('CF', ctx.valueOp('extract', [ahVal], 1, { lsb: 0 }), { operation: 'sahf' });
    return ctx.finish({ family: 'system', metadata: { operation: 'sahf', flagsWritten: ['SF', 'ZF', 'AF', 'PF', 'CF'] } });
  }

  for (let i = 0; i < operands.length; i += 1) {
    const op = operands[i];
    if (op?.type === 'register') {
      const val = ctx.readRegister(op);
      if (val) { inputs.push(val); registersRead.push(op.register.physicalId); }
    } else if (op?.type === 'immediate') {
      inputs.push(ctx.constant(Number(op.widthBits || op.encodedWidthBits || 8), op.value));
    } else if (op?.type === 'memory') {
      const addr = x86EffectiveAddressExpression(ctx.instruction, op);
      const width = Number(op.widthBits || 32);
      if (addr) {
        inputs.push(ctx.readMemory(addr.expression, width, { space: addr.space, metadata: { ...addr.metadata, operation: family } }));
        memoryReads.push({ space: addr.space, addressExpr: addr.expression, widthBits: width, endian: 'little' });
        faults.push(...x86MemoryFaults('read', width));
        for (const reg of [op.memory?.base, op.memory?.index]) {
          if (reg?.physicalId) registersRead.push(reg.physicalId);
        }
      }
    }
  }

  for (const reg of ctx.instruction.detail?.implicitReads || []) {
    const op = x86RegisterOperand(reg.id);
    if (op) {
      const val = ctx.readRegister(op);
      if (val) { inputs.push(val); registersRead.push(reg.physicalId); }
    }
  }

  const destOperands = [];
  for (let i = 0; i < operands.length; i += 1) {
    const op = operands[i];
    if (op?.type === 'register' && (i === 0 || ['rdfsbase', 'rdgsbase', 'rdpid', 'rdpkru', 'rdpmc', 'rdmsr', 'rdsspd', 'rdsspq', 'smsw', 'sldt', 'str', 'lar', 'lsl', 'vmread'].includes(family))) {
      destOperands.push(op);
    }
  }
  for (const reg of ctx.instruction.detail?.implicitWrites || []) {
    const op = x86RegisterOperand(reg.id);
    if (op) destOperands.push(op);
  }

  const outputWidths = destOperands.map((d) => Number(d.widthBits || d.register?.viewBits || 32));
  const outputs = ctx.intrinsic(`x86.system.${family}`, inputs, outputWidths, {
    registersRead: [...new Set(registersRead)].sort(),
    registersWritten: [...new Set(destOperands.filter((d) => d.type === 'register').map((d) => d.register.physicalId))].sort(),
    memoryRead: memoryReads.length ? { scope: 'accesses', accesses: memoryReads } : { scope: 'none' },
    memoryWrite: memoryWrites.length ? { scope: 'accesses', accesses: memoryWrites } : { scope: 'none' },
    determinism: 'input-dependent',
    symbolicDetail: 'summary-only',
    metadata: { operation: family, systemPrivileged: true, exactArchitecturalSummary: true },
  });

  for (let i = 0; i < destOperands.length; i += 1) {
    const dest = destOperands[i];
    if (dest?.type === 'register') {
      ctx.writeRegister(dest, outputs[i]);
    }
  }

  if (['lar', 'lsl', 'verr', 'verw', 'xtest'].includes(family)) {
    ctx.writeFlag('ZF', ctx.constant(1, 1n), { operation: family });
  }

  return ctx.finish({
    family: 'system',
    possibleFaults: faults,
    metadata: { operation: family, systemPrivileged: true },
  });
}

export function liftX86SystemEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  const knownSystem = [...FENCES, ...LIVE_PRIVILEGED, ...SHARED_ALIAS_PRIVILEGED, ...Object.keys(SIMPLE_FLAG_CONTROLS), 'pause', 'cpuid', 'rdtsc', 'rdtscp', 'syscall', 'sysret', 'sysretq'].includes(family);
  if (!knownSystem && !EXTENDED_SYSTEM_NAMES.has(family)) return null;
  const ctx = createX86EffectContext(instruction, context);

  if (SIMPLE_FLAG_CONTROLS[family]) return liftSimpleFlagControl(ctx, family);
  if (FENCES.has(family)) return liftFence(ctx, family);
  if (family === 'pause') {
    if (!pauseEncodingMatches(ctx.instruction)) {
      return ctx.partial('x86-pause-prefix-evidence-unmodelled', ['faults','other'], {
        detail:systemHiddenState('pause', ['cross-vendor-prefix-validity']),
        metadata:{ family:'system', operation:'pause', encodingValidated:false },
      });
    }
    return ctx.finish({
      family:'system',
      statePreservation:{ proven:true, reason:'x86-pause-has-no-architectural-register-memory-or-flag-state-mutation' },
      metadata:{ operation:'pause', microarchitecturalHintOnly:true },
    });
  }
  if (family === 'cpuid') return liftCpuid(ctx);
  if (family === 'rdtsc' || family === 'rdtscp') return liftTimestamp(ctx, family);
  if (family === 'syscall') return liftSyscall(ctx);
  if (family === 'sysret' || family === 'sysretq') return liftSysret(ctx, family);
  if (family === 'cli' || family === 'sti') return liftCliSti(ctx, family);
  if (family === 'hlt') return liftHlt(ctx);
  if (family === 'invd' || family === 'wbinvd') return liftCacheControl(ctx, family);
  if (family === 'swapgs') return liftSwapgs(ctx);
  if (family === 'lgdt' || family === 'lidt') return liftDescriptorTable(ctx, family);
  if (family === 'lldt' || family === 'ltr') return liftTaskOrLdt(ctx, family);

  if (SHARED_ALIAS_PRIVILEGED.has(family)) {
    return ctx.partial(`x86-${family}-decoder-family-alias-shared-dependency`, ['registers','faults','other'], {
      detail:systemHiddenState(family, ['deployed Capstone emits MOV for control/debug-register encodings; index/integer ownership is outside this component']),
      possibleFaults:[privilegeFault(family)],
      metadata:{ family:'system', operation:family, treatedAsNop:false, privileged:true, sharedDependencyRequired:true },
    });
  }

  if (EXTENDED_SYSTEM_NAMES.has(family)) return liftExtendedSystem(ctx, family);
  return null;
}
