import test from 'node:test';
import assert from 'node:assert/strict';
import { bitvector } from '../../../js/decompiler/phase8/bitvector.js';
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
