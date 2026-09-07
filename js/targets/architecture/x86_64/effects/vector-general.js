import { createMemoryAccess } from '../../../../semantics/effects/index.js';
import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';
import { physicalIds } from './extended-state-helpers.js';

const KNOWN_VECTOR_FAMILIES = new Set([
  'addpd','addps','addsd','addss','addsubpd','addsubps','aesdec','aesdeclast','aesenc','aesenclast','aesimc','aeskeygenassist',
  'andnpd','andnps','andpd','andps','blendpd','blendps','blendvpd','blendvps','cmppd','cmpps','cmpsd','cmpss','comisd','comiss',
  'cvtdq2pd','cvtdq2ps','cvtpd2dq','cvtpd2pi','cvtpd2ps','cvtpi2pd','cvtpi2ps','cvtps2dq','cvtps2pd','cvtps2pi','cvtsd2si','cvtsd2ss',
  'cvtsi2sd','cvtsi2ss','cvtss2sd','cvtss2si','cvttpd2dq','cvttpd2pi','cvttps2dq','cvttps2pi','cvttsd2si','cvttss2si','divpd','divps',
  'divsd','divss','dppd','dpps','extractps','extrq','gf2p8affineinvqb','gf2p8affineqb','gf2p8mulb','haddpd','haddps','hsubpd','hsubps','insertps','insertq',
  'kaddb','kaddd','kaddq','kaddw','kandb','kandd','kandnb','kandnd','kandnq','kandnw','kandq','kandw','kmovb','kmovd','kmovq','kmovw',
  'knotb','knotd','knotq','knotw','korb','kord','korq','kortestb','kortestd','kortestq','kortestw','korw','kshiftlb','kshiftld','kshiftlq',
  'kshiftlw','kshiftrb','kshiftrd','kshiftrq','kshiftrw','ktestb','ktestd','ktestq','ktestw','kunpckbw','kunpckdq','kunpckwd','kxnorb',
  'kxnord','kxnorq','kxnorw','kxorb','kxord','kxorq','kxorw','lddqu','ldmxcsr','maskmovdqu','maskmovq','maxpd','maxps','maxsd','maxss','minpd','minps','minsd',
  'minss','movapd','movaps','movddup','movdq2q','movdqa','movdqu','movhlps','movhpd','movhps','movlhps','movlpd','movlps','movmskpd','movmskps','movntdq','movntdqa','movnti',
  'movntpd','movntps','movntq','movntsd','movntss','movq2dq','movshdup','movsldup','movupd','movups','mpsadbw','mulpd','mulps','mulsd','mulss','orpd','orps',
  'pabsb','pabsd','pabsw','packssdw','packsswb','packusdw','packuswb','paddb','paddd','paddq','paddsb','paddsw','paddusb','paddusw','paddw',
  'palignr','pand','pandn','pavgb','pavgw','pblendvb','pblendw','pclmulqdq','pcmpeqb','pcmpeqd','pcmpeqq','pcmpeqw','pcmpestri','pcmpestrm',
  'pcmpgtb','pcmpgtd','pcmpgtq','pcmpgtw','pcmpistri','pcmpistrm','pextrb','pextrd','pextrq','pextrw','phaddd','phaddsw','phaddw','phminposuw','phsubd',
  'phsubsw','phsubw','pinsrb','pinsrd','pinsrq','pinsrw','pmaddubsw','pmaddwd','pmaxsb','pmaxsd','pmaxsw','pmaxub','pmaxud','pmaxuw',
  'pminsb','pminsd','pminsw','pminub','pminud','pminuw','pmovmskb','pmovsxbd','pmovsxbq','pmovsxbw','pmovsxdq','pmovsxwd','pmovsxwq',
  'pmovzxbd','pmovzxbq','pmovzxbw','pmovzxdq','pmovzxwd','pmovzxwq','pmuldq','pmulhrsw','pmulhuw','pmulhw','pmulld','pmullw','pmuludq',
  'por','psadbw','pshufb','pshufd','pshufhw','pshuflw','pshufw','psignb','psignd','psignw','pslld','pslldq','psllq','psllw','psrad',
  'psraw','psrld','psrldq','psrlq','psrlw','psubb','psubd','psubq','psubsb','psubsw','psubusb','psubusw','psubw','ptest',
  'punpckhbw','punpckhdq','punpckhqdq','punpckhwd','punpcklbw','punpckldq','punpcklqdq','punpcklwd','pxor','rcpps',
  'rcpss','roundpd','roundps','roundsd','roundss','rsqrtps','rsqrtss','sha1msg1','sha1msg2','sha1nexte','sha1rnds4','sha256msg1','sha256msg2',
  'sha256rnds2','shufpd','shufps','sqrtpd','sqrtps','sqrtsd','sqrtss','stmxcsr','subpd','subps','subsd','subss','ucomisd','ucomiss',
  'unpckhpd','unpckhps','unpcklpd','unpcklps','vaddpd','vaddps','vaddsd','vaddss','vaddsubpd','vaddsubps','vaesdec','vaesdeclast','vaesenc',
  'vaesenclast','vaesimc','vaeskeygenassist','vandnpd','vandnps','vandpd','vandps','vblendpd','vblendps','vblendvpd','vblendvps',
  'vbroadcastf128','vbroadcasti128','vbroadcastsd','vbroadcastss','vcmp','vcmppd','vcmpps','vcmpsd','vcmpss','vcomisd','vcomiss',
  'vcvtdq2pd','vcvtdq2ps','vcvtpd2dq','vcvtpd2ps','vcvtph2ps','vcvtps2dq','vcvtps2pd','vcvtps2ph','vcvtsd2si','vcvtsd2ss','vcvtsi2sd',
  'vcvtsi2ss','vcvtss2sd','vcvtss2si','vcvttpd2dq','vcvttps2dq','vcvttsd2si','vcvttss2si','vdivpd','vdivps','vdivsd','vdivss','vdppd',
  'vdpps','vextractf128','vextracti128','vextractps','vfmadd132pd','vfmadd132ps','vfmadd132sd','vfmadd132ss','vfmadd213pd','vfmadd213ps',
  'vfmadd213sd','vfmadd213ss','vfmadd231pd','vfmadd231ps','vfmadd231sd','vfmadd231ss','vfmaddpd','vfmaddps','vfmaddsd','vfmaddss',
  'vfmaddsub132pd','vfmaddsub132ps','vfmaddsub213pd','vfmaddsub213ps','vfmaddsub231pd','vfmaddsub231ps','vfmaddsubpd','vfmaddsubps',
  'vfmsub132pd','vfmsub132ps','vfmsub132sd','vfmsub132ss','vfmsub213pd','vfmsub213ps','vfmsub213sd','vfmsub213ss','vfmsub231pd',
  'vfmsub231ps','vfmsub231sd','vfmsub231ss','vfmsubadd132pd','vfmsubadd132ps','vfmsubadd213pd','vfmsubadd213ps','vfmsubadd231pd',
  'vfmsubadd231ps','vfmsubaddpd','vfmsubaddps','vfmsubpd','vfmsubps','vfmsubsd','vfmsubss','vfnmadd132pd','vfnmadd132ps','vfnmadd132sd',
  'vfnmadd132ss','vfnmadd213pd','vfnmadd213ps','vfnmadd213sd','vfnmadd213ss','vfnmadd231pd','vfnmadd231ps','vfnmadd231sd','vfnmadd231ss',
  'vfnmaddpd','vfnmaddps','vfnmaddsd','vfnmaddss','vfnmsub132pd','vfnmsub132ps','vfnmsub132sd','vfnmsub132ss','vfnmsub213pd','vfnmsub213ps',
  'vfnmsub213sd','vfnmsub213ss','vfnmsub231pd','vfnmsub231ps','vfnmsub231sd','vfnmsub231ss','vfnmsubpd','vfnmsubps','vfnmsubsd','vfnmsubss',
  'vfrczpd','vfrczps','vfrczsd','vfrczss','vgatherdpd','vgatherdps','vgatherqpd','vgatherqps','vgf2p8affineinvqb','vgf2p8affineqb',
  'vgf2p8mulb','vhaddpd','vhaddps','vhsubpd','vhsubps','vinsertf128','vinserti128','vinsertps','vlddqu','vldmxcsr','vmaskmovdqu',
  'vmaskmovpd','vmaskmovps','vmaxpd','vmaxps','vmaxsd','vmaxss','vminpd','vminps','vminsd','vminss','vmovapd','vmovaps','vmovd','vmovddup',
  'vmovdqa','vmovdqu','vmovhlps','vmovhpd','vmovhps','vmovlhps','vmovlpd','vmovlps','vmovmskpd','vmovmskps','vmovntdq','vmovntdqa',
  'vmovntpd','vmovntps','vmovq','vmovsd','vmovshdup','vmovsldup','vmovss','vmovupd','vmovups','vmpsadbw','vmulpd','vmulps','vmulsd',
  'vmulss','vorpd','vorps','vpabsb','vpabsd','vpabsw','vpackssdw','vpacksswb','vpackusdw','vpackuswb','vpaddb','vpaddd','vpaddq','vpaddsb',
  'vpaddsw','vpaddusb','vpaddusw','vpaddw','vpalignr','vpand','vpandn','vpavgb','vpavgw','vpblendd','vpblendvb','vpblendw','vpbroadcastb',
  'vpbroadcastd','vpbroadcastq','vpbroadcastw','vpclmulqdq','vpcmov','vpcmp','vpcmpeqb','vpcmpeqd','vpcmpeqq','vpcmpeqw','vpcmpestri',
  'vpcmpestrm','vpcmpgtb','vpcmpgtd','vpcmpgtq','vpcmpgtw','vpcmpistri','vpcmpistrm','vpcom','vperm2f128','vperm2i128','vpermd','vpermil2pd',
  'vpermil2ps','vpermilpd','vpermilps','vpermpd','vpermps','vpermq','vpextrb','vpextrd','vpextrq','vpextrw','vpgatherdd','vpgatherdq',
  'vpgatherqd','vpgatherqq','vphaddbd','vphaddbq','vphaddbw','vphaddd','vphadddq','vphaddsw','vphaddubd','vphaddubq','vphaddubw','vphaddudq',
  'vphadduwd','vphadduwq','vphaddw','vphaddwd','vphaddwq','vphminposuw','vphsubbw','vphsubd','vphsubdq','vphsubsw','vphsubw','vphsubwd',
  'vpinsrb','vpinsrd','vpinsrq','vpinsrw','vpmacsdd','vpmacsdqh','vpmacsdql','vpmacssdd','vpmacssdqh','vpmacssdql','vpmacsswd','vpmacssww',
  'vpmacswd','vpmacsww','vpmadcsswd','vpmadcswd','vpmaddubsw','vpmaddwd','vpmaskmovd','vpmaskmovq','vpmaxsb','vpmaxsd','vpmaxsw','vpmaxub',
  'vpmaxud','vpmaxuw','vpminsb','vpminsd','vpminsw','vpminub','vpminud','vpminuw','vpmovmskb','vpmovsxbd','vpmovsxbq','vpmovsxbw',
  'vpmovsxdq','vpmovsxwd','vpmovsxwq','vpmovzxbd','vpmovzxbq','vpmovzxbw','vpmovzxdq','vpmovzxwd','vpmovzxwq','vpmuldq','vpmulhrsw',
  'vpmulhuw','vpmulhw','vpmulld','vpmullw','vpmuludq','vpor','vpperm','vprotb','vprotd','vprotq','vprotw','vpsadbw','vpshab','vpshad',
  'vpshaq','vpshaw','vpshlb','vpshld','vpshlq','vpshlw','vpshufb','vpshufd','vpshufhw','vpshuflw','vpsignb','vpsignd','vpsignw','vpslld',
  'vpslldq','vpsllq','vpsllvd','vpsllvq','vpsllw','vpsrad','vpsravd','vpsraw','vpsrld','vpsrldq','vpsrlq','vpsrlvd','vpsrlvq','vpsrlw',
  'vpsubb','vpsubd','vpsubq','vpsubsb','vpsubsw','vpsubusb','vpsubusw','vpsubw','vptest','vpunpckhbw','vpunpckhdq','vpunpckhqdq',
  'vpunpckhwd','vpunpcklbw','vpunpckldq','vpunpcklqdq','vpunpcklwd','vpxor','vrcpps','vrcpss','vroundpd','vroundps','vroundsd','vroundss',
  'vrsqrtps','vrsqrtss','vshufpd','vshufps','vsqrtpd','vsqrtps','vsqrtsd','vsqrtss','vstmxcsr','vsubpd','vsubps','vsubsd','vsubss',
  'vtestpd','vtestps','vucomisd','vucomiss','vunpckhpd','vunpckhps','vunpcklpd','vunpcklps','vxorpd','vxorps','xorpd','xorps',
]);

