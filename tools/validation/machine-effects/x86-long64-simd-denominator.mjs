export const X86_LONG64_SIMD_DENOMINATOR_SCHEMA='x86-long64-simd-denominator/v1';
export const X86_LONG64_SIMD_DENOMINATOR_ID='x86_64:long-64:simd-effect-discriminators:v1';
const fullMoves=['movaps','movups','movapd','movupd','movdqa','movdqu'];
const integerMoves=['movd','movq'];
const bitwise=['andps','andpd','pand','orps','orpd','por','xorps','xorpd','pxor'];
const packedArithmetic=['paddb','paddw','paddd','paddq','psubb','psubw','psubd','psubq'];
const packedCompare=['pcmpeqb','pcmpeqw','pcmpeqd','pcmpgtb','pcmpgtw','pcmpgtd'];
const packedShift=['psllw','pslld','psllq','psrlw','psrld','psrlq','psraw','psrad'];
const laneOps=['pshufd','punpckldq'];
function form(id,mnemonic,kind,prefixClass,vectorWidthBits,extra={}){return Object.freeze({id,mnemonic,kind,prefixClass,vectorWidthBits,...extra});}
export const X86_LONG64_SIMD_EXACT_FORMS=Object.freeze([
 ...fullMoves.flatMap((m)=>[form(`${m}:legacy128`,m,'full-move','legacy',128),form(`v${m}:vex128`,`v${m}`,'full-move','vex',128),form(`v${m}:vex256`,`v${m}`,'full-move','vex',256)]),
 ...integerMoves.flatMap((m)=>[form(`${m}:legacy128`,m,'scalar-integer-move','legacy',128),form(`v${m}:vex128`,`v${m}`,'scalar-integer-move','vex',128)]),
 ...bitwise.flatMap((m)=>[form(`${m}:legacy128`,m,'bitwise','legacy',128),form(`v${m}:vex128`,`v${m}`,'bitwise','vex',128),form(`v${m}:vex256`,`v${m}`,'bitwise','vex',256)]),
 ...packedArithmetic.flatMap((m)=>[form(`${m}:legacy128`,m,'packed-integer','legacy',128),form(`v${m}:vex128`,`v${m}`,'packed-integer','vex',128),form(`v${m}:vex256`,`v${m}`,'packed-integer','vex',256)]),
 ...packedCompare.flatMap((m)=>[form(`${m}:legacy128`,m,'packed-compare','legacy',128),form(`v${m}:vex128`,`v${m}`,'packed-compare','vex',128),form(`v${m}:vex256`,`v${m}`,'packed-compare','vex',256)]),
 ...packedShift.flatMap((m)=>[form(`${m}:legacy128`,m,'packed-shift','legacy',128),form(`v${m}:vex128`,`v${m}`,'packed-shift','vex',128),form(`v${m}:vex256`,`v${m}`,'packed-shift','vex',256)]),
 ...laneOps.flatMap((m)=>[form(`${m}:legacy128`,m,'lane-map','legacy',128),form(`v${m}:vex128`,`v${m}`,'lane-map','vex',128),form(`v${m}:vex256`,`v${m}`,'lane-map','vex',256)]),
 form('pandn:legacy128','pandn','and-not','legacy',128),form('vpandn:vex128','vpandn','and-not','vex',128),form('vpandn:vex256','vpandn','and-not','vex',256),form('vzeroupper:vex128','vzeroupper','vector-state','vex',128),
]);
export const X86_LONG64_SIMD_OWNED_REMAINING=Object.freeze([]);
export const X86_LONG64_SIMD_SHARED_BLOCKERS=Object.freeze([
 Object.freeze({id:'vex-maxvl-alias',required:['xmm/ymm writes must alias zmm[MAXVL] when AVX-512 is locked']}),
 Object.freeze({id:'evex-avx512-state',required:['zmm0-zmm31','k0-k7','decoded-evex-fields','merge-zero-mask-semantics']}),
 Object.freeze({id:'vzeroall-maxvl',required:['zmm0-zmm15[MAXVL-1:0]']}),
 Object.freeze({id:'vzeroupper-maxvl',required:['zmm0-zmm15[MAXVL-1:128]']}),
 Object.freeze({id:'emms-mmx-x87-alias',required:['mm0-mm7/x87-physical-alias','x87-tag-word']}),
]);
export function validateX86Long64SimdDenominator(){
  const ids=X86_LONG64_SIMD_EXACT_FORMS.map(({id})=>id);
  if(new Set(ids).size!==ids.length)throw new Error('x86-simd-denominator-duplicate-form');
  const ownedRemainingCount=X86_LONG64_SIMD_OWNED_REMAINING.length;
  const sharedBlockerCount=X86_LONG64_SIMD_SHARED_BLOCKERS.length;
  const closed=ids.length>0&&ownedRemainingCount===0&&sharedBlockerCount===0;
  return Object.freeze({
    schemaVersion:X86_LONG64_SIMD_DENOMINATOR_SCHEMA,
    denominatorId:X86_LONG64_SIMD_DENOMINATOR_ID,
    profileId:'x86_64:long-64',
    exactFormCount:ids.length,
    ownedRemainingCount,
    sharedBlockerCount,
    closed,
    oracleIds:Object.freeze(['intel-sdm-vol2-sse-avx-avx2-avx512','deployed-capstone-5-x86-long64-detail'])
  });
}
