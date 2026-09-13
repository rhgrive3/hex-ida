import test from 'node:test'; import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process'; import {tmpdir} from 'node:os'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
import {fixture,workFor} from './helpers.mjs';
import {stableStringify} from '../../js/core/identity/index.js';
import {EvidenceGraph} from '../../js/core/evidence/index.js';
import {exportEvidenceCertificate} from '../../js/core/evidence/certificate.js';
import {processCertificateBundle,CERTIFICATE_BUNDLE_SCHEMA} from '../../js/core/evidence/certificate-bundle.js';
const limits={deadlineMs:10000,workUnits:1000000,nodes:100000,edges:100000,residentBytes:128*1024*1024};
async function packet(t) {
 const f=fixture(),graph=new EvidenceGraph({nodes:[{id:'source-a',family:'SemanticEvidence',binaryId:'binary-scpa-test',semanticKind:'test-only',payload:{op:'add',bits:64}},
 {id:'source-b',family:'SemanticEvidence',binaryId:'binary-scpa-test',semanticKind:'test-only',payload:{op:'sub',bits:64}}],
 edges:[{from:'source-a',to:'source-b',type:'contradicts'},{from:'source-a',to:'missing',type:'derived-from'}]});
 const {certificate}=await exportEvidenceCertificate({graph,roots:['source-a'],...f,work:workFor(t,limits)});
 return {schema:CERTIFICATE_BUNDLE_SCHEMA,world:f.world,assumptions:f.assumptions,certificates:[certificate,certificate]};
}
const run=(t,op,p)=>processCertificateBundle(op,p,{work:workFor(t,limits)});
test('bundle roundtrip preserves all cuts, contradictions and unresolved proof independently of compression',async t=>{
 const p=await packet(t),pack=await run(t,'pack',p),decoded=await run(t,'unpack',pack);
 assert.equal(stableStringify(decoded),stableStringify(p)); const replay=await run(t,'replay',pack);
 assert.deepEqual(replay.counts,{declared:2,processed:2,integrityVerified:2,rejected:0,notChecked:0});
 assert.ok(replay.reports.every(r=>r.semantic==='unknown'&&r.sourceFrontierCount>0&&r.sourceContradictionCount>0));
 assert.equal(replay.semanticProof,false); assert.equal(replay.releaseQualified,false);
});
test('tampered certificate is not hidden by packing nor by another valid member',async t=>{
 const p=structuredClone(await packet(t));p.certificates[0]=structuredClone(p.certificates[0]);p.certificates[0].nodes[0].payload.op='mul';
 const result=await run(t,'replay',await run(t,'pack',p));
 assert.deepEqual(result.counts,{declared:2,processed:2,integrityVerified:1,rejected:1,notChecked:0});
 assert.equal(result.reports[0].reason,'certificate-content-mismatch');assert.equal(result.status,'rejected');
});
for(const [name,mutate] of [ ['empty',p=>p.certificates=[]],['too-many',p=>p.certificates=Array(33).fill(p.certificates[0])],
 ['world',p=>p.world.generation='foreign'],['assumptions',p=>p.assumptions.predicates=['foreign']],['authority',p=>p.semanticProof=true],
 ['mixed',p=>p.certificateTransfer={}],['schema',p=>p.schema='v0'] ])test(`bundle rejects ${name} input`,async t=>{
 const p=structuredClone(await packet(t));mutate(p);await assert.rejects(run(t,'pack',p));
});
test('bundle checks cancellation and resource budget before returning encoded success',async t=>{
 const p=await packet(t),work=workFor(t);work.dispose();await assert.rejects(processCertificateBundle('pack',p,{work}));
 await assert.rejects(processCertificateBundle('pack',p,{work:workFor(t,{workUnits:0})}));
});
const cli=fileURLToPath(new URL('../../tools/portable-checker/bundle.mjs',import.meta.url));
function command(op,file){const r=spawnSync(process.execPath,[cli,op,file],{timeout:15000,maxBuffer:2*1024*1024,encoding:'utf8'});assert.ifError(r.error);return r;}
async function directory(t){const d=await mkdtemp(path.join(tmpdir(),'scpa-bundle-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;}
test('real local bundle CLI packs, unpacks and replays; successful transport never yields semantic success',async t=>{
 const d=await directory(t),file=path.join(d,'input.json'),out=path.join(d,'packed.json'),p=await packet(t);
 await writeFile(file,JSON.stringify(p));const packed=command('pack',file);assert.equal(packed.status,0,packed.stderr);
 await writeFile(out,packed.stdout);const unpacked=command('unpack',out);assert.equal(unpacked.status,0,unpacked.stderr);
 assert.deepEqual(JSON.parse(unpacked.stdout),p);const r=command('replay',out);assert.equal(r.status,3,r.stderr);
 assert.equal(JSON.parse(r.stdout).counts.processed,2);assert.equal(JSON.parse(r.stdout).semanticProof,false);
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')),p); // Input was never overwritten.
 const corrupt=structuredClone(p);corrupt.certificates[1].nodes[0].payload.op='mul';await writeFile(file,JSON.stringify(corrupt));
 const packedBad=command('pack',file);await writeFile(out,packedBad.stdout);assert.equal(command('replay',out).status,2);
});
test('local bundle CLI rejects directory, symlink, invalid JSON and mixed input without following it',async t=>{
 const d=await directory(t),file=path.join(d,'bad.json');await writeFile(file,'{');
 assert.equal(command('pack',file).status,1);await symlink(file,path.join(d,'link'));
 assert.equal(command('pack',path.join(d,'link')).status,1);assert.equal(command('pack',d).status,1);
 const r=command('fetch','https://example.invalid/file');assert.equal(r.status,64);
});

test('actual native worker certificate traverses the new local bundle CLI without owner laundering',{timeout:20000},async t=>{
 const {nativeWorkerFixture}=await import('./native-worker-fixture.mjs');const f=await nativeWorkerFixture(t);
 const lim={residentBytes:128*1024*1024,nodes:100000,workUnits:1000000};
 let demand=await f.invoke('demandQuery',{query:{scope:{functionIds:['0x1000','0x2000']},resultLimit:2}},lim);
 for(let i=0;demand.continuation&&i<64;i++)demand=await f.invoke('resumeDemandQuery',{cursor:demand.continuation.cursor},lim);
 assert.equal(demand.publication.status,'published');const exported=await f.invoke('explainDemandResult',{artifactId:demand.publication.artifactId,view:'certificate'},lim);
 const packet={schema:CERTIFICATE_BUNDLE_SCHEMA,world:f.world,assumptions:f.assumptions,certificates:[exported.certificate.certificate]};
 const d=await directory(t),input=path.join(d,'native.json'),compressed=path.join(d,'compressed.json');await writeFile(input,JSON.stringify(packet));
 const packed=command('pack',input);assert.equal(packed.status,0,packed.stderr);await writeFile(compressed,packed.stdout);
 const replay=command('replay',compressed);assert.equal(replay.status,3,replay.stderr);const report=JSON.parse(replay.stdout);
 assert.equal(report.counts.integrityVerified,1);assert.equal(report.reports[0].semantic,'unknown');assert.equal(report.sourceBinding,'detached-unverified');
});
