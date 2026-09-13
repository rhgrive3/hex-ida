import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceGraph } from '../../js/core/evidence/index.js';
import { CertificateCheckerRegistry, exportEvidenceCertificate, replayEvidenceCertificate } from '../../js/core/evidence/certificate.js';
import { registerRangeProofKernel, RANGE_PROOF_KIND, RANGE_PROOF_SCHEMA, RANGE_PROOF_VERSION, integerFragmentProofScope } from '../../js/core/evidence/range-proof-kernel.js';
import { checkIntegerFragmentBytes, INTEGER_FRAGMENT_KIND, INTEGER_FRAGMENT_DOMAIN } from '../../js/core/evidence/arm64-integer-fragment.js';
import { fixture, workFor } from './helpers.mjs';

async function run(t, mutate = () => {}, primitiveStatus = 'verified') {
  const f = fixture(), binaryId = f.world.binarySet[0].binaryId, work = workFor(t);
  const fragment = { worldId: f.world.id, assumptionsId: f.assumptions.id, snapshotId: 'snapshot', functionId: 'function',
    source: { binaryId, start: '0', boundary: '4', end: '8', virtualStart: '4096', virtualBoundary: '4100' },
    semanticValueId: 'v', conclusion: { register: 'x0', bits: 64, constant: '7', knownZero: '18446744073709551608', knownOne: '7',
      range: { kind: 'interval', lower: '7', upper: '7' } } };
  const conclusion = (lower, upper) => ({ kind: 'unsigned-range', subject: 'v', bits: 64, lower: String(lower), upper: String(upper) });
  const scope = integerFragmentProofScope(fragment);
  const ruleNode = (id, rule, premises, value) => ({ id, binaryId, family: 'DataflowEvidence', semanticKind: RANGE_PROOF_KIND,
    payload: { rule: { schema: RANGE_PROOF_SCHEMA, version: RANGE_PROOF_VERSION, rule, scope, premises, conclusion: value } } });
  const rows = [
    { id: 'primitive', binaryId, family: 'DataflowEvidence', semanticKind: INTEGER_FRAGMENT_KIND,
      origin: { byteRanges: [{ binaryId, start: '0', end: '4' }] }, payload: { fragment } },
    ruleNode('project', 'integer-range-projection', ['primitive'], conclusion(7, 7)),
    ruleNode('left', 'range-weaken', ['project'], conclusion(0, 7)),
    ruleNode('right', 'range-weaken', ['project'], conclusion(7, 20)),
    ruleNode('root', 'range-intersection', ['left', 'right'], conclusion(7, 7)),
  ];
  const input = { nodes: rows.map(row => structuredClone(row)), edges: rows.flatMap(row => (row.payload.rule?.premises ?? []).map(to => ({ from: row.id, to, type: 'derived-from' }))) };
  mutate(input);
  const graph = new EvidenceGraph(input), bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, 0xd28000e0, true);
  const readRange = req => ({ ...req, bytes: bytes.slice() });
  const registry = new CertificateCheckerRegistry();
  // This adapter isolates composition protocol from native owner reconstruction,
  // covered by integer-native-replay; its arithmetic is the production checker.
  registry.register({ id: 'integer-composition-fixture', version: '1', semanticKind: INTEGER_FRAGMENT_KIND, execution: 'local-bounded',
    check: (node, ctx) => {
      const result = checkIntegerFragmentBytes(ctx.getVerifiedBytes('primitive', binaryId, '0', 4), node.payload.fragment.conclusion, { work });
      return { ...result, status: primitiveStatus, worldId: f.world.id, assumptionsId: f.assumptions.id, nodeId: node.id, propositionChecked: true };
    } });
  registerRangeProofKernel(registry, { work });
  const { certificate } = await exportEvidenceCertificate({ graph, roots: ['root'], ...f, readRange, work: workFor(t) });
  return replayEvidenceCertificate(certificate, { ...f, readRange, work, checkers: registry,
    canonicalResolverExecution: 'local-bounded', resolveCanonicalNode: id => ({ worldId: f.world.id, node: graph.getNode(id) }) });
}
test('actual integer transfer composes through typed shared range DAG without broadening its domain', async t => {
  const r = await run(t); assert.equal(r.semantic, 'verified');
  const root = r.nodeResults.find(row => row.nodeId === 'root');
  assert.deepEqual(root.detail.proposition, { kind: 'unsigned-range', subject: 'v', bits: 64, lower: '7', upper: '7' });
  assert.deepEqual(root.detail.scope.domain, INTEGER_FRAGMENT_DOMAIN);
  assert.equal(r.derivation.checkedNodeIds.length, 5);
});
for (const [name, mutate, status] of [
  ['false conclusion', input => { input.nodes[4].payload.rule.conclusion.lower = '8'; input.nodes[4].payload.rule.conclusion.upper = '8'; }, 'rejected'],
  ['different point', input => { input.nodes[2].payload.rule.scope.source.boundary = '12'; }, 'rejected'],
  ['stronger entry', input => { input.nodes[2].payload.rule.scope.domain.entry = 'all-function-entries'; }, 'rejected'],
  ['flags included', input => { input.nodes[2].payload.rule.scope.domain.observes = 'register-and-nzcv'; }, 'rejected'],
  ['wrong subject', input => { input.nodes[2].payload.rule.conclusion.subject = 'other-value'; }, 'rejected'],
  ['duplicate premises', input => { input.nodes[4].payload.rule.premises = ['left', 'left']; }, 'rejected'],
  ['missing derivation edge', input => { input.edges = input.edges.filter(row => row.from !== 'left'); }, 'unknown'],
  ['unknown rule', input => { input.nodes[2].payload.rule.rule = 'trust-hash'; }, 'unknown'],
]) test(`typed range composition blocks ${name}`, async t => {
  const r = await run(t, mutate); assert.equal(r.semantic, status); assert.equal(r.derivation.rootsChecked, false);
});
test('matching serialized proof cannot replace an unavailable primitive check', async t => {
  const r = await run(t, input => { input.nodes[0].payload.verified = true; }, 'unknown');
  assert.equal(r.semantic, 'unknown'); assert.equal(r.derivation.rootsChecked, false);
});
