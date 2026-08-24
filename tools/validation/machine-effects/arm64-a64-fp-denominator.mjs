export const ARM64_A64_FP_DENOMINATOR_SCHEMA = 'arm64-a64-fp-denominator/v1';
export const ARM64_A64_FP_DENOMINATOR_ID = 'arm64:a64:fp-encoding-discriminators:v1';

export const ARM64_A64_FP_MNEMONIC_DENOMINATOR = Object.freeze([
  'fadd','fsub','fmul','fdiv','fsqrt','fmadd','fmsub','fnmadd','fnmsub',
  'fmax','fmin','fmaxnm','fminnm','frecpe','frecps','frsqrte','frsqrts',
  'fcvt','scvtf','ucvtf','fcvtas','fcvtau','fcvtms','fcvtmu','fcvtns','fcvtnu',
  'fcvtps','fcvtpu','fcvtzs','fcvtzu','frinta','frintm','frintn','frintp','frintx','frinti','frintz',
  'fcmp','fcmpe','fccmp','fccmpe','fmov','fabs','fneg','fcsel',
]);

const entry = (id,mask,match,mnemonic,extra={}) => Object.freeze({
  id, mask:mask>>>0, match:match>>>0, mnemonic, ...extra,
});

const TWO_SOURCE = Object.freeze([
  ['fmul',0x1e200800],['fdiv',0x1e201800],['fadd',0x1e202800],['fsub',0x1e203800],
  ['fmax',0x1e204800],['fmin',0x1e205800],['fmaxnm',0x1e206800],['fminnm',0x1e207800],
]);
const ONE_SOURCE = Object.freeze([
  ['fmov',0x1e204000],['fabs',0x1e20c000],['fneg',0x1e214000],['fsqrt',0x1e21c000],
  ['frintn',0x1e244000],['frintp',0x1e24c000],['frintm',0x1e254000],['frintz',0x1e25c000],
  ['frinta',0x1e264000],['frintx',0x1e274000],['frinti',0x1e27c000],
]);
const THREE_SOURCE = Object.freeze([
  ['fmadd',0x1f000000],['fmsub',0x1f008000],['fnmadd',0x1f200000],['fnmsub',0x1f208000],
]);
const INTEGER_CONVERT = Object.freeze([
  ['fcvtns',0x1e200000],['fcvtnu',0x1e210000],['scvtf',0x1e220000],['ucvtf',0x1e230000],
  ['fcvtas',0x1e240000],['fcvtau',0x1e250000],['fmov-to-gp',0x1e260000],['fmov-from-gp',0x1e270000],
  ['fcvtps',0x1e280000],['fcvtpu',0x1e290000],['fcvtms',0x1e300000],['fcvtmu',0x1e310000],
  ['fcvtzs',0x1e380000],['fcvtzu',0x1e390000],
]);
const FIXED_CONVERT = Object.freeze([
  ['scvtf-fixed',0x1e020000,'scvtf'],['ucvtf-fixed',0x1e030000,'ucvtf'],
  ['fcvtzs-fixed',0x1e180000,'fcvtzs'],['fcvtzu-fixed',0x1e190000,'fcvtzu'],
]);
const FCVT_PAIRS = Object.freeze([
  ['fcvt-h-s',0x1e23c000,16,32],['fcvt-h-d',0x1e63c000,16,64],
  ['fcvt-s-h',0x1ee24000,32,16],['fcvt-s-d',0x1e624000,32,64],
  ['fcvt-d-h',0x1ee2c000,64,16],['fcvt-d-s',0x1e22c000,64,32],
]);
const RECIPROCAL = Object.freeze([
  ['frecpe-h',0x5ef9d800,'frecpe',16,1],['frecpe-s',0x5ea1d800,'frecpe',32,1],['frecpe-d',0x5ee1d800,'frecpe',64,1],
  ['frsqrte-h',0x7ef9d800,'frsqrte',16,1],['frsqrte-s',0x7ea1d800,'frsqrte',32,1],['frsqrte-d',0x7ee1d800,'frsqrte',64,1],
  ['frecps-h',0x5e403c00,'frecps',16,2],['frecps-s',0x5e20fc00,'frecps',32,2],['frecps-d',0x5e60fc00,'frecps',64,2],
  ['frsqrts-h',0x5ec03c00,'frsqrts',16,2],['frsqrts-s',0x5ea0fc00,'frsqrts',32,2],['frsqrts-d',0x5ee0fc00,'frsqrts',64,2],
]);

