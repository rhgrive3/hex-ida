import test from 'node:test';
import assert from 'node:assert/strict';
import { bitvector } from '../../../js/decompiler/phase8/bitvector.js';
import { fullRange, rangeOf, factFromRange, fullFact, emptyFact, singletonFact,
 contains, joinFacts, widenFacts, evaluateBinaryFact } from '../../../js/decompiler/phase8/range.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { seedAnalysisState, runPassTransaction } from '../../../js/decompiler/phase8/transaction.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

const WIDTHS=Object.freeze([1,8,16,32,64,128]);
const OPERATORS=Object.freeze(['add','sub','mul','and','or','xor','shl','lshr','ashr',
 'udiv','sdiv','urem','srem','eq','ne','ult','ule','ugt','uge','slt','sle','sgt','sge']);
const gcd=(a,b)=>{while(b){const next=a%b;a=b;b=next;}return a;};
const absolute=n=>n<0n?-n:n;
const projection=f=>({bits:f.bits,range:f.range,knownZero:f.knownZero,knownOne:f.knownOne,congruence:f.congruence});
function effectiveBits(fact) {
 const {modulus,remainder}=fact.congruence;
 assert.ok(modulus>0n&&(modulus&(modulus-1n))===0n);
 return {zero:fact.knownZero|((modulus-1n)^remainder),one:fact.knownOne|remainder};
}
function allows(fact,value) {
 return contains(fact.range,value)&&(value&fact.knownZero)===0n&&(value&fact.knownOne)===fact.knownOne
  &&value%fact.congruence.modulus===fact.congruence.remainder;
}
function maskDomains(bits) {
 const sign=1n<<BigInt(bits-1),modulus=1n<<BigInt(Math.min(bits,2)),mask=(1n<<BigInt(bits))-1n;
 let alternating=0n;for(let i=0;i<bits;i+=2)alternating|=1n<<BigInt(i);
 return [
  ['full',{}],['low-zero',{knownZero:1n}],['low-one',{knownOne:1n}],
  ['high-zero',{knownZero:sign}],['high-one',{knownOne:sign}],
  ['alternating',{knownZero:alternating,knownOne:mask^alternating}],
  ['residue-zero',{congruence:{modulus,remainder:0n}}],
  ['residue-one',{congruence:{modulus,remainder:1n}}],
  ['mixed',{knownZero:sign&~(modulus-1n),congruence:{modulus,remainder:1n}}],
 ].map(([name,options])=>({name,fact:factFromRange(fullRange(bits),options)}));
}
function assertFullDomainInclusion(source,target) {
 assert.equal(source.range.kind,'full');assert.equal(target.range.kind,'full');
 const a=effectiveBits(source),b=effectiveBits(target);
 assert.equal(a.zero&a.one,0n);assert.equal(b.zero&~a.zero,0n);assert.equal(b.one&~a.one,0n);
}

test('C2 domain contract: all-width known-bit and congruence joins obey bounded lattice laws',t=>{
 let pairs=0,triples=0;
 for(const bits of WIDTHS){
  const domains=maskDomains(bits),top=fullFact(bits),bottom=emptyFact(bits);
  assert.equal(domains.length,9);
  for(const {fact:a} of domains){
   assert.equal(a.status,'conservative');
   assert.deepEqual(projection(joinFacts(a,a)),projection(a),'idempotence');
   assert.deepEqual(projection(joinFacts(a,bottom)),projection(a),'bottom identity');
   assert.deepEqual(projection(joinFacts(bottom,a)),projection(a));
   assert.deepEqual(projection(joinFacts(a,top)),projection(top),'top absorption');
   for(const {fact:b} of domains){
    const joined=joinFacts(a,b),wide=widenFacts(a,joined);
    assert.deepEqual(projection(joined),projection(joinFacts(b,a)),'commutativity');
    assert.equal(joined.knownZero,a.knownZero&b.knownZero);
    assert.equal(joined.knownOne,a.knownOne&b.knownOne);
    const modulus=gcd(gcd(a.congruence.modulus,b.congruence.modulus),absolute(a.congruence.remainder-b.congruence.remainder));
    assert.deepEqual(joined.congruence,{modulus,remainder:a.congruence.remainder%modulus});
    for(const source of [a,b]){assertFullDomainInclusion(source,joined);assertFullDomainInclusion(source,wide);}
    const repeated=widenFacts(wide,joinFacts(wide,b));
    assert.deepEqual(projection(repeated),projection(wide),'widened projection stabilizes');
    pairs++;
    for(const {fact:c} of domains){
     assert.deepEqual(projection(joinFacts(joined,c)),projection(joinFacts(a,joinFacts(b,c))),
      'known-bit/congruence associativity on a common full interval domain');
     assertFullDomainInclusion(joined,joinFacts(joined,c));triples++;
    }
   }
  }
 }
 assert.equal(pairs,486);assert.equal(triples,4374);
 t.diagnostic(JSON.stringify({schema:'c2-domain-laws-v1',widths:WIDTHS,domainsPerWidth:9,pairs,triples,
  scope:'full-interval known-bit/congruence product laws; not associativity of arbitrary circular interval hulls'}));
});

