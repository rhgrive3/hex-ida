import test from 'node:test';
import assert from 'node:assert/strict';
import { bitvector, isSupportedWidth } from '../../../js/decompiler/phase8/bitvector.js';
import { factFromRange, fullRange, rangeOf, fullFact, singletonFact, evaluateBinaryFact, evaluateBinaryRange, contains, joinFacts, widenFacts } from '../../../js/decompiler/phase8/range.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { seedAnalysisState, runPassTransaction } from '../../../js/decompiler/phase8/transaction.js';
import { fixture } from '../helpers/ir-fixtures.mjs';
const masked=(zero,one=0n)=>factFromRange(fullRange(8),{knownZero:zero,knownOne:one});
const c=n=>singletonFact(bitvector(n,8));
function allows(f,n) {return contains(f.range,n) && (n&f.knownZero)===0n && (n&f.knownOne)===f.knownOne && n%f.congruence.modulus===f.congruence.remainder;}

test('C2: two nonconstant bit masks retain AND/OR/XOR evidence',()=>{
 const a=masked(0x80n,1n),b=masked(0x40n,2n);
 assert.equal(evaluateBinaryFact('and',a,b).knownZero & 0xc0n,0xc0n);
 assert.equal(evaluateBinaryFact('or',a,b).knownOne & 3n,3n);
 assert.equal(evaluateBinaryFact('xor',a,masked(1n,0x80n)).knownOne & 0x81n,0x81n);
});
test('C2: finite carry/borrow transfer preserves fixed low bits without assuming no carry',()=>{
 const a=masked(2n,5n),b=masked(2n,5n);
 const add=evaluateBinaryFact('add',a,b),sub=evaluateBinaryFact('sub',a,b);
 assert.equal(add.knownOne&7n,2n);assert.equal(add.knownZero&7n,5n);
 assert.equal(add.congruence.modulus,8n);assert.equal(add.congruence.remainder,2n);
 assert.equal(sub.knownZero&7n,7n);
 assert.equal(evaluateBinaryFact('add',masked(1n),masked(1n)).knownZero&1n,1n);
});
test('C2: arithmetic shift retains known sign; oversized shifts remain unknown',()=>{
 const a=evaluateBinaryFact('ashr',masked(0n,0x80n),c(3n));
 assert.equal(a.knownOne&0xf0n,0xf0n);
 for(const op of ['ashr','lshr','shl']) {
  const bad=evaluateBinaryFact(op,c(0x80n),c(8n));
  assert.equal(bad.range.kind,'full');assert.equal(bad.knownZero,0n);assert.equal(bad.knownOne,0n);
 }
});
test('C2: bounded range projections for constant shifts and multiply',()=>{
 const r=rangeOf(2n,4n,8),k=rangeOf(3n,3n,8);
 const mul=evaluateBinaryRange('mul',r,k);assert.equal(mul.range.lower,6n);assert.equal(mul.range.upper,12n);
 const shr=evaluateBinaryRange('lshr',rangeOf(64n,79n,8),rangeOf(2n,2n,8));
 assert.equal(shr.range.lower,16n);assert.equal(shr.range.upper,19n);
 const shl=evaluateBinaryRange('shl',rangeOf(120n,130n,8),rangeOf(1n,1n,8));
 assert.equal(shl.range.kind,'wrapped');assert.equal(shl.range.lower,240n);assert.equal(shl.range.upper,4n);
});
test('C2: incompatible known bits prove equality false, not merely a guess from names',()=>{
 assert.equal(evaluateBinaryFact('eq',masked(1n),masked(0n,1n)).constant?.value,0n);
 assert.equal(evaluateBinaryFact('ne',masked(1n),masked(0n,1n)).constant?.value,1n);
 assert.equal(evaluateBinaryFact('eq',masked(1n),masked(1n)).range.kind,'full');
 assert.equal(evaluateBinaryFact('eq',fullFact(8,{status:'partial'}),c(0)).status,'partial');
});
test('C2: canonical SCCP production entry retains nonconstant mask intersections',()=>{
 const f=fixture('c2-transfer-v6');f.block(0);
 const x=f.opaque(8),y=f.opaque(8);
 const a=f.binary('and',x,f.constant(252,8),8),b=f.binary('and',y,f.constant(243,8),8);
 const z=f.binary('and',a,b,8);f.ret(z);const ir=f.build(),state=seedAnalysisState(ir);
 const outcome=runPassTransaction(state,{descriptor:SCCP_PASS,run:runSccpPass},{analysis:state,ir},{});
 assert.equal(outcome.committed,true);
 const facts=state.get('ranges');const result=facts.facts?.get(z.id) ?? facts.values?.get(z.id) ?? facts.valueFacts?.get(z.id);
 assert.ok(result,'canonical product fact must be published');assert.equal(result.knownZero&15n,15n);
});
test('C2: independent 8-bit concretization oracle, joins and widening never lose represented values',()=>{
 const samples=[masked(0n),masked(15n),masked(10n,5n),masked(0x80n,0x40n),factFromRange(rangeOf(248n,7n,8)),factFromRange(rangeOf(5n,19n,8)),c(3n)];
 let observations=0;
 for(const a of samples)for(const b of samples)for(const op of ['and','or','xor','add','sub','mul']) {
  const actual=evaluateBinaryFact(op,a,b);
  const left=Array.from({length:256},(_,i)=>BigInt(i)).filter(n=>allows(a,n));
  const right=Array.from({length:256},(_,i)=>BigInt(i)).filter(n=>allows(b,n));
  for(const x of left)for(const y of right){const value=BigInt.asUintN(8,op==='and'?x&y:op==='or'?x|y:op==='xor'?x^y:op==='add'?x+y:op==='sub'?x-y:x*y);assert.ok(allows(actual,value),`${op}(${x},${y})=${value}`);observations++;}
  const joined=joinFacts(a,b),wide=widenFacts(a,joined);for(const n of [...left,...right]){assert.ok(allows(joined,n));assert.ok(allows(wide,n));}
 }
 console.log(JSON.stringify({oracle:'independent-8bit-product',observations}));
});

