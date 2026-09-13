import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';
import { workFor } from './helpers.mjs';
import { replayPortableChecks, normalizePortableChecks, PORTABLE_CHECK_SCHEMA, PORTABLE_CHECK_LIMITS } from '../../js/core/evidence/portable-replay.js';
import { INTEGER_FRAGMENT_SCHEMA, INTEGER_FRAGMENT_RULE, INTEGER_FRAGMENT_RULE_VERSION, INTEGER_FRAGMENT_DOMAIN } from '../../js/core/evidence/arm64-integer-fragment.js';
const rows = (text = '#0x10') => ({ '0x1000': [
  ['mov', 'x9, #0x1ff0', 0xd283fe09], ['add', `x9, x9, ${text}`, 0x91004129],
  ['str', 'x9, [sp]', 0xf90003e9], ['ret', '', 0xd65f03c0],
] });
const plain = () => ({ schema: PORTABLE_CHECK_SCHEMA,
  binding: { worldId:'w',assumptionsId:'a',snapshotId:'s',binaryId:'b',functionId:'f',functionLocator:'0x1000',producerArtifactId:'p' },
  checks: [{id:'read',bytesHex:'09fe83d229410091', fragment:{schema:INTEGER_FRAGMENT_SCHEMA,ruleId:INTEGER_FRAGMENT_RULE,
    ruleVersion:INTEGER_FRAGMENT_RULE_VERSION,worldId:'w',assumptionsId:'a',snapshotId:'s',functionId:'f',
    profile:{isaRevision:'aarch64-v8',endianness:'le',addressBits:64},domain:INTEGER_FRAGMENT_DOMAIN,
    source:{binaryId:'b',start:'64',boundary:'72',end:'76',virtualStart:'4096',virtualBoundary:'4104'},
    rangeLocalId:3,semanticValueId:'v',conclusion:{register:'x9',bits:64,constant:'8192',knownZero:'18446744073709543423',knownOne:'8192',range:{kind:'interval',lower:'8192',upper:'8192'}} }}], remaining:[] });
const replay = (t, c=plain(), limits={}) => replayPortableChecks(c,{work:workFor(t,limits)});