function concreteInputs(fact) {
 if(fact.bits<=8)return Array.from({length:2**fact.bits},(_,i)=>BigInt(i)).filter(value=>allows(fact,value));
 const mask=(1n<<BigInt(fact.bits))-1n,sign=1n<<BigInt(fact.bits-1),{zero,one}=effectiveBits(fact);
 const free=mask&~(zero|one),values=[0n,1n,mask,sign,sign-1n,fact.range.lower,fact.range.upper];
 let seed=0x6a09e667f3bcc909n;
 const draw=()=>seed=BigInt.asUintN(64,6364136223846793005n*seed+1442695040888963407n);
 for(let i=0;i<16;i++)values.push(((draw()<<64n)|draw())&mask);
 return [...new Set(values.flatMap(value=>[value,(value&free)|one]))].filter(value=>allows(fact,value));
}
// Independent integer/BV reference; null denotes an operation without defined
// generic semantics, never a result to be folded. No production evaluator here.
function concreteBinary(operator,left,right,bits) {
 const signedLeft=BigInt.asIntN(bits,left),signedRight=BigInt.asIntN(bits,right),min=-(1n<<BigInt(bits-1));
 if(['shl','lshr','ashr'].includes(operator)&&right>=BigInt(bits))return null;
 if(['udiv','sdiv','urem','srem'].includes(operator)&&right===0n)return null;
 if(['sdiv','srem'].includes(operator)&&signedLeft===min&&signedRight===-1n)return null;
 let result;
 switch(operator){
  case 'add':result=left+right;break;case 'sub':result=left-right;break;case 'mul':result=left*right;break;
  case 'and':result=left&right;break;case 'or':result=left|right;break;case 'xor':result=left^right;break;
  case 'shl':result=left<<right;break;case 'lshr':result=left>>right;break;case 'ashr':result=signedLeft>>right;break;
  case 'udiv':result=left/right;break;case 'urem':result=left%right;break;
  case 'sdiv':result=signedLeft/signedRight;break;case 'srem':result=signedLeft%signedRight;break;
  case 'eq':return left===right?1n:0n;case 'ne':return left!==right?1n:0n;
  case 'ult':return left<right?1n:0n;case 'ule':return left<=right?1n:0n;
  case 'ugt':return left>right?1n:0n;case 'uge':return left>=right?1n:0n;
  case 'slt':return signedLeft<signedRight?1n:0n;case 'sle':return signedLeft<=signedRight?1n:0n;
  case 'sgt':return signedLeft>signedRight?1n:0n;case 'sge':return signedLeft>=signedRight?1n:0n;
  default:throw Error('unlisted reference operator');
 }
 return BigInt.asUintN(bits,result);
}

test('C2 domain contract: width and binary-operator matrix includes wrap, signedness and explicit refusals',t=>{
 let cells=0,concreteChecks=0,undefinedChecks=0;const rows=[];
 for(const bits of WIDTHS){
  const total=1n<<BigInt(bits),sign=total>>1n,mask=total-1n;
  const lefts=[...maskDomains(bits),
   {name:'wrapped',fact:factFromRange(rangeOf(total-2n,1n,bits))},
   {name:'sign-crossing',fact:factFromRange(rangeOf(sign-1n,sign,bits))},
   {name:'unsigned-end',fact:factFromRange(rangeOf(total-2n,mask,bits))}];
  const rights=[...[["zero",0n],["one",1n],["last-shift",BigInt(bits-1)],["overshift",BigInt(bits)],["unsigned-max",mask]]
   .map(([name,value])=>({name,fact:singletonFact(bitvector(value,bits))})),{name:'variable',fact:fullFact(bits)}];
  for(const operator of OPERATORS){
   let defined=0,undefinedCount=0;
   for(const left of lefts)for(const right of rights){
    const actual=evaluateBinaryFact(operator,left.fact,right.fact),a=concreteInputs(left.fact),b=concreteInputs(right.fact);
    assert.ok(a.length>0&&b.length>0,'no vacuous input cell');
    const comparison=OPERATORS.indexOf(operator)>=13;
    assert.equal(actual.bits,comparison?1:bits);
    for(const x of a)for(const y of b){
     const expected=concreteBinary(operator,x,y,bits);
     if(expected===null){
      assert.equal(actual.constant,null,`${bits}/${operator}: undefined input cannot authorize a constant`);
      undefinedCount++;continue;
     }
     assert.ok(allows(actual,expected),`${bits}/${operator}/${left.name}/${right.name}: ${x},${y} -> ${expected}`);
     defined++;
    }
    cells++;
   }
   rows.push({bits,operator,cells:lefts.length*rights.length,concreteChecks:defined,undefinedChecks:undefinedCount,
    inputExhaustive:bits<=8});concreteChecks+=defined;undefinedChecks+=undefinedCount;
  }
 }
 assert.equal(rows.length,138);assert.equal(cells,9936);assert.ok(concreteChecks>0&&undefinedChecks>0);
 t.diagnostic(JSON.stringify({schema:'c2-width-operator-v1',rows,cells,concreteChecks,undefinedChecks,
 scope:'all listed widths/operators; exhaustive concrete input sets through BV8, fixed native boundary and two-limb samples; no exhaustive native transfer proof'}));
});

