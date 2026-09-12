import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor } from './helpers.mjs';
import { EvidenceGraph } from '../../js/core/evidence/index.js';
import { CertificateCheckerRegistry, exportEvidenceCertificate, replayEvidenceCertificate } from '../../js/core/evidence/certificate.js';
import { registerAliasProofKernel, ALIAS_PROOF_KIND, ALIAS_PROOF_SCHEMA, ALIAS_PROOF_VERSION, ALIAS_PROOF_INTERPRETATION } from '../../js/core/evidence/alias-proof-kernel.js';
import { INTEGER_FRAGMENT_KIND, checkIntegerFragmentBytes } from '../../js/core/evidence/arm64-integer-fragment.js';
import { integerFragmentProofScope } from '../../js/core/evidence/range-proof-kernel.js';
import { compareCanonicalAliasCells } from '../../js/analysis/query/semantic/demand-alias.js';
import { createPointsToSet } from '../../js/analysis/pointsto/lattice.js';
import { createAnalysisStatus } from '../../js/analysis/status.js';
import { jsonSafe } from '../../js/core/identity/index.js';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';

async function replay(t, left = 7, right = 9, mutate = () => {}, integerStatus = null, objectStatus = 'verified', overrides = {}) {
  const f = fixture(), binaryId = f.world.binarySet[0].binaryId, work = workFor(t);
  const bytes = new Uint8Array(8), data = new DataView(bytes.buffer);
  [left, right].forEach((v, i) => data.setUint32(i * 4,
    BigInt(v) === (1n << 64n) - 1n ? (0x92800000 | (9 + i)) >>> 0 : (0xd2800000 | Number(v) << 5 | (9 + i)) >>> 0, true));
  const source = { binaryId, start: '0', boundary: '8', end: '12', virtualStart: '4096', virtualBoundary: '4104' };
  const status = createAnalysisStatus({ analyzerId: 'phase7.pointsto.a2-local', analyzerVersion: '1.2.1', completeness: 'complete', snapshotId: 'snap' });
  const fragments = [left, right].map((value, i) => ({ ...{ worldId: f.world.id, assumptionsId: f.assumptions.id },
    snapshotId: 'snap', functionId: 'f', semanticValueId: `v${i}`, source,
    conclusion: { register: `x${9 + i}`, bits: 64, constant: String(value), knownOne: String(value),
      knownZero: String(((1n << 64n) - 1n) ^ BigInt(value)), range: { kind: 'interval', lower: String(value), upper: String(value) } } }));
  const nodes = fragments.flatMap((fragment, i) => [
    { id: `integer${i}`, family: 'DataflowEvidence', binaryId, semanticKind: INTEGER_FRAGMENT_KIND,
      origin: { byteRanges: [{ binaryId, start: '0', end: '8' }] }, payload: { fragment } },
    { id: `object${i}`, family: 'DataflowEvidence', binaryId, semanticKind: 'scpa-demand-object-view', payload: { functionId: 'f',
      projection: jsonSafe({ valueId: `v${i}`, ownerStatus: status, unknowns: [], pointsTo: createPointsToSet({ targets: [{
        rootKind: 'absolute', address: String(i ? right : left), addressSpace: 'memory', widthBits: 64, offsetRange: { min: 0n, max: 0n } }] }) }) } },
  ]);
  const rule = { schema: ALIAS_PROOF_SCHEMA, version: ALIAS_PROOF_VERSION, scope: integerFragmentProofScope(fragments[0]),
    interpretation: ALIAS_PROOF_INTERPRETATION, premises: { leftInteger: 'integer0', rightInteger: 'integer1', leftObject: 'object0', rightObject: 'object1' },
    conclusion: { leftValueId: 'v0', rightValueId: 'v1', relation: left === right ? 'must' : 'no', addressSpace: 'memory', widthBytes: 1 } };
  nodes.push({ id: 'alias', binaryId, family: 'DataflowEvidence', semanticKind: ALIAS_PROOF_KIND, payload: { rule } });
  const input = { nodes, edges: Object.values(rule.premises).map(to => ({ from: 'alias', to, type: 'derived-from' })) };
  mutate(input);
  const graph = new EvidenceGraph(input), registry = new CertificateCheckerRegistry(), readRange = req => ({ ...req, bytes: bytes.slice() });
  registry.register({ id: 'actual-integer-test-adapter', version: '1', semanticKind: INTEGER_FRAGMENT_KIND, execution: 'local-bounded',
    check: (node, context) => { const checked = checkIntegerFragmentBytes(context.getVerifiedBytes(node.id, binaryId, '0', 8), node.payload.fragment.conclusion, { work });
      return { ...checked, ...(integerStatus ? { status: integerStatus } : {}),
        ...(overrides.integerDomain ? { detail: { ...checked.detail, domain: overrides.integerDomain } } : {}),
        worldId: f.world.id, assumptionsId: f.assumptions.id, nodeId: node.id, propositionChecked: true }; } });
  registry.register({ id: 'current-object-test-adapter', version: '1', semanticKind: 'scpa-demand-object-view', level: 'source-binding-checked', execution: 'local-bounded',
    check: node => ({ status: objectStatus, worldId: f.world.id, assumptionsId: f.assumptions.id, nodeId: node.id, propositionChecked: true }) });
  registerAliasProofKernel(registry, { work, compareCanonicalCells: overrides.compare ?? compareCanonicalAliasCells });
  const { certificate } = await exportEvidenceCertificate({ graph, roots: ['alias'], ...f, readRange, work: workFor(t) });
  return replayEvidenceCertificate(certificate, { ...f, readRange, work, checkers: registry, canonicalResolverExecution: 'local-bounded',
    resolveCanonicalNode: id => ({ worldId: f.world.id, node: graph.getNode(id) }) });
}