// Evaluation-only compositions, frozen before their first run against 4f81793f3.
// No production transfer is fitted to this matrix. This is a component holdout,
// not a real-compiler corpus or a proof of all machine semantics.
const HOLDOUT_WIDTHS=Object.freeze([1,2,3,4,8,16,32,64,128]);
function holdoutPrograms(bits) {
 const mask=(1n<<BigInt(bits))-1n,sign=1n<<BigInt(bits-1);
 const low=(1n<<BigInt(Math.max(1,Math.floor(bits/3))))-1n;
 const shift=BigInt(Math.min(bits-1,Math.max(1,Math.floor(bits/3))));
 return [
  ['forced-high-clear',[['or',sign],['xor',sign]]],
  ['masked-residue',[['and',mask^low],['add',1n]]],
  ['forced-low-toggle',[['or',1n],['xor',3n&mask]]],
  ['signed-high-fill',[['or',sign],['ashr',shift]]],
  ['masked-scale',[['and',mask^1n],['mul',3n&mask]]],
  ['two-sided-mask',[['and',mask^sign],['or',1n],['xor',sign>>1n]]],
 ];
}
function holdoutInputs(bits) {
 if(bits<=8)return Array.from({length:2**bits},(_,i)=>BigInt(i));
 const mask=(1n<<BigInt(bits))-1n,sign=1n<<BigInt(bits-1),values=[0n,1n,mask,mask-1n,sign,sign-1n];
 let seed=0x7c2d9531n;
 for(let i=0;i<128;i++) {seed=BigInt.asUintN(64,6364136223846793005n*seed+1442695040888963407n);values.push(seed&mask);}
 return [...new Set(values)];
}
function holdoutValue(bits,steps,input) {
 let value=input;
 for(const [op,right] of steps){
  const answer=op==='and'?value&right:op==='or'?value|right:op==='xor'?value^right:
    op==='add'?value+right:op==='mul'?value*right:BigInt.asIntN(bits,value)>>right;
  value=BigInt.asUintN(bits,answer);
 }
 return value;
}
// Independent counting oracle for these power-of-two residue facts. It counts
// represented outputs, not tested inputs; 64-bit counts are exact, not samples.
function representedCount(fact) {
 const {bits,range,congruence:{modulus,remainder}}=fact;
 assert.ok(modulus>0n&&(modulus&(modulus-1n))===0n,'frozen counting domain is power-of-two residues');
 const low=modulus-1n,zero=fact.knownZero|(low^remainder),one=fact.knownOne|remainder;
 if(zero&one||range.kind==='empty')return 0n;
 const upto=bound=>{
  if(bound<0n)return 0n;
  let less=0n,equal=1n;
  for(let i=bits-1;i>=0;i--){
   const bit=1n<<BigInt(i),allowZero=(one&bit)?0n:1n,allowOne=(zero&bit)?0n:1n;
   less*=allowZero+allowOne;
   if(bound&bit){less+=equal*allowZero;equal*=allowOne;}else equal*=allowZero;
  }
  return less+equal;
 };
 const last=(1n<<BigInt(bits))-1n;
 if(range.kind==='full')return upto(last);
 if(range.kind==='interval')return upto(range.upper)-upto(range.lower-1n);
 assert.equal(range.kind,'wrapped');
 return upto(last)-upto(range.lower-1n)+upto(range.upper);
}
function intervalFact(range) {
 return {bits:range.bits,range,knownZero:0n,knownOne:0n,congruence:{modulus:1n,remainder:0n}};
}
function representedWithin(fact,baseline) {
 const segments=range=>range.kind==='empty'?[]:range.kind==='full'?[[0n,(1n<<BigInt(range.bits))-1n]]:
  range.kind==='interval'?[[range.lower,range.upper]]:[[0n,range.upper],[range.lower,(1n<<BigInt(range.bits))-1n]];
 let count=0n;
 for(const [a,b] of segments(fact.range))for(const [c,d] of segments(baseline)){
  const lower=a>c?a:c,upper=b<d?b:d;
  if(lower<=upper)count+=representedCount({...fact,range:{kind:'interval',bits:fact.bits,lower,upper}});
 }
 return count;
}

