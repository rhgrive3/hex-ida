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

const FLOW_HOLDOUT_WIDTHS=Object.freeze([1,8,16,32,64,128]);
function flowHoldoutAnalysis(ir,context={}) {
 const state=seedAnalysisState(ir);
 const outcome=runPassTransaction(state,{descriptor:SCCP_PASS,run:runSccpPass},{analysis:state,ir,...context},{});
 assert.equal(outcome.committed,true);
 return state.get('ranges');
}
// Reference comparison set in integer order, converted once to modular bits.
// No production comparison/refinement routine is used to construct this oracle.
function comparisonDenotation(bits,operator,bound,truth) {
 const signed=operator.startsWith('s'),sign=1n<<BigInt(bits-1),max=(1n<<BigInt(bits))-1n;
 const threshold=signed?BigInt.asIntN(bits,bound):bound;
 const less=operator.endsWith('lt')===truth,min=signed?-sign:0n,last=signed?sign-1n:max;
 const low=less?min:threshold,high=less?threshold-1n:last;
 if(low>high)return {count:0n,range:{bits,kind:'empty',lower:0n,upper:0n}};
 const lower=BigInt.asUintN(bits,low),upper=BigInt.asUintN(bits,high);
 return {count:high-low+1n,range:{bits,kind:lower<=upper?'interval':'wrapped',lower,upper}};
}

test('C2: held-out branch edge and entry facts match independent signed and unsigned partitions',t=>{
 const rows=[];
 for(const bits of FLOW_HOLDOUT_WIDTHS){
  const sign=1n<<BigInt(bits-1),total=1n<<BigInt(bits);
  for(const [boundary,bound] of [['zero',0n],['positive-max',sign-1n],['sign-bit',sign],['unsigned-max',total-1n]]){
   for(const operator of ['ult','uge','slt','sge']){
    const f=fixture(`c2-branch-holdout-${bits}-${boundary}-${operator}`);f.block(0);
    const input=f.opaque(bits),condition=f.binary(operator,input,f.constant(bound,bits),1);
    f.conditionalBranch(condition,1,2);f.block(1).ret();f.block(2).ret();
    const ir=f.build(),before=structuredClone(ir),artifact=flowHoldoutAnalysis(ir);
    assert.equal(artifact.completeness,'complete');
    const global=artifact.facts.get(input.id);assert.ok(global);
    assert.equal(representedCount(global),total,'an edge restriction must not leak into the global input');
    for(const truth of [true,false]){
     const key=`0->${truth?1:2}:conditional-${truth?'true':'false'}`,edge=artifact.edgeFacts.get(key);
     assert.ok(edge,'actual edge publication is required');
     const expected=comparisonDenotation(bits,operator,bound,truth);
     const local=edge.facts.get(input.id)??global; // Existing edge overlay inherits global facts.
     assert.equal(edge.reachable,expected.count>0n,'impossible edges must not claim a reachable partition');
     const actualCount=edge.reachable?representedCount(local):0n;
     assert.equal(actualCount,expected.count,`${bits}/${boundary}/${operator}/${truth}`);
     if(edge.reachable){
      assert.equal(representedWithin(local,expected.range),actualCount,'equal counts alone are not equal partitions');
      const entry=artifact.blockEntryFacts.get(truth?1:2)?.get(input.id)??global;
      assert.equal(representedCount(entry),expected.count);
      assert.equal(representedWithin(entry,expected.range),expected.count);
     }
     const inputs=[...new Set([...holdoutInputs(bits),BigInt.asUintN(bits,bound-1n),bound,BigInt.asUintN(bits,bound+1n)])];
     for(const value of inputs){
      const left=operator.startsWith('s')?BigInt.asIntN(bits,value):value;
      const right=operator.startsWith('s')?BigInt.asIntN(bits,bound):bound;
      const goesTrue=operator.endsWith('lt')?left<right:left>=right;
      assert.equal(edge.reachable&&allows(local,value),goesTrue===truth,'concrete branch membership');
     }
     rows.push({bits,boundary,operator,truth,reachable:edge.reachable,expectedCount:String(expected.count),
      actualCount:String(actualCount),globalCount:String(total),strictGain:edge.reachable&&actualCount<total,concreteChecks:inputs.length});
    }
    assert.equal(flowHoldoutAnalysis(ir).publicationDigest,artifact.publicationDigest,'same-input replay must be deterministic');
    assert.deepEqual(structuredClone(ir),before);
   }
  }
 }
 assert.equal(rows.length,192);
 assert.equal(new Set(rows.map(row=>`${row.bits}/${row.boundary}/${row.operator}/${row.truth}`)).size,192);
 for(const bits of FLOW_HOLDOUT_WIDTHS)assert.ok(rows.some(row=>row.bits===bits&&row.strictGain));
 t.diagnostic(JSON.stringify({schema:'c2-heldout-branch-v1',rows,scope:'exact edge/entry partition vs edge-insensitive global fact; not whole-program transformation proof'}));
});

