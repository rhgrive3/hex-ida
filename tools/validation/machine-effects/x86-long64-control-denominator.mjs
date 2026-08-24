export const X86_LONG64_CONTROL_DENOMINATOR_SCHEMA = 'x86-long64-control-denominator/v1';
export const X86_LONG64_CONTROL_DENOMINATOR_ID = 'x86_64:long-64:control-encoding-discriminators:v1';

const CC = Object.freeze([
  ['jo',0x0,['OF']],['jno',0x1,['OF']],['jb',0x2,['CF']],['jae',0x3,['CF']],
  ['je',0x4,['ZF']],['jne',0x5,['ZF']],['jbe',0x6,['CF','ZF']],['ja',0x7,['CF','ZF']],
  ['js',0x8,['SF']],['jns',0x9,['SF']],['jp',0xa,['PF']],['jnp',0xb,['PF']],
  ['jl',0xc,['SF','OF']],['jge',0xd,['SF','OF']],['jle',0xe,['ZF','SF','OF']],['jg',0xf,['ZF','SF','OF']],
]);

function item(id, bytes, expected) { return Object.freeze({ id, bytes:Uint8Array.from(bytes), expected:Object.freeze(expected) }); }
function rel32(opcode, prefix = []) { return [...prefix,opcode,0,0,0,0]; }

