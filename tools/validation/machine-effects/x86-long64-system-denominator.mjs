export const X86_LONG64_SYSTEM_DENOMINATOR_SCHEMA = 'x86-long64-system-denominator/v1';
export const X86_LONG64_SYSTEM_DENOMINATOR_ID = 'x86_64:long-64:effect-family:system:v1';

const p = (id, bytes) => Object.freeze({ id, bytes:Object.freeze(bytes) });
const o = (id, bytes, prefixes = null) => Object.freeze({ id, bytes:Object.freeze(bytes), ...(prefixes ? { prefixes:Object.freeze(prefixes) } : {}) });

const PREFIX_NONE = p('none', []);
const PREFIX_67 = p('address-size-67', [0x67]);
const PREFIX_FS = p('segment-fs-64', [0x64]);
const PREFIX_GS = p('segment-gs-65', [0x65]);
const PREFIX_REX = p('rex-40-ignored', [0x40]);
const PREFIX_REXW = p('rex-w-48', [0x48]);
const CANONICAL_OR_REX = Object.freeze([PREFIX_NONE,PREFIX_REX]);
const MEMORY_PREFIXES = Object.freeze([PREFIX_NONE,PREFIX_67,PREFIX_FS,PREFIX_GS,PREFIX_REX]);

function row({ family, opcode, prefixes = CANONICAL_OR_REX, operands = [o('implicit-none',[])], privilege, environment, implicitState, effectClass }) {
  return Object.freeze({
    family,
    opcode:Object.freeze(opcode),
    prefixes:Object.freeze(prefixes),
    operands:Object.freeze(operands),
    privilege:Object.freeze(privilege),
    environment:Object.freeze(environment),
    implicitState:Object.freeze(implicitState),
    effectClass,
  });
}

const UNPRIVILEGED = Object.freeze(['architectural-user-or-kernel']);
const PRIVILEGED = Object.freeze(['cpl0-success','cpl-nonzero-#gp','virtualization-intercept']);
const NATIVE_OR_VM = Object.freeze(['native','virtualized-no-intercept','virtualized-intercept']);
const ORDER_STATE = Object.freeze(['x86-memory-order-state']);

