import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../../../semantics/effects/index.js';

const ARCHITECTURE_ID = 'arm64';
const MODE = 'a64';

const BARRIERS = new Set(['dmb','dsb','isb']);
const WAITS_AND_EVENTS = new Set(['yield','wfe','wfi','sev','sevl']);
const TRAPS = new Set(['svc','hvc','smc','brk','hlt']);
const MAINTENANCE = new Set(['dc','ic','tlbi']);
const ARM64E_ONLY = /^(?:paci|pacd|auti|autd|xpac|retaa|retab|braa|brab|blraa|blrab)/;

const COMMON_READABLE_SYSREGS = new Set([
  'tpidr_el0','tpidrro_el0','cntvct_el0','cntpct_el0','cntfrq_el0',
  'fpcr','fpsr','nzcv','currentel','daif','spsel',
]);
const COMMON_WRITABLE_SYSREGS = new Set([
  'tpidr_el0','fpcr','fpsr','nzcv','daif','spsel',
]);

// An exception or implementation-defined system operation crosses an opaque
// architectural environment boundary.  Exact-with-intrinsic is honest only
// when that boundary carries the complete conservative footprint; it must not
// silently preserve registers or address spaces that firmware, an exception
// handler, or implementation-defined maintenance state may observe or change.
const ENVIRONMENT_REGISTERS = Object.freeze([
  ...Array.from({ length:31 }, (_unused, index) => `x${index}`),
  'sp',
  ...Array.from({ length:32 }, (_unused, index) => `v${index}`),
  'NZCV.N','NZCV.Z','NZCV.C','NZCV.V','fpcr','fpsr','pstate',
  'sys:arm64.execution-environment',
]);
const ENVIRONMENT_SPACES = Object.freeze(['code','io','memory','tls']);
const ENVIRONMENT_STATE = 'sys:arm64.execution-environment';

export const ARM64_SYSTEM_EFFECT_MNEMONICS = Object.freeze(new Set([
  'nop', ...BARRIERS, ...WAITS_AND_EVENTS, 'clrex', 'bti', ...TRAPS,
  'mrs','msr', ...MAINTENANCE, 'sys','eret','hint',
]));