export const ARM64_A64_FP_ENCODING_FAMILIES = Object.freeze([
  ...TWO_SOURCE.map(([mnemonic,base])=>entry(`two-source-${mnemonic}`,0xff20fc00,base,mnemonic,{kind:'two-source'})),
  ...ONE_SOURCE.map(([mnemonic,base])=>entry(`one-source-${mnemonic}`,0xff3ffc00,base,mnemonic,{kind:'one-source'})),
  ...THREE_SOURCE.map(([mnemonic,base])=>entry(`three-source-${mnemonic}`,0xff208000,base,mnemonic,{kind:'three-source'})),
  entry('fmov-immediate',0xff201fe0,0x1e201000,'fmov',{kind:'immediate'}),
  entry('fcmp-register',0xff20fc1f,0x1e202000,'fcmp',{kind:'compare-register'}),
  entry('fcmpe-register',0xff20fc1f,0x1e202010,'fcmpe',{kind:'compare-register'}),
  entry('fcmp-zero',0xff3ffc1f,0x1e202008,'fcmp',{kind:'compare-zero'}),
  entry('fcmpe-zero',0xff3ffc1f,0x1e202018,'fcmpe',{kind:'compare-zero'}),
  entry('fccmp',0xff200c10,0x1e200400,'fccmp',{kind:'conditional-compare'}),
  entry('fccmpe',0xff200c10,0x1e200410,'fccmpe',{kind:'conditional-compare'}),
  entry('fcsel',0xff200c00,0x1e200c00,'fcsel',{kind:'select'}),
  ...INTEGER_CONVERT.map(([id,base])=>entry(id,0x7f3ffc00,base,id.startsWith('fmov')?'fmov':id,{kind:'integer-convert'})),
  ...FIXED_CONVERT.map(([id,base,mnemonic])=>entry(id,0x7f3f0000,base,mnemonic,{kind:'fixed-convert'})),
  ...FCVT_PAIRS.map(([id,base,destinationBits,sourceBits])=>entry(id,0xfffffc00,base,'fcvt',{kind:'fcvt',destinationBits,sourceBits})),
  ...RECIPROCAL.map(([id,base,mnemonic,widthBits,sourceCount])=>entry(id,sourceCount===1?0xfffffc00:0xffe0fc00,base,mnemonic,{kind:'reciprocal',widthBits,sourceCount})),
]);

const TYPE_WIDTH = Object.freeze({0:32,1:64,3:16});
const TYPE_CODES = Object.freeze([0,1,3]);

function validFamilyWord(family,value) {
  if (family.kind === 'fcvt' || family.kind === 'reciprocal') return true;
  const type=(value>>>22)&3;
  if (!(type in TYPE_WIDTH)) return false;
  if (family.kind === 'integer-convert') {
    if (family.id === 'fmov-to-gp' || family.id === 'fmov-from-gp') {
      const sf=value>>>31;
      return (type===0&&sf===0)||(type===1&&sf===1)||(type===3&&sf===0);
    }
  }
  if (family.kind === 'fixed-convert') {
    const sf=value>>>31;
    const scale=(value>>>10)&0x3f;
    return sf===1 || scale>=32;
  }
  return true;
}

