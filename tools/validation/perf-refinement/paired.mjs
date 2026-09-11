/** Same-process alternating measurements reduce run-order/JIT/host drift. */
import {createCases} from './cases.mjs';
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
const [baseArg,candidateArg,outArg]=process.argv.slice(2);
if(!baseArg||!candidateArg||!outArg)throw new Error('usage: node paired.mjs <reference-root> <candidate-root> <out.json>');
const sha=v=>createHash('sha256').update(v).digest('hex');
const digest=value=>sha(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?{$bigint:String(v)}:v instanceof Map?[...v]:v instanceof Set?[...v]:v));
const roots=[baseArg,candidateArg],all=await Promise.all(roots.map(createCases)),results=[];let sink;
for(let i=0;i<all[0].length;i++){
 const cases=all.map(a=>a[i]),n=cases[0].iterations;
 const iterations=n<10?n*5:n*4;
 for(let warm=0;warm<6;warm++)for(const variant of [warm%2,1-warm%2])for(let k=0;k<iterations;k++)sink=cases[variant].fn(k);
 const samples=[[],[]];
 for(let sample=0;sample<9;sample++)for(const variant of [sample%2,1-sample%2]){
  const start=performance.now();for(let k=0;k<iterations;k++)sink=cases[variant].fn(k);
  samples[variant].push((performance.now()-start)/iterations);
 }
 const hashes=cases.map(c=>digest(c.fn(0)));
 if(hashes[0]!==hashes[1])throw new Error(`output mismatch: ${cases[0].id}`);
 const median=s=>[...s].sort((a,b)=>a-b)[4];
 const row={id:cases[0].id,iterations,samplesMs:samples,medianMs:samples.map(median),outputSha256:hashes[0]};
 results.push(row);console.log(row.id,row.medianMs,(100*(row.medianMs[1]/row.medianMs[0]-1)).toFixed(2)+'%');
}
fs.writeFileSync(outArg,JSON.stringify({roots,node:process.version,createdAt:new Date().toISOString(),protocol:'six warmup blocks; nine alternating measured blocks per case; fixed equal iterations for both sides; no forced GC; components do not replace the 13-stage workload.',harnessSha256:sha(fs.readFileSync(new URL(import.meta.url))),casesSha256:sha(fs.readFileSync(new URL('./cases.mjs',import.meta.url))),results,outputSha256:digest(results.map(x=>[x.id,x.outputSha256])),maxRssKiB:process.resourceUsage().maxRSS},null,2)+'\n');