test('C2: held-out loop header facts retain modular reachability and terminate without partial exactness',t=>{
 const rows=[];
 for(const bits of FLOW_HOLDOUT_WIDTHS)for(const mode of ['unit-up','strided-up','strided-down']){
  const total=1n<<BigInt(bits),mask=total-1n;
  const step=mode==='unit-up'?1n:1n<<BigInt(Math.min(2,bits-1));
  const start=mode==='strided-down'?mask:1n,operator=mode==='strided-down'?'sub':'add';
  const f=fixture(`c2-loop-holdout-${bits}-${mode}`);f.block(0);
  const initial=f.constant(start,bits);f.branch(1);f.block(1);
  const counter=f.phi([[0,initial]],bits),next=f.binary(operator,counter,f.constant(step,bits),bits);
  counter.def.incoming.push({from:1,value:next});next.uses.push(counter.def);
  f.conditionalBranch(f.opaque(1),1,2);f.block(2).ret();
  const ir=f.build(),before=structuredClone(ir),artifact=flowHoldoutAnalysis(ir);
  assert.equal(artifact.completeness,'complete');assert.ok(artifact.workItems<50000,'existing work bound, not a wall-clock performance target');
  const actual=artifact.facts.get(counter.id);assert.ok(actual);
  const residue=start%step,low=step-1n;
  const reachable={...intervalFact(fullRange(bits)),knownZero:low^residue,knownOne:residue,congruence:{modulus:step,remainder:residue}};
  const reachableCount=total/step;
  assert.equal(representedCount(reachable),reachableCount);
  assert.equal(actual.knownZero&~reachable.knownZero,0n,'no free reachable bit may be fixed to zero');
  assert.equal(actual.knownOne&~reachable.knownOne,0n,'no free reachable bit may be fixed to one');
  assert.ok(actual.congruence.modulus<=step);assert.equal(actual.congruence.remainder,start%actual.congruence.modulus);
  assert.equal(representedWithin(reachable,actual.range),reachableCount,'all iterations of the modular recurrence must remain represented');
  const actualCount=representedCount(actual),intervalCount=representedCount(intervalFact(actual.range));
  assert.ok(actualCount>=reachableCount&&actualCount<=intervalCount);
  let value=start;
  for(let iteration=0;iteration<512;iteration++){
   assert.ok(allows(actual,value));value=BigInt.asUintN(bits,operator==='add'?value+step:value-step);
  }
  assert.equal(flowHoldoutAnalysis(ir).publicationDigest,artifact.publicationDigest);
  const partial=flowHoldoutAnalysis(ir,{sccpLimits:{maxWorkItems:2}});
  assert.equal(partial.completeness,'partial');assert.equal(partial.constants.size,0);
  for(const fact of partial.facts.values()){
   assert.equal(fact.status,'partial');assert.equal(fact.constant,null);assert.equal(fact.range.kind,'full');
  }
  assert.deepEqual(structuredClone(ir),before);
  rows.push({bits,mode,step:String(step),reachableCount:String(reachableCount),actualCount:String(actualCount),
   intervalCount:String(intervalCount),strictGain:actualCount<intervalCount,workItems:artifact.workItems,widened:artifact.widenedValueCount,
   concreteChecks:512,partialWithheld:true});
 }
 assert.equal(rows.length,18);
 for(const bits of FLOW_HOLDOUT_WIDTHS.filter(bits=>bits>1))assert.ok(rows.some(row=>row.bits===bits&&row.strictGain),`no loop precision gain at width ${bits}`);
 t.diagnostic(JSON.stringify({schema:'c2-heldout-loop-v1',rows,scope:'loop-header modular recurrence and analysis termination; not program termination or return-value proof'}));
});

