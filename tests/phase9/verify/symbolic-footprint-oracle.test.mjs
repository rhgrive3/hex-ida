/** Independent oracle: literal Uint8Array writes, no production memory, Expr
 * evaluator or address helper participates in the expected byte calculation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { queryMemoryEquivalence } from '../../../js/symbolic/index.js';
import { identity,argument,literal,store,program } from './symbolic-footprint-fixtures.mjs';
const traces=[[],[['p',0,1,65]],[['q',0,1,65]],
 [['p',0,1,65],['q',0,1,66]],[['q',0,1,66],['p',0,1,65]],
 [['p',0,2,0x4241]],[['p',0,1,65],['p',1,1,66]],
 [['p',0,1,1],['p',0,1,2]],[['p',0,1,2]],
 [['p',3,2,0x1211]],[['p',3,1,17],['p',0,1,18]]];
const size=4,initial=[73,119,11,208];
function independent(trace, p, q, endian) {
 const bytes=Uint8Array.from(initial);
 for(const [which,offset,width,value]of trace)for(let byte=0;byte<width;byte++) {
  const target=((which==='p'?p:q)+offset+byte)%size;
  const position=endian==='little'?byte:width-1-byte;
  bytes[target]=Math.floor(value/(256**position))%256;
 }
 return bytes;
}
function compile(trace) {
 const p=argument('p',2),q=argument('q',2);
 return {p,q,ir:program(trace.map(([which,offset,width,value],i)=>store(which==='p'?p:q,literal(`v${i}`,width*8,value),width,BigInt(offset))))};
}
test('full symbolic write-cover agrees with independent byte oracle AND finite-domain proof',async()=>{
 let queries=0,valuations=0,byteComparisons=0;
 const pairs=[];
 for(let i=0;i<traces.length;i++){pairs.push([i,i]);pairs.push([i,(i*7+3)%traces.length]);}
 pairs.push([3,4],[5,6],[7,8],[9,10]);
 for(const endian of ['little','big'])for(const [l,r]of pairs) {
  let equivalent=true;
  for(let p=0;p<size;p++)for(let q=0;q<size;q++){
   const a=independent(traces[l],p,q,endian),b=independent(traces[r],p,q,endian);valuations++;
   for(let address=0;address<size;address++){byteComparisons++;if(a[address]!==b[address])equivalent=false;}
  }
  const before=compile(traces[l]),after=compile(traces[r]);
  const common={identity,beforeIr:before.ir,afterIr:after.ir,inputs:[{before:before.p,after:after.p},{before:before.q,after:after.q}],
    preconditions:[],backendTier:'tiered',timeoutMs:5000};
  const memory={addressBits:2,wrapping:'modular',endian,initialBytes:initial.map((n,i)=>[BigInt(i),n])};
  for(const proofMode of ['symbolic-writes','finite-domain']) {
   const result=await queryMemoryEquivalence({...common,memory:{...memory,proofMode}});queries++;
   assert.equal(result.verdict,equivalent?'proved':'refuted',`${endian} ${l}/${r} ${proofMode}: ${result.reason}`);
   assert.equal(result.eligible,equivalent);
   if(!equivalent)assert.equal(result.firstDivergence?.kind,'memory-byte');
  }
 }
 console.log(JSON.stringify({oracle:'independent-uint8array-write-cover/v1',queries,valuations,byteComparisons}));
});