// A family may enter the exact generic path only after its complete operand
// roles, implicit state, memory direction and physical vector write policy are
// proven.  Broad mnemonic recognition establishes ownership, not exactness.
// Dedicated SIMD/FP/EVEX lifters run before this fallback and remain exact.
const PROVEN_GENERIC_VECTOR_FAMILIES = new Set([]);

function classifyVectorCategory(family) {
  const lower = String(family || '').toLowerCase();
  const base = lower.startsWith('v') ? lower.slice(1) : lower;
  if (['andps', 'andpd', 'orps', 'orpd', 'xorps', 'xorpd', 'pand', 'por', 'pxor', 'movdqa', 'movdqu', 'movaps', 'movups', 'movapd', 'movupd'].includes(base)) {
    return 'simd';
  }
  if (/^v?mov[au]p[sd]|^v?mov[hl]p[sd]|^v?mov[ls]h?dup|^v?movddup|^v?round[ps][sd]|^v?dpp[sd]|^v?cmp[ps][sd]|^v?sqrt[ps][sd]|^v?rcp[ps][sd]|^v?rsqrt[ps][sd]|^v?haddp[sd]|^v?hsubp[sd]|^v?addsubp[sd]|^v?blendv?p[sd]|^v?cvt|^v?max[ps][sd]|^v?min[ps][sd]|^v?add[ps][sd]|^v?sub[ps][sd]|^v?mul[ps][sd]|^v?div[ps][sd]|^v?u?comi[sd]|^v?shufp[sd]|^v?unpck[hl]p[sd]|^v?andn?p[sd]|^v?x?orp[sd]|^v?broadcast[sf]|^v?extractf|^v?insertf|^v?perm[if]|^v?perm2f|^v?permilp[sd]|^v?fm[as]|^v?fnm[as]|^v?frcz|^v?testp[sd]|^v?ldmxcsr|^v?stmxcsr/.test(lower)) {
    return 'fp';
  }
  return 'simd';
}

