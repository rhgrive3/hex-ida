import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const src=fs.readFileSync(path.join(root,'js/macho.js'),'utf8'); new Function('root',src)(globalThis);
const {parseUnwindStarts,parseUnwindLsdaEntries}=globalThis.MachO;
const BASE=0x100000000n,H=28,R=12,P=0x1000;
function alias(rows=1500,count=1022){const po=H+rows*R,b=new Uint8Array(po+P+8),d=new DataView(b.buffer);d.setUint32(0,1,true);d.setUint32(20,H,true);d.setUint32(24,rows,true);d.setUint32(po,3,true);d.setUint16(po+4,8,true);d.setUint16(po+6,count,true);for(let k=0;k<count;k++)d.setUint32(po+8+k*4,k,true);for(let i=0;i<rows;i++){const e=H+i*R;d.setUint32(e,i*P,true);d.setUint32(e+4,po,true);}return b;}
function lsda(n=32){const s=64,e=s+n*8,b=new Uint8Array(e+8),d=new DataView(b.buffer);d.setUint32(0,1,true);d.setUint32(20,H,true);d.setUint32(24,2,true);d.setUint32(H+8,s,true);d.setUint32(H+R+8,e,true);for(let k=0;k<n;k++){const x=s+k*8;d.setUint32(x,k*4+1,true);d.setUint32(x+4,k*8+1024,true);}return b;}
const one=parseUnwindStarts(alias(),BASE,{maxResults:1,maxWork:1}); assert.equal(one.length,1); assert.equal(one.truncated,true); assert.equal(one.truncationReason,'result-limit');
const stop=parseUnwindStarts(alias(4,64),BASE,{maxResults:64,maxWork:64,shouldCancel:()=>true}); assert.equal(stop.length,0); assert.equal(stop.truncated,true); assert.equal(stop.truncationReason,'cancelled');
const le=parseUnwindLsdaEntries(lsda(),BASE,{maxResults:1,maxWork:1}); assert.equal(le.length,1); assert.equal(le.truncated,true); assert.equal(le.truncationReason,'result-limit');
const legacy=fs.readFileSync(path.join(root,'js/worker-legacy.js'),'utf8'); assert.match(legacy,/maxResults: remaining, maxWork: remaining, shouldCancel:/); assert.match(legacy,/candidateBudgetHit \|\| unwindMetadataTruncated/);
const fixes=fs.readFileSync(path.join(root,'js/worker-fixes.js'),'utf8'); assert.match(fixes,/unwindStarts\.truncated[\s\S]*unwindLsdaEntries\.truncated/); assert.match(fixes,/const evidenceIncomplete = ev\.incomplete === true[\s\S]*complete: !capped/);
assert.match(fixes,/__functionEvidence\(region, slice, requestId, unwindLimit = 200_000\)/);
assert.match(fixes,/maxResults: boundedUnwindLimit, maxWork: boundedUnwindLimit/);
assert.match(fixes,/__functionEvidence\(region, slice, args\.requestId, result\.cap\)/);
assert.doesNotMatch(fixes,/parseUnwind(?:Starts|LsdaEntries)\(buf, imageBase, \{ maxResults: 200_000/);
console.log('issues #8789/#8816 caller bounds and incomplete authority: PASS');
