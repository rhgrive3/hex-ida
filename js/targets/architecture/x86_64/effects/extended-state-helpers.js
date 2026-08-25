import { x86EffectiveAddressExpression } from './addressing.js';

export const X87_FAMILIES = new Set(['fld','fld1','fldz','fst','fstp','fild','fist','fistp','fadd','faddp','fiadd','fsub','fsubp','fisub','fsubr','fsubrp','fmul','fmulp','fimul','fdiv','fdivp','fidiv','fdivr','fdivrp','fcom','fcomp','fcompp','fucom','fucomp','fucompp','fxch','fnstcw','fldcw','fnstsw','fwait','wait','fsqrt','frndint','fchs','fabs','fscale','fprem','fprem1','fyl2x','f2xm1']);
export const FP_EVEX_BASES = new Set(['movss','movsd','addss','addsd','subss','subsd','mulss','mulsd','divss','divsd','sqrtss','sqrtsd','ucomiss','ucomisd','comiss','comisd','addps','addpd','subps','subpd','mulps','mulpd','divps','divpd','cvtss2sd','cvtsd2ss','cvtsi2ss','cvtsi2sd','cvttss2si','cvttsd2si']);
export const SIMD_EVEX_BASES = new Set(['movaps','movups','movapd','movupd','movdqa','movdqu','movd','movq','andps','andpd','pand','orps','orpd','por','xorps','xorpd','pxor','paddb','paddw','paddd','paddq','psubb','psubw','psubd','psubq','pcmpeqb','pcmpeqw','pcmpeqd','pcmpgtb','pcmpgtw','pcmpgtd','psllw','pslld','psllq','psrlw','psrld','psrlq','psraw','psrad','pshufd','punpckldq','pandn']);
export const X87_STATE = Object.freeze(['x87-stack','fpcw','fpsw','fptw','fop','fip','fdp']);
export const FP_EVEX_PP = new Map([['movss',2],['movsd',3],['addss',2],['addsd',3],['subss',2],['subsd',3],['mulss',2],['mulsd',3],['divss',2],['divsd',3],['sqrtss',2],['sqrtsd',3],['ucomiss',0],['ucomisd',1],['comiss',0],['comisd',1],['addps',0],['addpd',1],['subps',0],['subpd',1],['mulps',0],['mulpd',1],['divps',0],['divpd',1],['cvtss2sd',2],['cvtsd2ss',3],['cvtsi2ss',2],['cvtsi2sd',3],['cvttss2si',2],['cvttsd2si',3]]);
export const SIMD_EVEX_PP = new Map([['movaps',0],['movups',0],['movapd',1],['movupd',1],['movdqa',1],['movdqu',2],['movd',1],['movq',1],['andps',0],['andpd',1],['pand',1],['orps',0],['orpd',1],['por',1],['xorps',0],['xorpd',1],['pxor',1],...['paddb','paddw','paddd','paddq','psubb','psubw','psubd','psubq','pcmpeqb','pcmpeqw','pcmpeqd','pcmpgtb','pcmpgtw','pcmpgtd','psllw','pslld','psllq','psrlw','psrld','psrlq','psraw','psrad','pshufd','punpckldq','pandn'].map((name)=>[name,1])]);
export const FP_MXCSR_BASES = new Set([...FP_EVEX_BASES].filter((name)=>!['movss','movsd'].includes(name)));
export const FP_COMPARE_BASES = new Set(['ucomiss','ucomisd','comiss','comisd']);
export const EVEX_MOVE_BASES = new Set(['movss','movsd','movaps','movups','movapd','movupd','movdqa','movdqu','movd','movq']);
const LEGACY_PREFIX_BYTES = new Set([0xf0,0xf2,0xf3,0x2e,0x36,0x3e,0x26,0x64,0x65,0x66,0x67]);
const VECTOR_REGISTER_NAME = /^(?:xmm|ymm|zmm)(\d+)$/;
const MASK_REGISTER_NAME = /^k[0-7]$/;
export function baseFamily(family){return family.startsWith('v')?family.slice(1):family;}
export function registerName(operand){return String(operand?.register?.id??operand?.register?.name??'').toLowerCase();}
export function vectorIndex(operand){const match=VECTOR_REGISTER_NAME.exec(registerName(operand));return match?Number(match[1]):null;}
export function isVectorOperand(operand){return operand?.type==='register'&&vectorIndex(operand)!=null;}
export function isMaskOperand(operand){return operand?.type==='register'&&MASK_REGISTER_NAME.test(registerName(operand));}
export function vectorPrefixOffset(instruction,prefix){
  const raw=instruction?.rawBytes||[],reported=Number(instruction?.detail?.prefixes?.vector?.offset);
  if(Number.isSafeInteger(reported)&&reported>=0&&reported+prefix.length<=raw.length){let ok=true;for(let i=0;i<prefix.length;i+=1)if(raw[reported+i]!==prefix[i]){ok=false;break;}if(ok)return reported;}
  let cursor=0;
  while(cursor<raw.length&&LEGACY_PREFIX_BYTES.has(raw[cursor]))cursor+=1;
  if(cursor<raw.length&&raw[cursor]>=0x40&&raw[cursor]<=0x4f)cursor+=1;
  if(cursor+prefix.length>raw.length)return null;for(let i=0;i<prefix.length;i+=1)if(raw[cursor+i]!==prefix[i])return null;return cursor;
}
export function rawPrefixMatches(instruction,prefix){return vectorPrefixOffset(instruction,prefix)!=null;}
export function evexInfo(instruction){
  const vector=instruction?.detail?.prefixes?.vector,bytes=vector?.bytes||[];
  if(String(vector?.kind||'').toLowerCase()!=='evex'||bytes.length!==4||bytes[0]!==0x62||!rawPrefixMatches(instruction,bytes))return null;
  const p0=bytes[1],p1=bytes[2],p2=bytes[3],map=p0&3,ll=(p2>>>5)&3,aaa=p2&7,zeroing=(p2&0x80)!==0,b=(p2&0x10)!==0;
  if((p0&0x0c)!==0||(p1&0x04)===0||map===0||(zeroing&&aaa===0))return null;
  return Object.freeze({bytes,map,mandatoryPrefixCode:p1&3,lengthOrRoundingCode:ll,encodedVvvv:(p1>>>3)&15,maskRegister:aaa===0?null:`k${aaa}`,zeroing,broadcastOrRounding:b});
}