function mnemonicOf(instruction) {
  return String(instruction?.mnemonic || '').trim().toLowerCase();
}
function operandsOf(instruction) {
  if (Array.isArray(instruction?.ops)) return instruction.ops;
  if (Array.isArray(instruction?.parsed)) return instruction.parsed;
  if (Array.isArray(instruction?.operandsParsed)) return instruction.operandsParsed;
  return [];
}
function instructionIdOf(instruction, context) {
  const id = instruction?.instructionId ?? context?.instructionId;
  if (!id) throw new TypeError('arm64-system-machine-effects-instruction-id-required');
  return String(id);
}
function originOf(instruction, context, instructionId) {
  return instruction?.origin ?? context?.origin ?? { instructionIds:[instructionId] };
}
function bundle(instruction, context, fields) {
  const instructionId = instructionIdOf(instruction, context);
  return createMachineEffectBundle({
    instructionId,
    architectureId:ARCHITECTURE_ID,
    mode:MODE,
    operations:fields.operations,
    controlEffect:fields.controlEffect || { kind:'fallthrough' },
    possibleFaults:fields.possibleFaults || [],
    origin:originOf(instruction, context, instructionId),
    completeness:fields.completeness,
    ...(fields.unknownEffects ? { unknownEffects:fields.unknownEffects } : {}),
    ...(fields.statePreservation ? { statePreservation:fields.statePreservation } : {}),
    metadata:{ family:'arm64-system', mnemonic:mnemonicOf(instruction), ...(fields.metadata || {}) },
  }, context?.machineEffectsOptions || {});
}
function partial(instruction, context, reason, categories, operations = [], controlEffect = {kind:'fallthrough'}, possibleFaults = []) {
  return bundle(instruction, context, {
    operations:[...operations, createMachineOperation({ kind:'unknown', reason, categories })],
    controlEffect,
    possibleFaults,
    completeness:'partial',
    unknownEffects:{ categories, reason },
  });
}
function temp(id, type) {
  return createTemporaryValue(id, type);
}
function gpId(op) {
  if (op?.k !== 'reg' || op.cls !== 'gp') return null;
  return `x${op.num}`;
}
function isGpDestination(op) {
  return op?.k === 'reg' && (op.cls === 'gp' || op.cls === 'zr');
}
function gpRead(operations, op, id) {
  if (op?.k === 'reg' && op.cls === 'zr') return createBitVectorValue(Number(op.bits || 64), 0n);
  const regId = gpId(op);
  if (!regId) return null;
  const width = Number(op.bits || 64);
  const value = temp(id, createBitVectorValue(width));
  operations.push(createMachineOperation({
    kind:'register-read',
    register:createRegisterValue(regId, width, { view:String(op.text || regId).toLowerCase() }),
    value,
  }));
  return value;
}
function gpWrite(operations, op, value) {
  if (op?.k === 'reg' && op.cls === 'zr') return true;
  const regId = gpId(op);
  if (!regId) return false;
  const width = Number(op.bits || 64);
  operations.push(createMachineOperation({
    kind:'register-write',
    register:createRegisterValue(regId, width, { view:String(op.text || regId).toLowerCase() }),
    value,
  }));
  return true;
}
function sysRegText(op) {
  const text = String(op?.text || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_]*$/.test(text) ? text : null;
}
function sysRegId(name) {
  if (name === 'fpcr' || name === 'fpsr' || name === 'nzcv') return name;
  return `sys:${name}`;
}
function immediate(op) {
  if (op?.k !== 'imm' || op.value == null) return null;
  return createBitVectorValue(64, BigInt.asUintN(64, BigInt(op.value)));
}
function accessFault(systemRegister, access) {
  return {
    kind:'system-register-access-trap',
    condition:{ kind:'architectural-access-check', systemRegister, access },
  };
}
function completeIntrinsic({ id, inputs = [], outputs = [], registersRead = [], registersWritten = [], memoryRead = {scope:'none'}, memoryWrite = {scope:'none'}, controlEffects = [], determinism = 'deterministic', symbolicDetail = 'summary-only', metadata }) {
  return createMachineOperation({
    kind:'intrinsic',
    intrinsicId:id,
    effectSummary:createIntrinsicEffectSummary({
      inputs, outputs, registersRead, registersWritten, memoryRead, memoryWrite,
      controlEffects, determinism, symbolicDetail,
    }),
    ...(metadata ? { metadata } : {}),
  });
}
function environmentIntrinsic({
  id,
  inputs = [],
  outputs = [],
  registersRead = [],
  registersWritten = [],
  controlEffects = [],
  metadata = {},
  memory = false,
  completeEnvironment = false,
}) {
  const environmentRegisters = completeEnvironment ? ENVIRONMENT_REGISTERS : [ENVIRONMENT_STATE];
  return completeIntrinsic({
    id,
    inputs,
    outputs,
    registersRead:[...environmentRegisters, ...registersRead],
    registersWritten:[...environmentRegisters, ...registersWritten],
    memoryRead:memory ? { scope:'all', spaces:ENVIRONMENT_SPACES } : { scope:'none' },
    memoryWrite:memory ? { scope:'all', spaces:ENVIRONMENT_SPACES } : { scope:'none' },
    controlEffects,
    determinism:'nondeterministic',
    symbolicDetail:'summary-only',
    metadata:{
      environmentBoundary:true,
      ...(completeEnvironment ? { preservation:'none-assumed', conservativeFullEnvironment:true } : { opaqueEnvironmentState:ENVIRONMENT_STATE }),
      ...metadata,
    },
  });
}
function nzcvFlagId(flag) { return `NZCV.${flag}`; }
function readNzcvFlags(operations, prefix) {
  return ['N','Z','C','V'].map((flag) => {
    const value=temp(`${prefix}:${flag}`,createBitVectorValue(1));
    operations.push(createMachineOperation({kind:'register-read',register:createRegisterValue(nzcvFlagId(flag),1),value,metadata:{architecturalState:'PSTATE.NZCV',flag}}));
    return value;
  });
}
function writeNzcvFlags(operations, packed, prefix) {
  const positions={N:31,Z:30,C:29,V:28};
  for (const flag of ['N','Z','C','V']) {
    const value=temp(`${prefix}:${flag}`,createBitVectorValue(1));
    operations.push(createMachineOperation({kind:'value',opcode:'extract-bit',inputs:[packed],outputs:[value],metadata:{bit:positions[flag],widthBits:64,architecturalState:'PSTATE.NZCV',flag}}));
    operations.push(createMachineOperation({kind:'register-write',register:createRegisterValue(nzcvFlagId(flag),1),value,metadata:{architecturalState:'PSTATE.NZCV',flag}}));
  }
}