export function liftX86VectorGeneralEffects(instruction, context = {}, requiredFamily = null) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  if (!KNOWN_VECTOR_FAMILIES.has(family)) return null;
  const prefixKind = String(instruction?.detail?.prefixes?.vector?.kind || '').toLowerCase();
  if (prefixKind === 'evex') return null;
  const category = classifyVectorCategory(family);
  if (requiredFamily != null && category !== requiredFamily) return null;

  const ctx = createX86EffectContext(instruction, context);
  const operands = ctx.operands;

  if (!PROVEN_GENERIC_VECTOR_FAMILIES.has(family)) {
    return ctx.partial('x86-vector-family-requires-dedicated-operand-semantics', ['memory', 'registers', 'flags', 'other'], {
      metadata:{
        family:category,
        operation:family,
        exactArchitecturalSummary:false,
        requiresDedicatedOperandRoles:true,
      },
    });
  }

  const inputs = [], registersRead = [], registerTargets = [], memoryReads = [], memoryWrites = [];
  const faults = [];

  for (let index = 0; index < operands.length; index += 1) {
    const operand = operands[index];
    if (operand?.type === 'register') {
      const isDest = index === 0 && !/^v?(?:cmp|ptest|test|u?comi|kortest|ktest)/.test(family);
      const isRead = !isDest || family.startsWith('v') || operands.length === 1;
      if (isRead) {
        const value = ctx.readRegister(operand);
        if (value) {
          inputs.push(value);
          registersRead.push(...physicalIds(operand.register));
        }
      }
      if (isDest) {
        registerTargets.push(operand);
      }
    } else if (operand?.type === 'immediate') {
      inputs.push(ctx.constant(Number(operand.widthBits || operand.encodedWidthBits || 8), operand.value));
    } else if (operand?.type === 'memory') {
      const address = x86EffectiveAddressExpression(ctx.instruction, operand);
      const width = Number(operand.widthBits || 128);
      if (address) {
        const isStore = index === 0 && /^v?(?:mov|maskmov|stmxcsr)/.test(family);
        if (isStore) {
          memoryWrites.push(createMemoryAccess({ space: address.space, addressExpr: address.expression, widthBits: width, endian: 'little' }));
          faults.push(...x86MemoryFaults('write', width));
        } else {
          inputs.push(ctx.readMemory(address.expression, width, { space: address.space, metadata: { ...address.metadata, vector: true } }));
          memoryReads.push(createMemoryAccess({ space: address.space, addressExpr: address.expression, widthBits: width, endian: 'little' }));
          faults.push(...x86MemoryFaults('read', width));
        }
        for (const register of [operand.memory?.base, operand.memory?.index]) {
          if (register?.physicalId) registersRead.push(register.physicalId);
        }
      }
    }
  }

  for (const register of ctx.instruction.detail?.implicitReads || []) {
    const operand = x86RegisterOperand(register.id);
    if (operand) {
      const value = ctx.readRegister(operand);
      if (value) { inputs.push(value); registersRead.push(...physicalIds(register)); }
    }
  }
  for (const register of ctx.instruction.detail?.implicitWrites || []) {
    const operand = x86RegisterOperand(register.id);
    if (operand) registerTargets.push(operand);
  }

  const isCompareOrTest = /^v?(?:u?comi[sd]|ptest|testp[sd]|kortest|ktest)/.test(family);
  const outputKinds = [];
  if (isCompareOrTest) {
    outputKinds.push(...['CF', 'PF', 'ZF', 'OF', 'SF', 'AF'].map((flag) => ({ kind: 'flag', flag, width: 1 })));
  } else {
    for (const operand of registerTargets) {
      outputKinds.push({ kind: 'register', operand, width: Number(operand.widthBits || operand.register?.viewBits || 128) });
    }
  }

  if (outputKinds.length === 0 && memoryWrites.length === 0) {
    outputKinds.push({ kind: 'flag', flag: 'ZF', width: 1 });
  }

  const registersWritten = [...new Set(outputKinds.flatMap((output) => output.kind === 'flag' ? [] : physicalIds(output.operand.register)))].sort();
  const outputs = ctx.intrinsic(`x86.${category}.${family}`, inputs, outputKinds.map((output) => output.width), {
    registersRead: [...new Set(registersRead)].sort(),
    registersWritten,
    memoryRead: memoryReads.length ? { scope: 'accesses', accesses: memoryReads } : { scope: 'none' },
    memoryWrite: memoryWrites.length ? { scope: 'accesses', accesses: memoryWrites } : { scope: 'none' },
    determinism: 'input-dependent',
    symbolicDetail: 'summary-only',
    metadata: { operation: family, category, exactArchitecturalSummary: true },
  });

  for (let i = 0; i < outputKinds.length; i += 1) {
    const target = outputKinds[i];
    const value = outputs[i];
    if (target.kind === 'flag') {
      ctx.writeFlag(target.flag, value, { operation: family });
    } else if (target.kind === 'register') {
      ctx.writeRegister(target.operand, value);
    }
  }

  return ctx.finish({
    family: category,
    possibleFaults: faults,
    metadata: { operation: family, category },
  });
}