export function vexInfo(instruction){
  const vector=instruction?.detail?.prefixes?.vector,kind=String(vector?.kind||'').toLowerCase();
  if(kind!=='vex2'&&kind!=='vex3')return null;
  const bytes=vector?.bytes||[];
  if((kind==='vex2'&&(bytes.length!==2||bytes[0]!==0xc5))||(kind==='vex3'&&(bytes.length!==3||bytes[0]!==0xc4)))return null;
  const offset=vectorPrefixOffset(instruction,bytes);if(offset==null)return null;
  if(kind==='vex2')return{kind,width:(bytes[1]&4)?256:128,vvvv:(bytes[1]>>>3)&15,prefixLength:2,prefixOffset:offset,map:1,pp:bytes[1]&3};
  const map=bytes[1]&31;if(map<1||map>3)return null;return{kind,width:(bytes[2]&4)?256:128,vvvv:(bytes[2]>>>3)&15,prefixLength:3,prefixOffset:offset,map,pp:bytes[2]&3};
}
export function exactBase(bundle){return bundle&&['exact','exact-with-intrinsic'].includes(bundle.completeness);}
export function memoryAddress(ctx,operand){if(operand?.type!=='memory'||operand.memory?.addressSizeBits!==64||operand.memory?.segment!=null)return null;return x86EffectiveAddressExpression(ctx.instruction,operand);}
export function possibleFeatureFault(kind){return Object.freeze({kind,condition:{kind:'x86-feature-state-condition'},detail:{architectural:true}});}
export function trustedCapstoneInstruction(instruction,family){
  return instruction?.detailStatus==='complete'
    && instruction?.detailAvailable===true
    && instruction?.decoderSemanticVersion==='capstone-5-x86-structured-v2'
    && Number.isSafeInteger(Number(instruction?.instructionCode))
    && Number(instruction.instructionCode)>0
    && String(instruction?.opcodeName||'').toLowerCase()===family;
}
export function physicalIds(register){if(!register)return[];if(Array.isArray(register.compositeParts))return register.compositeParts.map((part)=>part.physicalId);return register.physicalId?[register.physicalId]:[];}