export const X86_LONG64_SYSTEM_FAMILY_ROWS = Object.freeze([
  row({ family:'lfence', opcode:[0x0f,0xae,0xe8], prefixes:CANONICAL_OR_REX, privilege:UNPRIVILEGED, environment:['memory-ordering'], implicitState:ORDER_STATE, effectClass:'barrier' }),
  row({ family:'sfence', opcode:[0x0f,0xae,0xf8], prefixes:CANONICAL_OR_REX, privilege:UNPRIVILEGED, environment:['memory-ordering'], implicitState:ORDER_STATE, effectClass:'barrier' }),
  row({ family:'mfence', opcode:[0x0f,0xae,0xf0], prefixes:CANONICAL_OR_REX, privilege:UNPRIVILEGED, environment:['memory-ordering'], implicitState:ORDER_STATE, effectClass:'barrier' }),
  row({ family:'clc', opcode:[0xf8], privilege:UNPRIVILEGED, environment:['none'], implicitState:['RFLAGS.CF'], effectClass:'flag-control' }),
  row({ family:'stc', opcode:[0xf9], privilege:UNPRIVILEGED, environment:['none'], implicitState:['RFLAGS.CF'], effectClass:'flag-control' }),
  row({ family:'cmc', opcode:[0xf5], privilege:UNPRIVILEGED, environment:['none'], implicitState:['RFLAGS.CF'], effectClass:'flag-control' }),
  row({ family:'cld', opcode:[0xfc], privilege:UNPRIVILEGED, environment:['none'], implicitState:['RFLAGS.DF'], effectClass:'flag-control' }),
  row({ family:'std', opcode:[0xfd], privilege:UNPRIVILEGED, environment:['none'], implicitState:['RFLAGS.DF'], effectClass:'flag-control' }),
  row({ family:'pause', opcode:[0xf3,0x90], prefixes:[PREFIX_NONE], privilege:UNPRIVILEGED, environment:['microarchitectural-hint'], implicitState:['architectural-state-preserved'], effectClass:'state-preserving-hint' }),
  row({ family:'cpuid', opcode:[0x0f,0xa2], privilege:UNPRIVILEGED, environment:NATIVE_OR_VM, implicitState:['EAX.leaf','ECX.subleaf','processor-cpuid-environment','serialization-state'], effectClass:'environment-intrinsic' }),
  row({ family:'rdtsc', opcode:[0x0f,0x31], privilege:['CR4.TSD=0-any-CPL','CR4.TSD=1-CPL0','CR4.TSD=1-CPL>0-#GP'], environment:NATIVE_OR_VM, implicitState:['TSC','CR4.TSD','CPL'], effectClass:'environment-intrinsic' }),
  row({ family:'rdtscp', opcode:[0x0f,0x01,0xf9], privilege:['CR4.TSD=0-any-CPL','CR4.TSD=1-CPL0','CR4.TSD=1-CPL>0-#GP'], environment:['feature-present-native','feature-present-virtualized','feature-absent-#UD'], implicitState:['TSC','IA32_TSC_AUX','CR4.TSD','CPL','partial-order-state'], effectClass:'environment-intrinsic' }),
  row({ family:'syscall', opcode:[0x0f,0x05], privilege:['any-CPL-with-SCE-enabled-entry','entry-privilege-transition-derived-from-architectural-system-state'], environment:['IA32_EFER.SCE=1-legacy-entry','IA32_EFER.SCE=1-FRED-entry','virtualized-entry/intercept','IA32_EFER.SCE=0-#UD'], implicitState:['RIP','RFLAGS','RCX','R11','IA32_LSTAR','IA32_STAR','IA32_FMASK','IA32_EFER','CS/SS/CPL','CET/SSP/IA32_PL3_SSP','FRED-entry-state'], effectClass:'system-control-intrinsic' }),
  row({ family:'sysret', opcode:[0x0f,0x07], prefixes:CANONICAL_OR_REX, privilege:['valid-system-return-state','invalid-privilege/system-state-#GP'], environment:['native-CR4.FRED=0','virtualized-CR4.FRED=0','CR4.FRED=1-#UD'], implicitState:['RCX/ECX','R11','RFLAGS','IA32_STAR','IA32_EFER','CS/SS/CPL','CET/SSP/IA32_PL3_SSP','CR4.FRED'], effectClass:'system-control-intrinsic' }),
  row({ family:'sysretq', opcode:[0x0f,0x07], prefixes:[PREFIX_REXW], privilege:['valid-system-return-state','invalid-privilege/system-state-#GP'], environment:['native-CR4.FRED=0','virtualized-CR4.FRED=0','CR4.FRED=1-#UD'], implicitState:['RCX','R11','RFLAGS','IA32_STAR','IA32_EFER','CS/SS/CPL','CET/SSP/IA32_PL3_SSP','CR4.FRED'], effectClass:'system-control-intrinsic' }),
  row({ family:'cli', opcode:[0xfa], privilege:['CPL<=IOPL-IF-update','CPL>IOPL-virtual-interrupt-update','CPL>IOPL-#GP'], environment:['native','PVI','virtualized-intercept'], implicitState:['RFLAGS.IF','RFLAGS.VIF','RFLAGS.VIP','CPL','IOPL','CR4.PVI','locked-long-64-mode'], effectClass:'privileged-environment-intrinsic' }),
  row({ family:'sti', opcode:[0xfb], privilege:['CPL<=IOPL-IF-update','CPL>IOPL-virtual-interrupt-update','CPL>IOPL-VIP/#GP'], environment:['native','PVI','virtualized-intercept'], implicitState:['RFLAGS.IF','RFLAGS.VIF','RFLAGS.VIP','CPL','IOPL','CR4.PVI','interruptibility/shadow-state','locked-long-64-mode'], effectClass:'privileged-environment-intrinsic' }),
  row({ family:'hlt', opcode:[0xf4], privilege:PRIVILEGED, environment:['wake-event-dependent','virtualization-intercept'], implicitState:['CPL','processor-halt-state','interrupt/NMI/SMI/reset/debug wake conditions'], effectClass:'privileged-environment-intrinsic' }),
  row({ family:'invd', opcode:[0x0f,0x08], privilege:PRIVILEGED, environment:NATIVE_OR_VM, implicitState:['cache-state','CPL'], effectClass:'privileged-environment-intrinsic' }),
  row({ family:'wbinvd', opcode:[0x0f,0x09], prefixes:CANONICAL_OR_REX, privilege:PRIVILEGED, environment:NATIVE_OR_VM, implicitState:['cache-state','memory-writeback-state','CPL'], effectClass:'privileged-environment-intrinsic' }),
  row({ family:'swapgs', opcode:[0x0f,0x01,0xf8], privilege:PRIVILEGED, environment:['native','virtualized-intercept','Intel-CR4.FRED=1-#UD'], implicitState:['GS.base','IA32_KERNEL_GS_BASE','CPL','CR4.FRED/environment'], effectClass:'privileged-environment-intrinsic' }),
  row({ family:'lgdt', opcode:[0x0f,0x01], prefixes:MEMORY_PREFIXES, operands:[o('m80-base',[0x10]),o('m80-sib',[0x14,0x24]),o('m80-rm5-disp32',[0x15,0,0,0,0])], privilege:PRIVILEGED, environment:NATIVE_OR_VM, implicitState:['GDTR','CPL','explicit-memory-address'], effectClass:'privileged-memory-intrinsic' }),
  row({ family:'lidt', opcode:[0x0f,0x01], prefixes:MEMORY_PREFIXES, operands:[o('m80-base',[0x18]),o('m80-sib',[0x1c,0x24]),o('m80-rm5-disp32',[0x1d,0,0,0,0])], privilege:PRIVILEGED, environment:NATIVE_OR_VM, implicitState:['IDTR','CPL','explicit-memory-address'], effectClass:'privileged-memory-intrinsic' }),
  row({ family:'lldt', opcode:[0x0f,0x00], prefixes:MEMORY_PREFIXES, operands:[o('r16-ax',[0xd0],CANONICAL_OR_REX),o('m16-base',[0x10]),o('m16-sib',[0x14,0x24]),o('m16-rm5-disp32',[0x15,0,0,0,0])], privilege:PRIVILEGED, environment:NATIVE_OR_VM, implicitState:['LDTR-visible-selector','LDTR-hidden-descriptor-cache','GDT/LDT-descriptor-memory','CPL'], effectClass:'privileged-descriptor-intrinsic' }),
  row({ family:'ltr', opcode:[0x0f,0x00], prefixes:MEMORY_PREFIXES, operands:[o('r16-ax',[0xd8],CANONICAL_OR_REX),o('m16-base',[0x18]),o('m16-sib',[0x1c,0x24]),o('m16-rm5-disp32',[0x1d,0,0,0,0])], privilege:PRIVILEGED, environment:NATIVE_OR_VM, implicitState:['TR-visible-selector','TR-hidden-descriptor-cache','GDT-descriptor-memory','CPL'], effectClass:'privileged-descriptor-intrinsic' }),
]);