export function* x86Long64ControlEncodingCases() {
  yield item('jmp:rel8',[0xeb,0],{ family:'jmp', controlKind:'branch', direct:true, targetFault:true });
  yield item('jmp:rel32',rel32(0xe9),{ family:'jmp', controlKind:'branch', direct:true, targetFault:true });
  yield item('jmp:r64',[0xff,0xe0],{ family:'jmp', controlKind:'indirect', direct:false, registerReads:['rax'], targetFault:true });
  yield item('jmp:rex-r8',[0x41,0xff,0xe0],{ family:'jmp', controlKind:'indirect', direct:false, registerReads:['r8'], targetFault:true, rex:true });
  yield item('jmp:m64',[0xff,0x20],{ family:'jmp', controlKind:'indirect', direct:false, memoryReads:1, targetFault:true });
  yield item('jmp:a32-m64',[0x67,0xff,0x20],{ family:'jmp', controlKind:'indirect', direct:false, memoryReads:1, addressSizeBits:32, targetFault:true });

  yield item('call:rel32',rel32(0xe8),{ family:'call', controlKind:'call', direct:true, rspDelta:-8, memoryWrites:1, targetFault:true });
  yield item('call:r64',[0xff,0xd0],{ family:'call', controlKind:'call', direct:false, registerReads:['rax'], rspDelta:-8, memoryWrites:1, targetFault:true });
  yield item('call:rex-r8',[0x41,0xff,0xd0],{ family:'call', controlKind:'call', direct:false, registerReads:['r8'], rspDelta:-8, memoryWrites:1, targetFault:true, rex:true });
  yield item('call:m64',[0xff,0x10],{ family:'call', controlKind:'call', direct:false, memoryReads:1, rspDelta:-8, memoryWrites:1, targetFault:true });
  yield item('call:a32-m64',[0x67,0xff,0x10],{ family:'call', controlKind:'call', direct:false, memoryReads:1, addressSizeBits:32, rspDelta:-8, memoryWrites:1, targetFault:true });

  yield item('ret',[0xc3],{ family:'ret', controlKind:'return', rspDelta:8, memoryReads:1, targetFault:true });
  yield item('ret:imm16',[0xc2,0x18,0],{ family:'ret', controlKind:'return', rspDelta:32, memoryReads:1, immediateAdjustment:24, targetFault:true });
  yield item('trap:ud2',[0x0f,0x0b],{ family:'ud2', controlKind:'trap', faultKind:'invalid-opcode' });
  yield item('trap:int3',[0xcc],{ family:'int3', controlKind:'trap', faultKind:'breakpoint-trap' });

  for (const [family,cc,flags] of CC) {
    yield item(`${family}:short`,[0x70|cc,0],{ family, controlKind:'conditional-branch', flagReads:flags, targetFault:true });
    yield item(`${family}:near`,[0x0f,0x80|cc,0,0,0,0],{ family, controlKind:'conditional-branch', flagReads:flags, targetFault:true });
  }

  yield item('jrcxz:a64',[0xe3,0],{ family:'jrcxz', controlKind:'conditional-branch', countRegister:'rcx', targetFault:true });
  yield item('jecxz:a32',[0x67,0xe3,0],{ family:'jecxz', controlKind:'conditional-branch', countRegister:'ecx', addressSizeBits:32, targetFault:true });
  for (const [family,opcode,flags] of [['loop',0xe2,[]],['loope',0xe1,['ZF']],['loopne',0xe0,['ZF']]]) {
    yield item(`${family}:a64`,[opcode,0],{ family, controlKind:'conditional-branch', countRegister:'rcx', countWrite:true, flagReads:flags, targetFault:true });
    yield item(`${family}:a32`,[0x67,opcode,0],{ family, controlKind:'conditional-branch', countRegister:'ecx', countWrite:true, flagReads:flags, addressSizeBits:32, targetFault:true });
  }

  // Prefix-state witnesses are semantic dimensions, not a production registry.
  // 66 is ignored for near-branch operand size in 64-bit mode; 67 changes only
  // address-size-dependent behavior; F2 is BND only when MPX is enabled.
  yield item('prefix:66-call',rel32(0xe8,[0x66]),{ family:'call', controlKind:'call', direct:true, rspDelta:-8, memoryWrites:1, targetFault:true, prefix:0x66 });
  yield item('prefix:67-call',rel32(0xe8,[0x67]),{ family:'call', controlKind:'call', direct:true, rspDelta:-8, memoryWrites:1, targetFault:true, prefix:0x67, addressSizeBits:32 });
  yield item('prefix:f2-call',rel32(0xe8,[0xf2]),{ family:'call', controlKind:'call', direct:true, rspDelta:-8, memoryWrites:1, targetFault:true, prefix:0xf2 });
  yield item('prefix:f2-jmp',rel32(0xe9,[0xf2]),{ family:'jmp', controlKind:'branch', direct:true, targetFault:true, prefix:0xf2 });
  yield item('prefix:f2-je',[0xf2,0x74,0],{ family:'je', controlKind:'conditional-branch', flagReads:['ZF'], targetFault:true, prefix:0xf2 });
  yield item('prefix:f2-ret',[0xf2,0xc3],{ family:'ret', controlKind:'return', rspDelta:8, memoryReads:1, targetFault:true, prefix:0xf2 });
  yield item('prefix:f3-ret',[0xf3,0xc3],{ family:'ret', controlKind:'return', rspDelta:8, memoryReads:1, targetFault:true, prefix:0xf3 });
  yield item('prefix:2e-je',[0x2e,0x74,0],{ family:'je', controlKind:'conditional-branch', flagReads:['ZF'], targetFault:true, prefix:0x2e });
}

