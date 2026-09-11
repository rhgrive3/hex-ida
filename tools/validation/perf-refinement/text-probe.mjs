import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=process.argv[2];const {fnv64Text,fnv64TextDigest}=await import(pathToFileURL(path.join(root,'js/core/identity/fnv64.js')));
const funcs=[s=>fnv64Text(s)+fnv64Text(s,0xcbf29ce4,0x84222325),fnv64TextDigest];let sink;
for(const length of [0,8,16,32,64,96,128,256,1024,4096]){const s='x'.repeat(length),samples=[[],[]];
for(let i=0;i<6;i++)for(const fn of funcs)for(let k=0;k<2000;k++)sink=fn(s);
for(let i=0;i<9;i++)for(const variant of [i%2,1-i%2]){const t=performance.now();for(let k=0;k<5000;k++)sink=funcs[variant](s);samples[variant].push((performance.now()-t)/5000);}
console.log(JSON.stringify({length,samples,median:samples.map(a=>a.sort((a,b)=>a-b)[4]),equal:funcs[0](s)===funcs[1](s)}));}
