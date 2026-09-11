import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../../js/core/identity/origin.js';
import * as oracle from '../helpers/origin-normalization-oracle.mjs';
const rnd = (()=>{let s=0x415241;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s;};})();
const record = (i,negative=false) => ({instructionIds:[`i${i}`,`a${i%13}`], operationIds:[`o${i%7}`],
 byteRanges:[{start:i,end:i+4}], sourceLocations:[{line:i%17,zero:negative?-0:0}],parentEntityIds:[`p${i%19}`]});
function compare(inputs) {
 const a=inputs.map(candidate.createOriginSet),b=inputs.map(oracle.createOriginSet);
 const actual=candidate.mergeOriginSets(...a), expected=oracle.mergeOriginSets(...b);
 assert.deepStrictEqual(actual,expected);
 for (const key of Object.keys(actual)) if (Array.isArray(actual[key])) assert.ok(Object.isFrozen(actual[key]));
 assert.ok(Object.isFrozen(actual)); return actual;
}
test('refinement: 300 randomized origin unions preserve order, deduplication and signs',()=>{
 for(let t=0;t<300;t++) compare(Array.from({length:rnd()%12},()=>record(rnd()%130,!!(rnd()%2))));
});
test('refinement: two sorted origin lists merge interleaved, identical and disjoint keys',()=>{
 for (const offset of [0,1,10000]) {
  const left={instructionIds:Array.from({length:2048},(_,i)=>`i${i*2}`)};
  const right={instructionIds:Array.from({length:2048},(_,i)=>`i${i*2+offset}`)}; compare([left,right]);
 }
});
test('refinement: large fan-in remains a single union with last-value-wins',()=>{
 for (const n of [1,2,3,32,257]) compare(Array.from({length:n},(_,i)=>record(i%23,!!(i%2))));
});
test('refinement: empty inputs and repeated branded unions remain reusable',()=>{
 const x=candidate.createOriginSet(record(1)); let z=x;
 for (let i=0;i<100;i++) {z=candidate.mergeOriginSets(null,z,undefined,candidate.createOriginSet({}));assert.deepStrictEqual(z,x);}
 assert.equal(candidate.createOriginSet(z),z);
});

test('refinement: modified sorting observes entry pairs and remains safe after restoration',()=>{
 const original=Array.prototype.sort; let actual,expected,unusual,unusualOracle;
 const a=candidate.createOriginSet({instructionIds:['a','b']}),b=candidate.createOriginSet({instructionIds:['b','c']});
 try {
  Array.prototype.sort=function(compare){const result=original.call(this,compare);return this.length&&Array.isArray(this[0])?result.reverse():result;};
  actual=candidate.mergeOriginSets(a,b);expected=oracle.mergeOriginSets(a,b);
  unusual=candidate.createOriginSet({instructionIds:['a','c','e']});unusualOracle=oracle.createOriginSet({instructionIds:['a','c','e']});
 } finally{Array.prototype.sort=original;}
 assert.deepStrictEqual(actual,expected);
 assert.deepStrictEqual(candidate.mergeOriginSets(unusual,b),oracle.mergeOriginSets(unusualOracle,b));
});

test('refinement: a sort hook that restores itself cannot certify nonstandard order',()=>{
 const original=Array.prototype.sort;
 const raw={instructionIds:Array.from({length:40},(_,i)=>`i${i}`)};
 function make(module){try{Array.prototype.sort=function(compare){if(this.length < 2) return original.call(this,compare);Array.prototype.sort=original;return original.call(this,compare).reverse();};return module.createOriginSet(raw);}finally{Array.prototype.sort=original;}}
 const actual=make(candidate),expected=make(oracle);
 assert.deepStrictEqual(actual,expected);
 const b={instructionIds:['i0','i50','i75']};
 assert.deepStrictEqual(candidate.mergeOriginSets(actual,candidate.createOriginSet(b)),oracle.mergeOriginSets(expected,b));
});