test('C2: unresolved executable phi cycles discharge to unknown and revisit conditional edges',()=>{
 for(const bits of FLOW_HOLDOUT_WIDTHS)for(const reverse of [false,true]){
  const f=fixture(`c2-phi-debt-${bits}-${reverse}`);f.block(0);
  const initial=f.constant(1n,bits);f.branch(1);f.block(1);
  const counter=f.phi([[0,initial]],bits),step=f.constant(1n,bits);
  const cycle=f.binary('add',step,step,bits);
  cycle.def.args[0].value=cycle;cycle.uses.push(cycle.def);
  counter.def.incoming.push({from:1,value:cycle});cycle.uses.push(counter.def);
  f.conditionalBranch(f.opaque(1),1,2);
  f.block(2);
  const condition=bits===1?cycle:f.binary('eq',cycle,f.constant(0n,bits),1);
  f.conditionalBranch(condition,3,4);f.block(3).ret();f.block(4).ret();
  const ir=f.build();
  if(reverse){
   ir.values.reverse();
   for(const block of ir.blocks)block.insts.splice(0,block.insts.length-1,...block.insts.slice(0,-1).reverse());
  }
  const before=structuredClone(ir),artifact=flowHoldoutAnalysis(ir);
  assert.equal(artifact.completeness,'complete');
  for(const value of [counter,cycle]){
   assert.equal(artifact.constants.has(value.id),false,'an initialized arm is not proof about an unresolved arm');
   assert.equal(representedCount(artifact.facts.get(value.id)),1n<<BigInt(bits));
  }
  for(const key of ['2->3:conditional-true','2->4:conditional-false']){
   assert.equal(artifact.edgeFacts.get(key)?.reachable,true,'discharged branch condition must revisit both outcomes');
  }
  assert.equal(flowHoldoutAnalysis(ir).publicationDigest,artifact.publicationDigest);
  // Exercise every work cutoff before this fixed point, including debt
  // discharge itself. None may publish a provisional exact constant.
  for(let maxWorkItems=1;maxWorkItems<artifact.workItems;maxWorkItems++){
   const partial=flowHoldoutAnalysis(ir,{sccpLimits:{maxWorkItems}});
   assert.equal(partial.completeness,'partial');assert.equal(partial.constants.size,0);
   for(const fact of partial.facts.values()){
    assert.equal(fact.status,'partial');assert.equal(fact.constant,null);
    assert.equal(representedCount(fact),1n<<BigInt(fact.bits));
   }
  }
  assert.deepEqual(structuredClone(ir),before);
 }
});

test('C2: delayed executable phi producers resolve independently of instruction order',()=>{
 for(const reverse of [false,true]){
  const f=fixture(`c2-phi-delayed-${reverse}`);f.block(0);
  const initial=f.constant(7n,8);f.branch(1);f.block(1);
  const phi=f.phi([[0,initial]],8),source=f.binary('add',f.constant(2n,8),f.constant(5n,8),8);
  phi.def.incoming.push({from:1,value:source});source.uses.push(phi.def);
  f.conditionalBranch(f.opaque(1),1,2);f.block(2).ret();
  const ir=f.build();
  if(reverse)ir.blocks[1].insts.splice(0,ir.blocks[1].insts.length-1,...ir.blocks[1].insts.slice(0,-1).reverse());
  const artifact=flowHoldoutAnalysis(ir);
  assert.equal(artifact.completeness,'complete');assert.equal(artifact.constants.get(phi.id)?.value,7n);
  assert.equal(representedCount(artifact.facts.get(phi.id)),1n);
 }
});

test('C2: absent phi producers cannot borrow exactness from an initialized arm',()=>{
 const f=fixture('c2-phi-unregistered');f.block(0);
 const initial=f.constant(7n,8);f.branch(1);f.block(1);
 const missing={id:900000001,bits:8,kind:'def',def:null,uses:[]};
 const phi=f.phi([[0,initial],[0,missing]],8);f.ret(phi);
 const artifact=flowHoldoutAnalysis(f.build());
 assert.equal(artifact.completeness,'complete');assert.equal(artifact.constants.has(phi.id),false);
 assert.equal(representedCount(artifact.facts.get(phi.id)),256n);
});

// A second, pre-evaluation frozen loop corpus. Its starts span the full native
// width (including both 64-bit limbs at BV128); steps are not powers of two.
function freshLoopCases() {
 const cases=[];let seed=0x9e3779b97f4a7c15n;
 const draw=()=>seed=BigInt.asUintN(64,seed*2862933555777941757n+3037000493n);
 for(const bits of FLOW_HOLDOUT_WIDTHS)for(const step of [6n,10n,12n,20n]){
  for(const operator of ['add','sub'])for(const shape of ['self-edge','separate-body']){
   const start=BigInt.asUintN(bits,((draw()<<64n)|draw())^BigInt(cases.length));
   cases.push({id:`${bits}/${step}/${operator}/${shape}`,bits,step,start,operator,shape});
  }
 }
 return cases;
}
function integerGcd(left,right) {
 while(right!==0n){const remainder=left%right;left=right;right=remainder;}
 return left;
}