export const X86_LONG64_SYSTEM_SHARED_DEPENDENCIES = Object.freeze([
  Object.freeze({
    id:'mov-control-debug-register-family-alias',
    reason:'deployed Capstone emits MOV for 0F20/0F21/0F22/0F23 control/debug-register encodings; memory/integer ownership precedes system and the physical register contract does not model CR/DR state',
    requiredOwners:Object.freeze(['js/targets/architecture/x86_64/effects/index.js','js/targets/architecture/x86_64/effects/integer.js','js/targets/architecture/x86_64/registers-core.js']),
  }),
]);

export function* x86Long64SystemEncodingCases() {
  for (const family of X86_LONG64_SYSTEM_FAMILY_ROWS) {
    for (const operand of family.operands) {
      for (const prefix of operand.prefixes ?? family.prefixes) {
        yield Object.freeze({
          id:`${family.family}:${prefix.id}:${operand.id}`,
          family:family.family,
          bytes:Uint8Array.from([...prefix.bytes,...family.opcode,...operand.bytes]),
          opcode:Object.freeze(family.opcode),
          prefixDiscriminator:prefix.id,
          operandDiscriminator:operand.id,
          privilegeDiscriminators:family.privilege,
          environmentDiscriminators:family.environment,
          implicitState:family.implicitState,
          effectClass:family.effectClass,
        });
      }
    }
  }
}