function nop(instruction, context) {
  return bundle(instruction, context, {
    operations:[], completeness:'exact',
    statePreservation:{ proven:true, reason:'A64 NOP is architecturally state-preserving' },
  });
}

function barrier(instruction, context, mnemonic, ops) {
  const operand = ops[0];
  const scope = {
    architecture:'arm64',
    barrier:mnemonic,
    domain:String(operand?.text || instruction?.operands || 'sy').toLowerCase(),
    semantics:mnemonic === 'isb' ? 'instruction-synchronization' : mnemonic === 'dsb' ? 'data-synchronization' : 'data-memory-ordering',
  };
  return bundle(instruction, context, {
    operations:[createMachineOperation({ kind:'barrier', scope })],
    completeness:'exact',
    metadata:{ barrierScope:scope },
  });
}

function waitOrEvent(instruction, context, mnemonic) {
  const operation = completeIntrinsic({
    id:`arm64.system.${mnemonic}`,
    inputs:[], outputs:[], registersRead:[], registersWritten:[],
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[],
    determinism:(mnemonic === 'wfe' || mnemonic === 'wfi') ? 'nondeterministic' : 'deterministic',
    symbolicDetail:'summary-only',
    metadata:{ architecturalEffect:mnemonic === 'sev' || mnemonic === 'sevl' ? 'event-signal' : mnemonic === 'yield' ? 'scheduling-hint' : 'wait' },
  });
  return bundle(instruction, context, { operations:[operation], completeness:'exact-with-intrinsic' });
}

const EXCLUSIVE_MONITOR_STATE = Object.freeze([
  ['arm64.exclusive.valid', 1],
  ['arm64.exclusive.address', 64],
  ['arm64.exclusive.size', 16],
  ['arm64.exclusive.token', 64],
]);
function readExclusiveMonitor(operations) {
  return EXCLUSIVE_MONITOR_STATE.map(([registerId,bits]) => {
    const value = temp(`clrex:${registerId}`, createBitVectorValue(bits));
    operations.push(createMachineOperation({
      kind:'register-read', register:createRegisterValue(registerId,bits,{view:registerId}), value,
      metadata:{ architecture:'arm64', purpose:'exclusive-monitor-state' },
    }));
    return value;
  });
}
function clearExclusiveMonitor(operations, token) {
  const values = [createBitVectorValue(1,0n), createBitVectorValue(64,0n), createBitVectorValue(16,0n), token];
  EXCLUSIVE_MONITOR_STATE.forEach(([registerId,bits], index) => operations.push(createMachineOperation({
    kind:'register-write', register:createRegisterValue(registerId,bits,{view:registerId}), value:values[index],
    metadata:{ architecture:'arm64', purpose:'exclusive-monitor-state', transition:'clear' },
  })));
}