function comparisonPartition(bits,operator,bound,truth) {
 const total=1n<<BigInt(bits),signed=operator.startsWith('s'),min=signed?-(total>>1n):0n,last=signed?(total>>1n)-1n:total-1n;
 if(operator==='eq'||operator==='ne'){
  const equal=(operator==='eq')===truth;
  return {count:equal?1n:total-1n,exactRange:equal?{kind:'interval',lower:bound,upper:bound}:null};
 }
 const threshold=signed?BigInt.asIntN(bits,bound):bound,op=operator.slice(1);
 let low,high;
 if(op==='lt'){low=min;high=threshold-1n;}else if(op==='le'){low=min;high=threshold;}
 else if(op==='gt'){low=threshold+1n;high=last;}else {assert.equal(op,'ge');low=threshold;high=last;}
 if(!truth){
  if(op==='lt'||op==='le'){low=high+1n;high=last;}else {high=low-1n;low=min;}
 }
 if(low>high)return {count:0n,exactRange:{kind:'empty'}};
 const count=high-low+1n,lower=BigInt.asUintN(bits,low),upper=BigInt.asUintN(bits,high);
 if(count===total)return {count,exactRange:{kind:'full',lower:0n,upper:total-1n}};
 return {count,exactRange:{kind:lower<=upper?'interval':'wrapped',lower,upper}};
}

test('C2 domain contract: every comparison publishes sound native-width branch partitions',t=>{
 let edges=0,concreteChecks=0;const rows=[];
 for(const bits of WIDTHS){
  const total=1n<<BigInt(bits),sign=total>>1n;
  for(const [operator,bound,truth]of [['slt',sign,false],['sge',sign,true],['sle',sign-1n,true],['sgt',sign-1n,false]]){
   assert.deepEqual(comparisonPartition(bits,operator,bound,truth),
    {count:total,exactRange:{kind:'full',lower:0n,upper:total-1n}},'full signed domain has canonical unsigned storage endpoints');
  }
  for(const operator of OPERATORS.slice(13))for(const [name,bound]of [['zero',0n],['signed-max',sign-1n],['sign-bit',sign],['unsigned-max',total-1n]]){
   const f=fixture(`c2-contract-edge-${bits}-${operator}-${name}`);f.block(0);
   const input=f.opaque(bits),condition=f.binary(operator,input,f.constant(bound,bits),1);
   f.conditionalBranch(condition,1,2);f.block(1).ret();f.block(2).ret();
   const ir=f.build(),before=structuredClone(ir),state=seedAnalysisState(ir);
   const outcome=runPassTransaction(state,{descriptor:SCCP_PASS,run:runSccpPass},{analysis:state,ir},{});
   assert.equal(outcome.committed,true);const artifact=state.get('ranges');assert.equal(artifact.completeness,'complete');
   const global=artifact.facts.get(input.id);assert.deepEqual(projection(global),projection(fullFact(bits)),'path facts remain local');
   for(const truth of [true,false]){
    const destination=truth?1:2,key=`0->${destination}:conditional-${truth?'true':'false'}`;
    const edge=artifact.edgeFacts.get(key);assert.ok(edge,key);
    const expected=comparisonPartition(bits,operator,bound,truth),actual=edge.facts.get(input.id)??global;
    assert.equal(edge.reachable,expected.count>0n);
    if(edge.reachable&&expected.exactRange){
     for(const fact of [actual,artifact.blockEntryFacts.get(destination)?.get(input.id)??global]){
      assert.equal(fact.range.kind,expected.exactRange.kind);
      assert.equal(fact.range.lower,expected.exactRange.lower);assert.equal(fact.range.upper,expected.exactRange.upper);
     }
    }
    const samples=[...new Set([...concreteInputs(global),BigInt.asUintN(bits,bound-1n),bound,BigInt.asUintN(bits,bound+1n)])];
    for(const value of samples){
     const belongs=concreteBinary(operator,value,bound,bits)===(truth?1n:0n);
     if(belongs)assert.ok(edge.reachable&&allows(actual,value),'no concrete branch value may be lost');
     if(expected.exactRange)assert.equal(edge.reachable&&allows(actual,value),belongs,'ordered partition is exact');
     concreteChecks++;
    }
    rows.push({bits,operator,boundary:name,truth,reachable:edge.reachable,expectedCount:String(expected.count),
     precision:expected.exactRange?'exact-partition':'conservative-disequality-complement'});edges++;
   }
   assert.deepEqual(structuredClone(ir),before);
  }
 }
 assert.equal(edges,480);assert.equal(rows.length,480);
 t.diagnostic(JSON.stringify({schema:'c2-comparison-edges-v1',rows,edges,concreteChecks,
  scope:'actual SCCP edge and entry publication; disequality complement remains conservative by contract'}));
});