test('C2: held-out compositions measure actual SCCP precision without losing concrete values',t=>{
 const rows=[];
 for(const bits of HOLDOUT_WIDTHS)for(const [name,steps] of holdoutPrograms(bits)){
  const f=fixture(`c2-holdout-${bits}-${name}`);f.block(0);
  const supported=isSupportedWidth(bits);
  let target=f.opaque(bits),baseline=supported?fullRange(bits):null;
  for(const [operator,constant] of steps){
   target=f.binary(operator,target,f.constant(constant,bits),bits);
   if(supported)baseline=evaluateBinaryRange(operator,baseline,rangeOf(constant,constant,bits)).range;
  }
  f.ret();const ir=f.build(),before=structuredClone(ir),state=seedAnalysisState(ir);
  const outcome=runPassTransaction(state,{descriptor:SCCP_PASS,run:runSccpPass},{analysis:state,ir},{});
  assert.equal(outcome.committed,true,`${bits}/${name}`);
  const artifact=state.get('ranges');assert.equal(artifact.completeness,'complete');
  if(!supported){
   assert.throws(()=>fullRange(bits),/unsupported-width/);
   assert.equal(artifact.facts.has(target.id),false);
   assert.equal(artifact.constants.has(target.id),false);
   assert.match(artifact.overdefinedReasons.get(target.id),/unsupported width/);
   assert.deepEqual(structuredClone(ir),before);
   rows.push({bits,name,disposition:'unsupported-width',strictGain:false,concreteChecks:0});
   continue;
  }
  const actual=artifact.facts.get(target.id);assert.ok(actual,'only actual published product facts count');
  assert.ok(['exact','conservative'].includes(actual.status),actual.status);
  const inputs=holdoutInputs(bits);
  for(const input of inputs){
   const value=holdoutValue(bits,steps,input);
   assert.ok(allows(actual,value),`${bits}/${name}/${input}: actual output ${value} was excluded`);
   assert.ok(contains(baseline,value),'interval baseline must also contain every concrete output');
  }
  const productCount=representedCount(actual),baselineCount=representedCount(intervalFact(baseline));
  assert.ok(productCount>0n&&productCount<=baselineCount,`${bits}/${name}: precision must not regress`);
  assert.equal(representedWithin(actual,baseline),productCount,'product denotation must be a subset, not merely a smaller unrelated set');
  if(bits<=8){
   const universe=holdoutInputs(bits);
   assert.equal(productCount,BigInt(universe.filter(value=>allows(actual,value)).length),'counting oracle cross-check');
   assert.equal(baselineCount,BigInt(universe.filter(value=>contains(baseline,value)).length));
  }
  assert.deepEqual(structuredClone(ir),before,'analysis must not rewrite the canonical IR');
  rows.push({bits,name,disposition:'measured',concreteChecks:inputs.length,concreteExhaustive:bits<=8,
   productCount:String(productCount),baselineCount:String(baselineCount),strictGain:productCount<baselineCount});
 }
 assert.equal(rows.length,54);assert.equal(new Set(rows.map(row=>`${row.bits}/${row.name}`)).size,54);
 assert.deepEqual(HOLDOUT_WIDTHS.filter(isSupportedWidth),[1,8,16,32,64,128]);
 assert.equal(rows.filter(row=>row.disposition==='measured').length,36);
 assert.equal(rows.filter(row=>row.disposition==='unsupported-width').length,18);
 for(const bits of HOLDOUT_WIDTHS.filter(isSupportedWidth))assert.ok(rows.some(row=>row.bits===bits&&row.strictGain),`no held-out gain at width ${bits}`);
 t.diagnostic(JSON.stringify({schema:'c2-heldout-precision-v1',rows,scope:'fixed straight-line component compositions; branch/loop and compiler holdouts separate'}));
});