function clrex(instruction, context, ops) {
  const operand = ops[0];
  let imm = null;
  if (operand != null) {
    if (operand?.k !== 'imm' || operand.value == null) {
      return partial(instruction, context, 'clrex-immediate-unavailable', ['other']);
    }
    const value = BigInt(operand.value);
    if (value < 0n || value > 0xfn) {
      return partial(instruction, context, 'clrex-imm4-out-of-range', ['other']);
    }
    imm = createBitVectorValue(64, value);
  }
  const operations = [];
  const monitorState = readExclusiveMonitor(operations);
  const nextToken = temp('clrex:next-monitor-token', createBitVectorValue(64));
  const operation = completeIntrinsic({
    id:'arm64.system.clrex',
    inputs:[...monitorState, ...(imm ? [imm] : [])], outputs:[nextToken],
    registersRead:EXCLUSIVE_MONITOR_STATE.map(([id]) => id),
    registersWritten:EXCLUSIVE_MONITOR_STATE.map(([id]) => id),
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[],
    determinism:'deterministic', symbolicDetail:'summary-only',
    metadata:{ architecturalStateWritten:'local-exclusive-monitor', immediatePresent:!!imm },
  });
  operations.push(operation);
  clearExclusiveMonitor(operations, nextToken);
  return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic' });
}

function bti(instruction, context, ops) {
  const operations = [];
  const btype = temp('bti:btype', createBitVectorValue(2));
  operations.push(createMachineOperation({
    kind:'register-read', register:createRegisterValue('pstate.btype', 2), value:btype,
  }));
  const operation = completeIntrinsic({
    id:'arm64.system.bti', inputs:[btype], outputs:[], registersRead:['pstate.btype'], registersWritten:[],
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[], determinism:'input-dependent', symbolicDetail:'summary-only',
    metadata:{ landingPadKind:String(ops[0]?.text || instruction?.operands || '').toLowerCase() || 'encoded' },
  });
  operations.push(operation);
  return bundle(instruction, context, {
    operations,
    possibleFaults:[{ kind:'branch-target-exception', condition:{ kind:'bti-compatibility-check' } }],
    completeness:'exact-with-intrinsic',
  });
}

function trap(instruction, context, mnemonic, ops) {
  const operand = ops[0];
  if (operand?.k !== 'imm' || operand.value == null) {
    return partial(instruction, context, `${mnemonic}-immediate-unavailable`, ['control','faults','other']);
  }
  const immediateValue = BigInt(operand.value);
  if (immediateValue < 0n || immediateValue > 0xffffn) {
    return partial(instruction, context, `${mnemonic}-imm16-out-of-range`, ['control','faults','other']);
  }
  const imm = createBitVectorValue(64, immediateValue);
  const inputs = [imm];
  const controlEffect = { kind:'trap', reason:`arm64-${mnemonic}` };
  const operation = environmentIntrinsic({
    id:`arm64.environment.${mnemonic}`,
    inputs,
    controlEffects:[controlEffect],
    memory:true,
    completeEnvironment:true,
    metadata:{ immediate:operand.value, exceptionEntry:true },
  });
  return bundle(instruction, context, {
    operations:[operation], controlEffect, completeness:'exact-with-intrinsic',
    metadata:{ environmentBoundary:true, environmentFootprintComplete:true },
  });
}