test('detached pure replay checks listed integer derivations without granting current-source or whole-query proof',async t=>{
  const r=await replay(t); assert.equal(r.counts.verified,1); assert.equal(r.allListedDerivationsChecked,true);
  assert.equal(r.sourceBinding,'detached-unverified'); assert.equal(r.semanticProof,false); assert.equal(r.wholeQueryProof,false);
  assert.equal(r.executableCodeAccepted,false); assert.ok(Object.isFrozen(r));
});
test('native service exports actual owner proposals and bytes to the same pure checker, then rebinds them',async t=>{
  const f=await nativeWorkerFixture(t,{rowsByLocator:rows()}),r=await f.invoke('portableIntegerChecks',{functionId:'0x1000'});
  assert.equal(r.status,'completed'); assert.equal(r.sourceBinding,'current-native-owner-and-source-bytes');
  const checks=[...r.capsule.checks].sort((a,b)=>a.fragment.conclusion.constant.localeCompare(b.fragment.conclusion.constant));
  assert.deepEqual(checks.map(row=>[row.fragment.conclusion.constant,row.bytesHex]),[['8176','09fe83d2'],['8192','09fe83d229410091']]);
  assert.equal(new Set(checks.map(row=>row.fragment.semanticValueId)).size,2); assert.equal(r.replay.counts.verified,2);
  assert.equal(r.semanticProof,false); assert.equal(r.capsuleRebound,false);
  const rebound=await f.invoke('portableIntegerChecks',{functionId:'0x1000',capsule:r.capsule});
  assert.equal(rebound.status,'completed'); assert.equal(rebound.capsuleRebound,true); assert.equal(rebound.releaseQualified,false);
});
test('live rebind refuses changed bytes and changed owner conclusions without treating old detached success as authority',async t=>{
  const f=await nativeWorkerFixture(t,{rowsByLocator:rows()}),r=await f.invoke('portableIntegerChecks',{functionId:'0x1000'});
  const changed=structuredClone(r.capsule); changed.checks[0].fragment.conclusion.constant='8193';
  assert.equal((await f.invoke('portableIntegerChecks',{functionId:'0x1000',capsule:changed})).status,'rejected');
  f.data[64]^=0x20;
  const stale=await f.invoke('portableIntegerChecks',{functionId:'0x1000',capsule:r.capsule});
  assert.equal(stale.status,'rejected'); assert.equal(stale.capsuleRebound,false); assert.equal(stale.sourceBinding,'mismatch');
});
test('independent checker rejects actual native mnemonic/byte disagreement',async t=>{
  const f=await nativeWorkerFixture(t,{rowsByLocator:rows('#0x11')}),r=await f.invoke('portableIntegerChecks',{functionId:'0x1000'});
  assert.equal(r.status,'completed'); assert.equal(r.replay.counts.rejected,1); assert.equal(r.semanticProof,false);
});
test('unsupported prefixes remain unknown',async t=>{
  const c=plain(); c.checks[0].bytesHex='1f2003d529410091';
  const r=await replay(t,c); assert.equal(r.counts.unknown,1); assert.equal(r.allListedDerivationsChecked,false);
});
test('empty capsule never becomes an all-proved result',async t=>{
  const c=plain(); c.checks=[]; const r=await replay(t,c); assert.equal(r.allListedDerivationsChecked,false); assert.equal(r.counts.verified,0);
});
for(const [name,mutate] of [
  ['rule',c=>c.checks[0].fragment.ruleId='remote-code'],['version',c=>c.checks[0].fragment.ruleVersion='999'],
  ['domain',c=>c.checks[0].fragment.domain={}],['endianness',c=>c.checks[0].fragment.profile.endianness='be'],
  ['bits',c=>c.checks[0].fragment.profile.addressBits=32],['isa',c=>c.checks[0].fragment.profile.isaRevision='unknown'],
]) test(`unsupported ${name} is unknown, never dynamically loaded`,async t=>{const c=plain();mutate(c);assert.equal((await replay(t,c)).counts.unknown,1);});
for(const [name,mutate] of [
  ['extra root',c=>c.evaluate='code'],['extra checker',c=>c.checks[0].provider='remote'],['schema',c=>c.schema='v0'],
  ['world',c=>c.checks[0].fragment.worldId='other'],['snapshot',c=>c.binding.snapshotId='other'],
  ['binary',c=>c.checks[0].fragment.source.binaryId='other'],['missing binding',c=>delete c.binding.producerArtifactId],
  ['duplicate checks',c=>c.checks.push(structuredClone(c.checks[0]))],['too many checks',c=>c.checks=Array(17).fill(c.checks[0])],
  ['truncated bytes',c=>c.checks[0].bytesHex='00'],['uppercase bytes',c=>c.checks[0].bytesHex=c.checks[0].bytesHex.toUpperCase()],
  ['wrong boundary',c=>c.checks[0].fragment.source.end='80'],['unaligned virtual',c=>c.checks[0].fragment.source.virtualStart='4097'],
  ['oversized address',c=>c.checks[0].fragment.source.start='18446744073709551616'],
  ['negative address',c=>c.checks[0].fragment.source.start='-1'],['accessor',c=>Object.defineProperty(c,'remaining',{get(){throw Error('must not run')}})],
  ['cyclic',c=>c.remaining=[c]],['executable',c=>c.remaining=[()=>1]],
]) test(`portable capsule rejects ${name}`,async t=>{const c=plain();mutate(c);await assert.rejects(replay(t,c));});
test('parent work and memory exhaustion cannot return partial success',async t=>{
  await assert.rejects(replay(t,plain(),{workUnits:0})); await assert.rejects(replay(t,plain(),{residentBytes:8}));
});
test('native query rejects user-supplied reader and returns no proof after host retirement',async t=>{
  const f=await nativeWorkerFixture(t,{rowsByLocator:rows()});
  await assert.rejects(f.invoke('portableIntegerChecks',{functionId:'0x1000',readRange:()=>null}));
  f.retire(); await assert.rejects(f.invoke('portableIntegerChecks',{functionId:'0x1000'}),/stale/);
});
const cli=fileURLToPath(new URL('../../tools/portable-checker/check.mjs',import.meta.url));
async function dirFor(t){const dir=await mkdtemp(path.join(tmpdir(),'scpa-portable-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
function run(file){const r=spawnSync(process.execPath,[cli,file],{timeout:8000,maxBuffer:262144,encoding:'utf8'});assert.ifError(r.error);return r;}
test('CLI exit codes distinguish checked, rejected and unknown without inventing semantic proof',async t=>{
  const dir=await dirFor(t),file=path.join(dir,'capsule.json');
  for(const [expected,mutate] of [[0,()=>{}],[2,c=>c.checks[0].bytesHex='29fe83d229410091'],[3,c=>c.checks=[]]]){
    const c=plain();mutate(c);await writeFile(file,JSON.stringify(c));const r=run(file);assert.equal(r.status,expected,r.stderr);
    assert.equal(JSON.parse(r.stdout).semanticProof,false);
  }
});
test('CLI rejects malformed, oversized, non-UTF8, directory, missing and symlink inputs',async t=>{
  const dir=await dirFor(t),file=path.join(dir,'capsule.json');
  for(const bytes of ['{',Buffer.alloc(PORTABLE_CHECK_LIMITS.encodedBytes+1,32),Buffer.from([255,254])]){
    await writeFile(file,bytes); const r=run(file);assert.equal(r.status,1);assert.equal(JSON.parse(r.stderr).semanticProof,false);
  }
  assert.equal(run(dir).status,1);assert.equal(run(path.join(dir,'missing')).status,1);
  await symlink(file,path.join(dir,'link'));assert.equal(run(path.join(dir,'link')).status,1);
});
test('CLI refuses FIFO without blocking on a writer',async t=>{
  if(process.platform==='win32'){t.skip('FIFO is a POSIX boundary');return;}
  const dir=await dirFor(t),file=path.join(dir,'fifo');const made=spawnSync('mkfifo',[file],{timeout:1000});
  assert.equal(made.status,0);assert.equal(run(file).status,1);
});
test('portable browser import closure is confined to core JS and contains no native, Node or evaluator dependency',async()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url)),queue=['js/core/evidence/portable-replay.js'],seen=new Set();
  while(queue.length){const rel=queue.pop();if(seen.has(rel))continue;seen.add(rel);assert.ok(rel.startsWith('js/core/'),rel);
    const source=await readFile(path.join(root,rel),'utf8');
    assert.doesNotMatch(source,/\b(?:eval|Function)\s*\(|\bimport\s*\(/,rel);
    for(const match of source.matchAll(/\b(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/g)){
      assert.ok(match[1].startsWith('.'),`${rel}: ${match[1]}`);queue.push(path.normalize(path.join(path.dirname(rel),match[1])));
    }
  }
  assert.ok(seen.has('js/core/evidence/arm64-integer-fragment.js'));assert.ok(seen.size<32);
});
for(const isaRevision of ['arm64:effects@7','arm64:effects@7.0.0'])test(`portable profile agrees with native producer ${isaRevision}`,async t=>{
 const c=plain();c.checks[0].fragment.profile.isaRevision=isaRevision;const r=await replay(t,c);
 assert.equal(r.counts.verified,1);assert.equal(r.wholeQueryProof,false);assert.equal(r.sourceBinding,'detached-unverified');
});
for(const isaRevision of [['arm64:effects@7.0.0'],'arm64:effects@7junk','arm64:effects@7.0','arm64:effects@07','x86:effects@7'])test(`profile is exact primitive identity: ${JSON.stringify(isaRevision)}`,async t=>{
 const c=plain();c.checks[0].fragment.profile.isaRevision=isaRevision;const r=await replay(t,c);assert.equal(r.counts.unknown,1);
});