export function classifyArm64A64FpEncoding(word) {
  const value=Number(word)>>>0;
  const matches=ARM64_A64_FP_ENCODING_FAMILIES.filter((family)=>((value&family.mask)>>>0)===family.match&&validFamilyWord(family,value));
  if(matches.length>1) throw new Error(`arm64-fp-denominator-overlap:0x${value.toString(16)}:${matches.map(({id})=>id).join(',')}`);
  return matches[0]??null;
}

function item(id,familyId,word){return Object.freeze({id,familyId,word:word>>>0});}
function* registers(familyId,template,fields){
  for(const shift of fields) for(let register=0;register<32;register++) {
    yield item(`${familyId}:register:${shift}:${register}`,familyId,((template&~(0x1f<<shift))|(register<<shift))>>>0);
  }
}

export function* arm64A64FpEncodingCases() {
  for(const [mnemonic,base] of TWO_SOURCE){
    const familyId=`two-source-${mnemonic}`;
    for(const type of TYPE_CODES) yield item(`${familyId}:type:${type}`,familyId,(base|(type<<22)|(2<<16)|(1<<5))>>>0);
    yield* registers(familyId,(base|(2<<16)|(1<<5))>>>0,[0,5,16]);
  }
  for(const [mnemonic,base] of ONE_SOURCE){
    const familyId=`one-source-${mnemonic}`;
    for(const type of TYPE_CODES) yield item(`${familyId}:type:${type}`,familyId,(base|(type<<22)|(1<<5))>>>0);
    yield* registers(familyId,(base|(1<<5))>>>0,[0,5]);
  }
  for(const [mnemonic,base] of THREE_SOURCE){
    const familyId=`three-source-${mnemonic}`;
    for(const type of TYPE_CODES) yield item(`${familyId}:type:${type}`,familyId,(base|(type<<22)|(2<<16)|(3<<10)|(1<<5))>>>0);
    yield* registers(familyId,(base|(2<<16)|(3<<10)|(1<<5))>>>0,[0,5,10,16]);
  }
  for(const type of TYPE_CODES) for(let imm8=0;imm8<256;imm8++) {
    yield item(`fmov-immediate:${type}:${imm8}`,'fmov-immediate',(0x1e201000|(type<<22)|(imm8<<13))>>>0);
  }
  yield* registers('fmov-immediate',0x1e2e1000,[0]);

  for(const [familyId,base] of [['fcmp-register',0x1e202000],['fcmpe-register',0x1e202010]]){
    for(const type of TYPE_CODES) yield item(`${familyId}:${type}`,familyId,(base|(type<<22)|(1<<16))>>>0);
    yield* registers(familyId,(base|(1<<16))>>>0,[5,16]);
  }
  for(const [familyId,base] of [['fcmp-zero',0x1e202008],['fcmpe-zero',0x1e202018]]){
    for(const type of TYPE_CODES) yield item(`${familyId}:${type}`,familyId,(base|(type<<22))>>>0);
    yield* registers(familyId,base,[5]);
  }
  for(const [familyId,base] of [['fccmp',0x1e200400],['fccmpe',0x1e200410]]){
    for(const type of TYPE_CODES) for(let condition=0;condition<16;condition++) for(let nzcv=0;nzcv<16;nzcv++) {
      yield item(`${familyId}:${type}:${condition}:${nzcv}`,familyId,(base|(type<<22)|(1<<16)|(condition<<12)|nzcv)>>>0);
    }
    yield* registers(familyId,(base|(1<<16))>>>0,[5,16]);
  }
  for(const type of TYPE_CODES) for(let condition=0;condition<16;condition++) {
    yield item(`fcsel:${type}:${condition}`,'fcsel',(0x1e200c00|(type<<22)|(2<<16)|(condition<<12)|(1<<5))>>>0);
  }
  yield* registers('fcsel',0x1e220c20,[0,5,16]);

  for(const [familyId,base] of INTEGER_CONVERT){
    for(const type of TYPE_CODES) for(const sf of [0,1]) {
      const word=(base|(type<<22)|(sf<<31)|(1<<5))>>>0;
      if(validFamilyWord(ARM64_A64_FP_ENCODING_FAMILIES.find(({id})=>id===familyId),word)) yield item(`${familyId}:${type}:${sf}`,familyId,word);
    }
    const validTemplate=(base|(1<<5))>>>0;
    yield* registers(familyId,validTemplate,[0,5]);
  }
  for(const [familyId,base] of FIXED_CONVERT){
    for(const type of TYPE_CODES) for(const sf of [0,1]) {
      const integerBits=sf?64:32;
      for(let fbits=1;fbits<=integerBits;fbits++) {
        const scale=64-fbits;
        yield item(`${familyId}:${type}:${sf}:${fbits}`,familyId,(base|(type<<22)|(sf<<31)|(scale<<10)|(1<<5))>>>0);
      }
    }
    yield* registers(familyId,(base|(32<<10)|(1<<5))>>>0,[0,5]);
  }

  for(const [familyId,base] of FCVT_PAIRS){
    yield item(familyId,familyId,(base|(1<<5))>>>0);
    yield* registers(familyId,(base|(1<<5))>>>0,[0,5]);
  }
  for(const [familyId,base,,sourceCount] of RECIPROCAL){
    const template=(base|(sourceCount===2?(2<<16):0)|(1<<5))>>>0;
    yield item(familyId,familyId,template);
    yield* registers(familyId,template,sourceCount===2?[0,5,16]:[0,5]);
  }
}