function mrs(instruction, context, ops) {
  const dst = ops[0];
  const sys = sysRegText(ops[1]);
  if (!isGpDestination(dst) || !sys) {
    return partial(instruction, context, 'mrs-operands-or-system-register-unavailable', ['registers','faults','other']);
  }
  const operations = [];
  const result = temp(`mrs:${sys}:result`, createBitVectorValue(64));
  if (sys === 'nzcv') {
    const flags=readNzcvFlags(operations,'mrs:nzcv');
    operations.push(createMachineOperation({kind:'value',opcode:'arm64.pack-nzcv',inputs:flags,outputs:[result],metadata:{bitPositions:{N:31,Z:30,C:29,V:28},otherBits:'read-as-zero'}}));
    gpWrite(operations,dst,result);
    const fault=accessFault(sys,'read');
    return bundle(instruction,context,{operations,possibleFaults:[fault],completeness:'exact',metadata:{systemRegister:sys,access:'read',canonicalState:'PSTATE.NZCV'}});
  }
  const operation = completeIntrinsic({
    id:`arm64.system.mrs.${sys}`,
    inputs:[], outputs:[result], registersRead:[sysRegId(sys)], registersWritten:gpId(dst) ? [gpId(dst)] : [],
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[],
    determinism:(sys === 'cntvct_el0' || sys === 'cntpct_el0') ? 'nondeterministic' : 'input-dependent',
    symbolicDetail:'summary-only',
    metadata:{ systemRegister:sys, transferWidthBits:64 },
  });
  operations.push(operation);
  gpWrite(operations, dst, result);
  const fault = accessFault(sys, 'read');
  if (COMMON_READABLE_SYSREGS.has(sys)) {
    return bundle(instruction, context, {
      operations, possibleFaults:[fault], completeness:'exact-with-intrinsic', metadata:{ systemRegister:sys, access:'read' },
    });
  }
  operations[0] = environmentIntrinsic({
    id:`arm64.environment.mrs.${sys}`,
    outputs:[result],
    metadata:{ systemRegister:sys, access:'read', implementationDefined:true },
  });
  return bundle(instruction, context, {
    operations, possibleFaults:[fault], completeness:'exact-with-intrinsic',
    metadata:{ systemRegister:sys, access:'read', environmentBoundary:true, environmentFootprintComplete:true },
  });
}

function msr(instruction, context, ops) {
  const sys = sysRegText(ops[0]);
  const src = ops[1];
  if (!sys) return partial(instruction, context, 'msr-system-register-unavailable', ['registers','faults','other']);
  const operations = [];
  let input = gpRead(operations, src, `msr:${sys}:src`);
  if (!input) input = immediate(src);
  if (!input) return partial(instruction, context, `msr-source-unavailable:${sys}`, ['registers','faults','other'], operations);
  const reads = gpId(src) ? [gpId(src)] : [];
  if (sys === 'nzcv') {
    writeNzcvFlags(operations,input,'msr:nzcv');
    const fault=accessFault(sys,'write');
    return bundle(instruction,context,{operations,possibleFaults:[fault],completeness:'exact',metadata:{systemRegister:sys,access:'write',canonicalState:'PSTATE.NZCV'}});
  }
  const operation = completeIntrinsic({
    id:`arm64.system.msr.${sys}`,
    inputs:[input], outputs:[], registersRead:reads, registersWritten:[sysRegId(sys)],
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[],
    determinism:'deterministic', symbolicDetail:'summary-only',
    metadata:{ systemRegister:sys, sourceKind:gpId(src) ? 'register' : 'immediate', architecturalMasking:'intrinsic' },
  });
  operations.push(operation);
  const fault = accessFault(sys, 'write');
  if (COMMON_WRITABLE_SYSREGS.has(sys)) {
    return bundle(instruction, context, {
      operations, possibleFaults:[fault], completeness:'exact-with-intrinsic', metadata:{ systemRegister:sys, access:'write' },
    });
  }
  operations[operations.length - 1] = environmentIntrinsic({
    id:`arm64.environment.msr.${sys}`,
    inputs:[input],
    metadata:{ systemRegister:sys, access:'write', implementationDefined:true },
  });
  return bundle(instruction, context, {
    operations, possibleFaults:[fault], completeness:'exact-with-intrinsic',
    metadata:{ systemRegister:sys, access:'write', environmentBoundary:true, environmentFootprintComplete:true },
  });
}

function maintenance(instruction, context, mnemonic, ops) {
  const operations = [];
  const registerOperands = ops.filter((op) => gpId(op));
  const inputs = registerOperands.map((op, index) => gpRead(operations, op, `${mnemonic}:src${index}`)).filter(Boolean);
  const operation = environmentIntrinsic({
    id:`arm64.environment.${mnemonic}`,
    inputs,
    registersRead:registerOperands.map(gpId),
    memory:mnemonic === 'dc',
    metadata:{ operation:String(ops[0]?.text || instruction?.operands || '').toLowerCase(), maintenance:true },
  });
  operations.push(operation);
  return bundle(instruction, context, {
    operations,
    possibleFaults:[{ kind:'system-instruction-trap', condition:{ kind:'architectural-access-check', operation:mnemonic } }],
    completeness:'exact-with-intrinsic',
    metadata:{ environmentBoundary:true, environmentFootprintComplete:true, maintenance:true },
  });
}