export const X86_LONG64_CONTROL_ALIAS_CASES = Object.freeze([
  Object.freeze({ alias:'jz', canonical:'je', bytes:Uint8Array.from([0x74,0]), conditionCode:'z', flagReads:Object.freeze(['ZF']) }),
  Object.freeze({ alias:'jnz', canonical:'jne', bytes:Uint8Array.from([0x75,0]), conditionCode:'nz', flagReads:Object.freeze(['ZF']) }),
  Object.freeze({ alias:'jnb', canonical:'jae', bytes:Uint8Array.from([0x73,0]), conditionCode:'nb', flagReads:Object.freeze(['CF']) }),
  Object.freeze({ alias:'jnae', canonical:'jb', bytes:Uint8Array.from([0x72,0]), conditionCode:'nae', flagReads:Object.freeze(['CF']) }),
  Object.freeze({ alias:'jna', canonical:'jbe', bytes:Uint8Array.from([0x76,0]), conditionCode:'na', flagReads:Object.freeze(['CF','ZF']) }),
  Object.freeze({ alias:'jnbe', canonical:'ja', bytes:Uint8Array.from([0x77,0]), conditionCode:'nbe', flagReads:Object.freeze(['CF','ZF']) }),
  Object.freeze({ alias:'jpe', canonical:'jp', bytes:Uint8Array.from([0x7a,0]), conditionCode:'pe', flagReads:Object.freeze(['PF']) }),
  Object.freeze({ alias:'jpo', canonical:'jnp', bytes:Uint8Array.from([0x7b,0]), conditionCode:'po', flagReads:Object.freeze(['PF']) }),
  Object.freeze({ alias:'jnge', canonical:'jl', bytes:Uint8Array.from([0x7c,0]), conditionCode:'nge', flagReads:Object.freeze(['SF','OF']) }),
  Object.freeze({ alias:'jnl', canonical:'jge', bytes:Uint8Array.from([0x7d,0]), conditionCode:'nl', flagReads:Object.freeze(['SF','OF']) }),
  Object.freeze({ alias:'jng', canonical:'jle', bytes:Uint8Array.from([0x7e,0]), conditionCode:'ng', flagReads:Object.freeze(['ZF','SF','OF']) }),
  Object.freeze({ alias:'jnle', canonical:'jg', bytes:Uint8Array.from([0x7f,0]), conditionCode:'nle', flagReads:Object.freeze(['ZF','SF','OF']) }),
  Object.freeze({ alias:'loopz', canonical:'loope', bytes:Uint8Array.from([0xe1,0]), conditionCode:null, flagReads:Object.freeze(['ZF']) }),
  Object.freeze({ alias:'loopnz', canonical:'loopne', bytes:Uint8Array.from([0xe0,0]), conditionCode:null, flagReads:Object.freeze(['ZF']) }),
]);

export function x86Long64ControlDenominatorIdentity() {
  let encodingCaseCount = 0;
  for (const _item of x86Long64ControlEncodingCases()) encodingCaseCount++;
  return Object.freeze({
    schemaVersion:X86_LONG64_CONTROL_DENOMINATOR_SCHEMA,
    denominatorId:X86_LONG64_CONTROL_DENOMINATOR_ID,
    profileId:'x86_64:long-64',
    featureContract:'x86-long64-feature-envelope/v1',
    featureState:Object.freeze({ cetShadowStackEnabled:false, cetIndirectBranchTrackingEnabled:false, mpxEnabled:false }),
    encodingCaseCount,
    conditionCount:CC.length,
    aliasCaseCount:X86_LONG64_CONTROL_ALIAS_CASES.length,
    dimensions:Object.freeze({
      opcodeFamilies:Object.freeze(['jmp','call','ret','jcc','jrcxz/jecxz','loop/loope/loopne','ud2','int3']),
      targetForms:Object.freeze(['relative','register-indirect','memory-indirect','stack-return']),
      addressSizes:Object.freeze([64,32]),
      prefixes:Object.freeze(['none','66','67','rex','f2','f3','segment-hint']),
      conditions:Object.freeze(CC.map(([family]) => family)),
      featureEnvelope:Object.freeze(['base-cet-off-mpx-off','cet-enabled-negative','mpx-enabled-negative','wrong-profile-negative']),
    }),
    oracleIds:Object.freeze([
      'intel-sdm-vol2-call-ret-jmp-jcc-loop-jcxz',
      'intel-sdm-vol1-cet-shadow-stack',
      'intel-sdm-vol1-mpx-bnd-bndpreserve',
      'deployed-capstone-5-x86-long64-detail',
    ]),
    selfOracle:false,
  });
}
