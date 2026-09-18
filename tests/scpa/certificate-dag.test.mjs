import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceGraph } from '../../js/core/evidence/index.js';
import { CertificateCheckerRegistry, exportEvidenceCertificate, replayEvidenceCertificate } from '../../js/core/evidence/certificate.js';
import { scheduleProofDag } from '../../js/core/evidence/proof-dag.js';
import { fixture, workFor } from './helpers.mjs';

async function replay(t, pairs, { missing = false } = {}) {
  const f = fixture(), binaryId = f.world.binarySet[0].binaryId, order = [];
  const names = [...new Set(pairs.flat())].filter(id => !missing || id !== 'missing');
  const graph = new EvidenceGraph({ nodes: names.map(id => ({ id, family: 'SemanticEvidence', binaryId,
    semanticKind: 'test-dag', origin: { byteRanges: [{ binaryId, start: '0', end: '4' }] } })),
    edges: pairs.map(([from, to]) => ({ from, to, type: 'derived-from' })) });
  const readRange = req => ({ ...req, bytes: Uint8Array.of(1, 2, 3, 4) });
  const registry = new CertificateCheckerRegistry();
  registry.register({ id: 'dag-test', version: '1', semanticKind: 'test-dag', execution: 'local-bounded', check: (node, ctx) => {
    order.push(node.id);
    for (const [, id] of pairs.filter(([from]) => from === node.id)) assert.ok(ctx.getCheckedPremise(node.id, id), `${node.id} needs ${id}`);
    return { status: 'verified', propositionChecked: true, nodeId: node.id, worldId: f.world.id, assumptionsId: f.assumptions.id };
  } });
  const exported = await exportEvidenceCertificate({ graph, roots: [names[0]], ...f, readRange, work: workFor(t) });
  const result = await replayEvidenceCertificate(exported.certificate, { ...f, readRange, work: workFor(t), checkers: registry,
    canonicalResolverExecution: 'local-bounded', resolveCanonicalNode: id => ({ worldId: f.world.id, node: graph.getNode(id) }) });
  return { result, order };
}
test('shared proof DAG checks each premise once before every dependent', async t => {
  const { result, order } = await replay(t, [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
  assert.deepEqual(order, ['d', 'b', 'c', 'a']); assert.equal(result.semantic, 'verified');
});
for (const pairs of [[['a', 'a']], [['a', 'b'], ['b', 'a']], [['parent', 'a'], ['a', 'b'], ['b', 'a']]]) {
  test(`cyclic proof ${JSON.stringify(pairs)} cannot invoke even a permissive host checker`, async t => {
    const { result, order } = await replay(t, pairs);
    assert.deepEqual(order, []); assert.equal(result.semantic, 'rejected');
    assert.ok(result.nodeResults.every(row => row.reason === 'cyclic-derivation-dependency'));
  });
}
test('a truncated premise invalidates its transitive consumers', async t => {
  const { result, order } = await replay(t, [['root', 'middle'], ['middle', 'missing']], { missing: true });
  assert.deepEqual(order, []); assert.equal(result.semantic, 'unknown');
  assert.ok(result.nodeResults.every(row => row.reason === 'derivation-premise-not-exported'));
});
test('iterative proof scheduler handles 20000 deep nodes without recursive stack or path expansion', t => {
  const nodes = new Map(Array.from({ length: 20000 }, (_, i) => [String(i), {}]));
  const edges = Array.from({ length: 19999 }, (_, i) => ({ from: String(i), to: String(i + 1), type: 'derived-from' }));
  const work = workFor(t, { workUnits: 100000, residentBytes: 16 * 1024 * 1024 });
  const r = scheduleProofDag(nodes, edges, { work });
  assert.equal(r.order.length, 20000); assert.equal(r.order[0], '19999'); assert.equal(r.blocked.size, 0);
  assert.ok(work.cost().used.workUnits < 5 * nodes.size);
});