function sys(instruction, context, ops) {
  const operations = [];
  const registerOperands = ops.filter((op) => gpId(op));
  const inputs = registerOperands.map((op, index) => gpRead(operations, op, `sys:src${index}`)).filter(Boolean);
  const operation = environmentIntrinsic({
    id:'arm64.environment.sys', inputs,
    registersRead:registerOperands.map(gpId),
    memory:true,
    completeEnvironment:true,
    metadata:{ encodingOperands:ops.map((op) => op?.text ?? (op?.value != null ? String(op.value) : null)) },
  });
  operations.push(operation);
  return bundle(instruction, context, {
    operations,
    possibleFaults:[{ kind:'system-instruction-trap', condition:{ kind:'architectural-access-check', operation:'sys' } }],
    completeness:'exact-with-intrinsic',
    metadata:{ environmentBoundary:true, environmentFootprintComplete:true },
  });
}

function eret(instruction, context) {
  const controlEffect = { kind:'indirect', target:{ kind:'exception-return-address' }, reason:'exception-return' };
  const operation = environmentIntrinsic({
    id:'arm64.environment.eret',
    controlEffects:[controlEffect],
    memory:true,
    completeEnvironment:true,
    metadata:{ exceptionReturn:true },
  });
  return bundle(instruction, context, {
    operations:[operation], controlEffect,
    possibleFaults:[{ kind:'illegal-exception-return', condition:{ kind:'architectural-exception-return-check' } }],
    completeness:'exact-with-intrinsic',
    metadata:{ environmentBoundary:true, environmentFootprintComplete:true },
  });
}

function genericHint(instruction, context, ops) {
  const operand = ops[0];
  if (operand?.k !== 'imm' || operand.value == null) {
    return partial(instruction, context, 'generic-hint-immediate-unavailable', ['other']);
  }
  const value = BigInt(operand.value);
  if (value < 0n || value > 0x7fn) {
    return partial(instruction, context, 'generic-hint-imm7-out-of-range', ['other']);
  }
  const imm = createBitVectorValue(64, value);
  const operation = environmentIntrinsic({
    id:'arm64.environment.hint', inputs:[imm],
    metadata:{ hintImmediate:String(imm.value) },
  });
  return bundle(instruction, context, {
    operations:[operation], completeness:'exact-with-intrinsic',
    metadata:{ environmentBoundary:true, environmentFootprintComplete:true },
  });
}

export function liftArm64SystemEffects(instruction, context = {}) {
  const mnemonic = mnemonicOf(instruction);
  const ops = operandsOf(instruction);

  if (!mnemonic || ARM64E_ONLY.test(mnemonic)) return null;
  if (mnemonic === 'nop') return nop(instruction, context);
  if (BARRIERS.has(mnemonic)) return barrier(instruction, context, mnemonic, ops);
  if (WAITS_AND_EVENTS.has(mnemonic)) return waitOrEvent(instruction, context, mnemonic);
  if (mnemonic === 'clrex') return clrex(instruction, context, ops);
  if (mnemonic === 'bti') return bti(instruction, context, ops);
  if (TRAPS.has(mnemonic)) return trap(instruction, context, mnemonic, ops);
  if (mnemonic === 'mrs') return mrs(instruction, context, ops);
  if (mnemonic === 'msr') return msr(instruction, context, ops);
  if (MAINTENANCE.has(mnemonic)) return maintenance(instruction, context, mnemonic, ops);
  if (mnemonic === 'sys') return sys(instruction, context, ops);
  if (mnemonic === 'eret') return eret(instruction, context);
  if (mnemonic === 'hint') return genericHint(instruction, context, ops);

  return null;
}

export const arm64SystemMachineEffects = liftArm64SystemEffects;