test('C2: fresh frozen non-power-of-two stride loops preserve every modular orbit',t=>{
 const rows=[];
 for(const spec of freshLoopCases()){
  const {id,bits,step,start,operator,shape}=spec,total=1n<<BigInt(bits);
  const f=fixture(`c2-fresh-loop-${id}`);f.block(0);
  const initial=f.constant(start,bits);f.branch(1);f.block(1);
  const counter=f.phi([[0,initial]],bits),body=shape==='self-edge'?1:2,exit=body+1;
  if(body!==1){f.branch(body);f.block(body);}
  const next=f.binary(operator,counter,f.constant(step,bits),bits);
  counter.def.incoming.push({from:body,value:next});next.uses.push(counter.def);
  f.conditionalBranch(f.opaque(1),1,exit);f.block(exit).ret();
  const ir=f.build(),before=structuredClone(ir),artifact=flowHoldoutAnalysis(ir);
  assert.equal(artifact.completeness,'complete',id);assert.ok(artifact.workItems<50000,id);
  const actual=artifact.facts.get(counter.id);assert.ok(actual,id);
  assert.ok(['exact','conservative'].includes(actual.status));
  // Repeated modular +/- step visits precisely one coset of gcd(step, 2^bits).
  // This integer theorem provides an all-iterations oracle, including BV128;
  // the separate finite executions below are supplemental, not its substitute.
  const modulus=integerGcd(step,total),residue=start%modulus,low=modulus-1n;
  const reachable={...intervalFact(fullRange(bits)),knownZero:low^residue,knownOne:residue,congruence:{modulus,remainder:residue}};
  const reachableCount=total/modulus;
  assert.equal(representedCount(reachable),reachableCount,id);
  assert.equal(actual.knownZero&~reachable.knownZero,0n,id);
  assert.equal(actual.knownOne&~reachable.knownOne,0n,id);
  assert.ok(actual.congruence.modulus<=modulus,id);
  assert.equal(actual.congruence.remainder,start%actual.congruence.modulus,id);
  assert.equal(representedWithin(reachable,actual.range),reachableCount,id);
  const productCount=representedCount(actual),intervalCount=representedCount(intervalFact(actual.range));
  assert.ok(productCount>=reachableCount&&productCount<=intervalCount,id);
  if(bits<=8){
   const universe=Array.from({length:2**bits},(_,i)=>BigInt(i));
   const orbit=new Set();let value=start;
   do{orbit.add(value);value=BigInt.asUintN(bits,operator==='add'?value+step:value-step);}while(value!==start);
   assert.equal(BigInt(orbit.size),reachableCount,id);
   for(const value of universe){
    assert.equal(allows(reachable,value),orbit.has(value),id);
    if(orbit.has(value))assert.ok(allows(actual,value),id);
   }
   assert.equal(BigInt(universe.filter(value=>allows(actual,value)).length),productCount,id);
  }
  let value=start;
  for(let iteration=0;iteration<257;iteration++){
   assert.ok(allows(actual,value),`${id}/${iteration}`);
   value=BigInt.asUintN(bits,operator==='add'?value+step:value-step);
  }
  assert.equal(flowHoldoutAnalysis(ir).publicationDigest,artifact.publicationDigest,id);
  const partial=flowHoldoutAnalysis(ir,{sccpLimits:{maxWorkItems:3}});
  assert.equal(partial.completeness,'partial');assert.equal(partial.constants.size,0);
  for(const fact of partial.facts.values()){
   assert.equal(fact.status,'partial');assert.equal(fact.constant,null);assert.equal(fact.range.kind,'full');
  }
  assert.deepEqual(structuredClone(ir),before,id);
  rows.push({id,bits,step:String(step),start:String(start),operator,shape,modulus:String(modulus),
   reachableCount:String(reachableCount),productCount:String(productCount),intervalCount:String(intervalCount),
   strictGain:productCount<intervalCount,workItems:artifact.workItems,widened:artifact.widenedValueCount,
   concreteChecks:257,orbitExhaustive:bits<=8,partialWithheld:true});
 }
 assert.equal(rows.length,96);assert.equal(new Set(rows.map(row=>row.id)).size,96);
 for(const bits of [8,16,32,64,128])for(const shape of ['self-edge','separate-body']){
  assert.ok(rows.some(row=>row.bits===bits&&row.shape===shape&&row.strictGain),`no fresh held-out gain at ${bits}/${shape}`);
 }
 t.diagnostic(JSON.stringify({schema:'c2-fresh-loop-holdout-v1',rows,
  scope:'actual loop-header product vs its interval-only projection; exact modular-orbit containment; no second analysis engine or real-binary claim'}));
});
