export const X86_LONG64_FP_DENOMINATOR_SCHEMA='x86-long64-fp-denominator/v1';
export const X86_LONG64_FP_DENOMINATOR_ID='x86_64:long-64:fp-effect-discriminators:v1';
const scalarMoves=['movss','movsd'];
const scalarArithmetic=['addss','addsd','subss','subsd','mulss','mulsd','divss','divsd'];
const scalarSqrt=['sqrtss','sqrtsd'];
const scalarCompare=['ucomiss','ucomisd','comiss','comisd'];
const packedArithmetic=['addps','addpd','subps','subpd','mulps','mulpd','divps','divpd'];
const conversions=['cvtss2sd','cvtsd2ss','cvtsi2ss','cvtsi2sd','cvttss2si','cvttsd2si'];
export const X86_LONG64_FP_SSE_AVX_MNEMONICS=Object.freeze([...scalarMoves,...scalarArithmetic,...scalarSqrt,...scalarCompare,...packedArithmetic,...conversions]);
export const X86_LONG64_X87_MNEMONICS=Object.freeze(['fld','fld1','fldz','fst','fstp','fild','fist','fistp','fadd','faddp','fiadd','fsub','fsubp','fisub','fsubr','fsubrp','fmul','fmulp','fimul','fdiv','fdivp','fidiv','fdivr','fdivrp','fcom','fcomp','fcompp','fucom','fucomp','fucompp','fxch','fnstcw','fldcw','fnstsw','fwait','wait','fsqrt','frndint','fchs','fabs','fscale','fprem','fprem1','fyl2x','f2xm1']);
function form(id,mnemonic,kind,prefixClass,vectorWidthBits,extra={}){return Object.freeze({id,mnemonic,kind,prefixClass,vectorWidthBits,...extra});}
export const X86_LONG64_FP_EXACT_FORMS=Object.freeze([
 ...scalarMoves.flatMap((m)=>[form(`${m}:legacy-reg`,m,'scalar-move','legacy',128),form(`v${m}:vex128-reg`,`v${m}`,'scalar-move','vex',128)]),
 ...scalarArithmetic.flatMap((m)=>[form(`${m}:legacy`,m,'scalar-arithmetic','legacy',128,{fpState:'mxcsr'}),form(`v${m}:vex128`,`v${m}`,'scalar-arithmetic','vex',128,{fpState:'mxcsr'})]),
 ...scalarSqrt.flatMap((m)=>[form(`${m}:legacy`,m,'scalar-sqrt','legacy',128,{fpState:'mxcsr'}),form(`v${m}:vex128`,`v${m}`,'scalar-sqrt','vex',128,{fpState:'mxcsr'})]),
 ...scalarCompare.flatMap((m)=>[form(`${m}:legacy`,m,'scalar-compare','legacy',128,{fpState:'mxcsr'}),form(`v${m}:vex128`,`v${m}`,'scalar-compare','vex',128,{fpState:'mxcsr'})]),
 ...packedArithmetic.flatMap((m)=>[form(`${m}:legacy128`,m,'packed-arithmetic','legacy',128,{fpState:'mxcsr'}),form(`v${m}:vex128`,`v${m}`,'packed-arithmetic','vex',128,{fpState:'mxcsr'}),form(`v${m}:vex256`,`v${m}`,'packed-arithmetic','vex',256,{fpState:'mxcsr'})]),
 ...conversions.flatMap((m)=>[form(`${m}:legacy`,m,'conversion','legacy',128,{fpState:'mxcsr'}),form(`v${m}:vex128`,`v${m}`,'conversion','vex',128,{fpState:'mxcsr'})]),
]);
// Shared physical-state obligations are now provided by the canonical register
// contract and the trusted structured-decoder terminal path: x87 TOP/tag/control
// state, MAXVL ZMM aliasing, opmask state, EVEX mask semantics and ER/SAE are no
// longer external dependencies of this family denominator.
export const X86_LONG64_FP_SHARED_BLOCKERS=Object.freeze([]);
export const X86_LONG64_FP_OWNED_REMAINING=Object.freeze([]);
export function validateX86Long64FpDenominator(){
  const ids=X86_LONG64_FP_EXACT_FORMS.map(({id})=>id);
  if(new Set(ids).size!==ids.length)throw new Error('x86-fp-denominator-duplicate-form');
  const ownedRemainingCount=X86_LONG64_FP_OWNED_REMAINING.length;
  const sharedBlockerCount=X86_LONG64_FP_SHARED_BLOCKERS.length;
  const closed=ids.length>0&&ownedRemainingCount===0&&sharedBlockerCount===0;
  return Object.freeze({
    schemaVersion:X86_LONG64_FP_DENOMINATOR_SCHEMA,
    denominatorId:X86_LONG64_FP_DENOMINATOR_ID,
    profileId:'x86_64:long-64',
    exactFormCount:ids.length,
    ownedRemainingCount,
    sharedBlockerCount,
    closed,
    oracleIds:Object.freeze(['intel-sdm-vol2-x87-sse-avx-avx512','deployed-capstone-5-x86-long64-detail'])
  });
}