let cached = null;
export function validateX86Long64SystemDenominator() {
  if (cached) return cached;
  const familyIds = X86_LONG64_SYSTEM_FAMILY_ROWS.map(({ family }) => family);
  if (new Set(familyIds).size !== familyIds.length) throw new Error('x86-system-denominator-family-duplicate');
  let encodingCaseCount = 0;
  for (const row of X86_LONG64_SYSTEM_FAMILY_ROWS) {
    for (const [field, values] of [['prefix',row.prefixes],['operand',row.operands],['privilege',row.privilege],['environment',row.environment],['implicit-state',row.implicitState]]) {
      if (!Array.isArray(values) || values.length === 0) throw new Error(`x86-system-denominator-${field}-missing:${row.family}`);
    }
    if (!Array.isArray(row.opcode) || row.opcode.length === 0) throw new Error(`x86-system-denominator-opcode-missing:${row.family}`);
    encodingCaseCount += row.operands.reduce((count, operand) => count + (operand.prefixes ?? row.prefixes).length, 0);
  }
  cached = Object.freeze({
    valid:true,
    schemaVersion:X86_LONG64_SYSTEM_DENOMINATOR_SCHEMA,
    denominatorId:X86_LONG64_SYSTEM_DENOMINATOR_ID,
    profileId:'x86_64:long-64',
    familyCount:X86_LONG64_SYSTEM_FAMILY_ROWS.length,
    encodingCaseCount,
    discriminatorDimensions:Object.freeze(['opcode/family','privilege','environment','prefix','operand/state','implicit-state']),
    quotientProof:Object.freeze({
      prefix:'one deployed-decoder representative per cross-vendor architecturally defined prefix class; Intel-reserved and AMD-undefined legacy-prefix combinations are excluded even when the decoder accepts them, while REX.W remains explicit for SYSRETQ',
      operandState:'register identity is quotient-equivalent under the common x86 register contract; base, SIB, and ModRM r/m=5 disp32 representatives cover distinct effective-address shapes, with address-size prefixes allowed to change the r/m=5 interpretation',
      environment:'runtime host values remain symbolic architectural inputs/outputs; only privilege/environment predicates and architectural trap alternatives are enumerated',
    }),
    oracleIds:Object.freeze([
      'intel-sdm-vol2-system-instruction-reference + intel-sdm-vol3-system-programming',
      'amd64-apm-vol2-system-programming + amd64-apm-vol3-general-purpose-and-system-instructions',
      'deployed-capstone-5-x86-long64-structured-decoder',
    ]),
    sharedDependencyRequired:X86_LONG64_SYSTEM_SHARED_DEPENDENCIES.length !== 0,
    sharedDependencies:X86_LONG64_SYSTEM_SHARED_DEPENDENCIES,
  });
  return cached;
}