export function validateArm64A64FpDenominator(){
  if(new Set(ARM64_A64_FP_MNEMONIC_DENOMINATOR).size!==ARM64_A64_FP_MNEMONIC_DENOMINATOR.length) throw new Error('arm64-fp-denominator-mnemonic-duplicate');
  const ids=ARM64_A64_FP_ENCODING_FAMILIES.map(({id})=>id);
  if(new Set(ids).size!==ids.length) throw new Error('arm64-fp-denominator-family-duplicate');
  for(let left=0;left<ARM64_A64_FP_ENCODING_FAMILIES.length;left++){
    const a=ARM64_A64_FP_ENCODING_FAMILIES[left];
    if(((a.match&a.mask)>>>0)!==a.match) throw new Error(`arm64-fp-denominator-match-outside-mask:${a.id}`);
    for(let right=left+1;right<ARM64_A64_FP_ENCODING_FAMILIES.length;right++){
      const b=ARM64_A64_FP_ENCODING_FAMILIES[right];
      if((((a.match^b.match)&(a.mask&b.mask))>>>0)===0) throw new Error(`arm64-fp-denominator-family-overlap:${a.id}:${b.id}`);
    }
  }
  let encodingCaseCount=0; const observed=new Set();
  for(const candidate of arm64A64FpEncodingCases()){
    const family=classifyArm64A64FpEncoding(candidate.word);
    if(!family||family.id!==candidate.familyId) throw new Error(`arm64-fp-denominator-case-unowned:${candidate.id}:${family?.id||'none'}`);
    observed.add(family.id); encodingCaseCount++;
  }
  if(observed.size!==ARM64_A64_FP_ENCODING_FAMILIES.length) throw new Error('arm64-fp-denominator-family-unobserved');
  return Object.freeze({
    valid:true,schemaVersion:ARM64_A64_FP_DENOMINATOR_SCHEMA,denominatorId:ARM64_A64_FP_DENOMINATOR_ID,
    profileId:'arm64:a64',encodingFamilyCount:ARM64_A64_FP_ENCODING_FAMILIES.length,encodingCaseCount,
    mnemonicCount:ARM64_A64_FP_MNEMONIC_DENOMINATOR.length,registerCount:32,conditionCount:16,fpImmediateCount:256,
    oracleIds:Object.freeze(['arm-a-profile-a64-floating-point-encoding-tables','deployed-capstone-5-arm64','llvm-mc-18-aarch64-disassembler']),
  });
}