test('independent finite byte-cell oracle agrees with actual integer replay plus canonical alias owner', async t => {
  for (const left of [0, 1, 7, 255, 65535, (1n << 64n) - 1n]) for (const right of [0, 1, 7, 255, 65535, (1n << 64n) - 1n]) {
    const result = await replay(t, left, right), checked = result.nodeResults.find(row => row.nodeId === 'alias');
    const cellsLeft = new Set([left]), cellsRight = new Set([right]);
    const overlap = [...cellsLeft].some(address => cellsRight.has(address));
    assert.equal(checked.status, 'verified'); assert.equal(checked.detail.proposition.relation, overlap ? 'must' : 'no');
    assert.equal(checked.detail.proposition.widthBytes, 1); assert.equal(checked.detail.largerAccessAlias, 'unproved');
  }
});
for (const [name, mutate, expected] of [
  ['false relation', input => { input.nodes.at(-1).payload.rule.conclusion.relation = 'must'; }, 'rejected'],
  ['different point', input => { input.nodes[2].payload.fragment.source = { ...input.nodes[2].payload.fragment.source, boundary: '12' }; }, 'rejected'],
  ['world scope', input => { input.nodes.at(-1).payload.rule.scope.worldId = 'other'; }, 'rejected'],
  ['larger access', input => { input.nodes.at(-1).payload.rule.conclusion.widthBytes = 8; }, 'unknown'],
  ['pointer validity promotion', input => { input.nodes.at(-1).payload.rule.interpretation = 'live-allocated-object'; }, 'rejected'],
  ['nonzero owner offset', input => { input.nodes[1].payload.projection.pointsTo.targets[0].offsetRange = { min: '1', max: '1', exact: true }; }, 'unknown'],
  ['forged singleton interval', input => { input.nodes[1].payload.projection.pointsTo.targets[0].offsetRange.max = '8'; }, 'unknown'],
  ['unknown owner', input => { input.nodes[1].payload.projection.pointsTo.top = true; }, 'unknown'],
  ['unfinished owner', input => { input.nodes[1].payload.projection.ownerStatus.completeness = 'partial'; }, 'unknown'],
  ['unexported premise edge', input => { input.edges.pop(); }, 'unknown'],
]) test(`alias derivation refuses ${name}`, async t => {
  const result = await replay(t, 7, 9, mutate); assert.equal(result.nodeResults.find(row => row.nodeId === 'alias').status, expected);
  assert.equal(result.derivation.rootsChecked, false);
});
test('serialized/current owner equality cannot replace independent integer or reopened object premises', async t => {
  for (const states of [['unknown', 'verified'], [null, 'unknown']]) {
    const result = await replay(t, 7, 9, () => {}, ...states);
    assert.equal(result.nodeResults.find(row => row.nodeId === 'alias').status, 'unknown');
  }
});
test('independent checked cells reject a canonical alias callback reproducing its own false conclusion', async t => {
  const result = await replay(t, 7, 9, input => { input.nodes.at(-1).payload.rule.conclusion.relation = 'must'; }, null, 'verified', {
    compare: (left, right) => ({ ...compareCanonicalAliasCells(left, right), relation: 'must' }),
  });
  const checked = result.nodeResults.find(row => row.nodeId === 'alias');
  assert.equal(checked.status, 'rejected'); assert.equal(checked.reason, 'alias-proof-canonical-relation-contradicts-checked-cells');
});
test('checked integer result with another interpretation cannot qualify address-cell relation', async t => {
  const result = await replay(t, 7, 9, () => {}, null, 'verified', { integerDomain: { completion: 'trace-only' } });
  assert.equal(result.nodeResults.find(row => row.nodeId === 'alias').status, 'unknown');
});

