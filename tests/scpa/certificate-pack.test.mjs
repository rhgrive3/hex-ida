import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor, worldInput } from './helpers.mjs';
import { EvidenceGraph } from '../../js/core/evidence/index.js';
import { stableStringify } from '../../js/core/identity/index.js';
import { exportEvidenceCertificate, replayEvidenceCertificate } from '../../js/core/evidence/certificate.js';
import { packEvidenceCertificates, unpackEvidenceCertificates, CERTIFICATE_PACK_SCHEMA } from '../../js/core/evidence/certificate-pack.js';
import { ScopedAnalysisService } from '../../js/analysis/query/scoped-service.js';
const options = (t, f) => ({ ...f, work: workFor(t, { nodes: 100000, workUnits: 500000, residentBytes: 128 * 1024 * 1024 }) });
async function source(t, count = 20) {
  const f = fixture(), prefix = 'canonical-evidence-' + 'a'.repeat(64);
  const nodes = Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, family: 'SemanticEvidence', binaryId: f.world.binarySet[0].binaryId,
    semanticKind: 'unqualified-source-view', payload: { missing: ['loop-entry-unproved', 'path-feasibility-unknown'], expression: { op: 'add', bits: 64, operands: ['input', 'constant'] } } }));
  const graph = new EvidenceGraph({ nodes, edges: nodes.slice(1).map((node, i) => ({ from: nodes[0].id, to: node.id, type: i % 5 ? 'derived-from' : 'contradicts' })) });
  graph.addEdge({ from: nodes[0].id, to: 'missing-closure', type: 'derived-from' });
  const exported = await exportEvidenceCertificate({ graph, roots: [nodes[0].id], ...options(t, f) });
  return { ...f, graph, certificate: exported.certificate };
}
async function rehash(pack) {
  const { contentSha256: _, ...body } = pack;
  const bytes = new TextEncoder().encode(stableStringify(body));
  pack.contentSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  return pack;
}
test('shared cuts round-trip every node, contradiction, missing edge, frontier and original digest', async t => {
  const f = await source(t), raw = [f.certificate, f.certificate], pack = await packEvidenceCertificates(raw, options(t, f));
  const decoded = await unpackEvidenceCertificates(pack, options(t, f));
  assert.equal(stableStringify(decoded.certificates), stableStringify(raw));
  assert.equal(decoded.proofAuthority, false); assert.equal(decoded.semantic, 'unknown');
  assert.ok(decoded.statistics.wireUtf8Bytes < decoded.statistics.expandedUtf8Bytes * .7);
  const replay = await replayEvidenceCertificate(decoded.certificates[0], options(t, f));
  assert.equal(replay.integrity, 'verified'); assert.equal(replay.semantic, 'unknown');
  assert.ok(decoded.certificates[0].frontier.some(x => x.id === 'missing-closure'));
});
test('single native-like evidence graph has measured lossless wire reduction without needing another certificate', async t => {
  const f = await source(t, 200), pack = await packEvidenceCertificates([f.certificate], options(t, f));
  const result = await unpackEvidenceCertificates(pack, options(t, f));
  assert.equal(stableStringify(result.certificates[0]), stableStringify(f.certificate));
  assert.ok(result.statistics.wireUtf8Bytes < result.statistics.expandedUtf8Bytes * .65);
  t.diagnostic(JSON.stringify(result.statistics));
});
for (const [label, change] of [
  ['world', p => p.worldId = 'foreign'], ['assumptions', p => p.assumptionsId = 'foreign'],
  ['claimed proof', p => p.proofAuthority = true], ['root', p => p.roots[0][1] = 0],
  ['payload', p => p.strings[0] += 'changed'], ['unsupported field', p => p.checker = 'trusted'],
]) test(`pack rejects ${label} corruption`, async t => {
  const f = await source(t), pack = structuredClone(await packEvidenceCertificates([f.certificate], options(t, f)));
  change(pack); await assert.rejects(unpackEvidenceCertificates(pack, options(t, f)), /certificate-pack/);
});
for (const [label, change] of [
  ['cyclic reference', p => p.entries[0] = ['a', [['r', 0]]]],
  ['forward reference', p => p.entries[0] = ['a', [['r', 1]]]],
  ['negative reference', p => p.roots[0][1] = -1],
  ['fractional reference', p => p.roots[0][1] = .5],
  ['missing string', p => p.entries[0] = ['a', [['s', p.strings.length]]]],
  ['incorrect expansion', p => p.expandedUtf8Bytes++],
  ['unused entry', p => p.entries.push(['a', []])],
  ['duplicate strings', p => p.strings.push(p.strings[0])],
  ['duplicate keys', p => p.entries[0] = ['o', [[0, null], [0, null]]]],
]) test(`even a recomputed transport digest cannot admit ${label}`, async t => {
  const f = await source(t), pack = structuredClone(await packEvidenceCertificates([f.certificate], options(t, f)));
  change(pack); await rehash(pack); await assert.rejects(unpackEvidenceCertificates(pack, options(t, f)), /certificate-pack/);
});
test('compact exponentially expanding DAG is rejected before decode', async t => {
  const f = fixture(), entries = [['a', [null]]];
  for (let i = 1; i < 30; i++) entries.push(['a', [['r', i - 1], ['r', i - 1]]]);
  const pack = await rehash({ schema: CERTIFICATE_PACK_SCHEMA, worldId: f.world.id, assumptionsId: f.assumptions.id,
    entries, strings: [], roots: [['r', 29]], expandedUtf8Bytes: 1, proofAuthority: false });
  await assert.rejects(unpackEvidenceCertificates(pack, options(t, f)), /expanded-budget/);
});
test('hostile accessors and cycles are rejected without executing getters', async t => {
  const f = await source(t); let hits = 0;
  const pack = { get schema() { hits++; throw Error('invoked'); } };
  await assert.rejects(unpackEvidenceCertificates(pack, options(t, f))); assert.equal(hits, 0);
  const cyclic = {}; cyclic.self = cyclic; await assert.rejects(packEvidenceCertificates([cyclic], options(t, f)), /cycle/);
});
test('cancellation and deterministic budget apply to pack and expansion', async t => {
  const f = await source(t), pack = await packEvidenceCertificates([f.certificate], options(t, f));
  const revision = f.graph.revision, cancelled = workFor(t); cancelled.dispose();
  await assert.rejects(packEvidenceCertificates([f.certificate], { ...f, work: cancelled }));
  await assert.rejects(unpackEvidenceCertificates(pack, { ...f, work: workFor(t, { workUnits: 1 }) }));
  assert.equal(f.graph.revision, revision);
});
test('canonical source service exports and replays the codec through existing proof routes', async t => {
  const f = await source(t), service = new ScopedAnalysisService({
    host: { configuration: { maximumSessions: 2, sessionTtlMs: 1000, getEvidenceGraph: () => f.graph },
      isCurrent: () => true, loadPipeline: async () => ({ reason: 'not-requested' }) },
    snapshot: { snapshotId: 'snap', binaryId: f.world.binarySet[0].binaryId }, worldInput: worldInput(),
  }); t.after(() => service.close());
  const exported = await service.invoke('proofSlice', { roots: f.certificate.roots, encoding: 'shared-dag-v1' }, { limits: { nodes: 100000, deadlineMs: 10000 } });
  assert.equal(exported.value.certificate, null); assert.equal(exported.value.certificateTransfer.schema, CERTIFICATE_PACK_SCHEMA);
  const replay = await service.invoke('replayProof', exported.value.certificateTransfer, { limits: { nodes: 100000, deadlineMs: 10000 } });
  assert.equal(replay.value.integrity, 'verified'); assert.equal(replay.value.semantic, 'unknown');
  assert.equal(replay.value.releaseQualified, false);
});

test('published native demand certificate packs losslessly and replays without upgrading source semantics',{timeout:18000},async t=>{
  const {nativeWorkerFixture}=await import('./native-worker-fixture.mjs');const f=await nativeWorkerFixture(t);
  const limits={residentBytes:128*1024*1024,nodes:100000,workUnits:1000000};
  let demand=await f.invoke('demandQuery',{query:{scope:{functionIds:['0x1000','0x2000']},resultLimit:2}},limits);
  for(let i=0;demand.continuation&&i<64;i++)demand=await f.invoke('resumeDemandQuery',{cursor:demand.continuation.cursor},limits);
  assert.equal(demand.publication.status,'published');
  const request={artifactId:demand.publication.artifactId,view:'certificate'};
  const original=await f.invoke('explainDemandResult',request,limits),encoded=await f.invoke('explainDemandResult',{...request,encoding:'shared-dag-v1'},limits);
  const decoded=await unpackEvidenceCertificates(encoded.certificateTransfer,options(t,f));
  assert.equal(stableStringify(decoded.certificates[0]),stableStringify(original.certificate.certificate));
  const replay=await f.invoke('replayProof',encoded.certificateTransfer,limits);assert.equal(replay.integrity,'verified');assert.equal(replay.semantic,'unknown');
  const summary=await f.invoke('explainDemandResult',{artifactId:request.artifactId},limits);
  t.diagnostic(JSON.stringify({fixtureOnly:true,nativeWorker:true,summaryUtf8Bytes:new TextEncoder().encode(stableStringify(summary)).length,
    ...decoded.statistics,explanationComplete:true,independentSemanticProof:false}));
});
test('encoder and decoder use the same expanded-node cap even for a compact repeated payload',async t=>{
  const f=await source(t),raw=structuredClone(f.certificate);raw.largePayload=Array.from({length:100001},()=>null);
  await assert.rejects(packEvidenceCertificates([raw],{...f,work:workFor(t,{workUnits:1000000,residentBytes:128*1024*1024})}),/budget|bound|limit/);
});