async function native(t, right = 12288, textRight = right) {
  const f = await nativeWorkerFixture(t, { rowsByLocator: { '0x1000': [['mov', 'x9, #8192', 0xd2840009],
    ['mov', `x10, #${textRight}`, (0xd2800000 | right << 5 | 10) >>> 0], ['str', 'x9, [x10]', 0xf9000149], ['ret', '', 0xd65f03c0]] } });
  let value = await f.invoke('demandQuery', { query: { scope: { functionIds: ['0x1000'] }, select: { op: 'all' }, resultLimit: 32 }, precision: { maximumValues: 64 } });
  for (let i = 0; value.continuation && i < 32; i++) value = await f.invoke('resumeDemandQuery', { cursor: value.continuation.cursor });
  const artifactId = value.publication.artifactId, graph = await f.invoke('explainDemandResult', { artifactId, view: 'graph' });
  return { f, value, artifactId, aliases: graph.graph.nodes.filter(row => row.semanticKind === ALIAS_PROOF_KIND) };
}
for (const [right, relation] of [[12288, 'no'], [8192, 'must']]) test(`actual native current-source pipeline independently derives ${relation} for one-byte address cells`, async t => {
  const { f, value, artifactId, aliases } = await native(t, right);
  assert.equal(aliases.length, 1); assert.equal(aliases[0].payload.proofStatus, 'not-checked');
  assert.equal(value.answer.evidence.aliasDerivations[0].widthBytes, 1);
  const result = await f.invoke('replayDemandResult', { artifactId }), checked = result.nodeResults.find(row => row.nodeId === aliases[0].id);
  assert.equal(checked.status, 'verified'); assert.equal(checked.detail.proposition.relation, relation);
  assert.equal(checked.detail.proposition.widthBytes, 1); assert.equal(checked.detail.pointerValidity, 'unproved');
  assert.equal(result.semantic, 'unknown'); assert.equal(result.exact, false); assert.equal(result.quarantine, null);
});
test('native byte/owner disagreement never inherits a proposed NoAlias verdict', async t => {
  const { f, artifactId, aliases } = await native(t, 12288, 12289);
  assert.equal(aliases.length, 1);
  const result = await f.invoke('replayDemandResult', { artifactId });
  assert.equal(result.nodeResults.find(row => row.nodeId === aliases[0].id).status, 'unknown');
  assert.equal(result.semantic, 'rejected'); assert.equal(result.quarantine.status, 'quarantined');
});
