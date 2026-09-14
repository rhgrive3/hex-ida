import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor } from './helpers.mjs';
import { EvidenceGraph } from '../../js/core/evidence/index.js';
import { CertificateCheckerRegistry, exportEvidenceCertificate, replayEvidenceCertificate } from '../../js/core/evidence/certificate.js';
import { INTEGER_FRAGMENT_SCHEMA, INTEGER_FRAGMENT_KIND, INTEGER_FRAGMENT_RULE,
  INTEGER_FRAGMENT_RULE_VERSION, INTEGER_FRAGMENT_DOMAIN, registerIntegerFragmentChecker } from '../../js/core/evidence/arm64-integer-fragment.js';

function setup(t, { mutate = null, omitEdge = false, ownerStatus = 'verified', profile = null } = {}) {
  const f = fixture(d => { if (profile) Object.assign(d.profile, profile); });
  const binaryId = f.world.binarySet[0].binaryId, functionId = 'integer-test-function', snapshotId = 'integer-test-snapshot';
  const conclusion = { register: 'x0', bits: 64, constant: '7', knownOne: '7', knownZero: '18446744073709551608',
    range: { kind: 'interval', lower: '7', upper: '7' } };
  const fragment = { schema: INTEGER_FRAGMENT_SCHEMA, ruleId: INTEGER_FRAGMENT_RULE, ruleVersion: INTEGER_FRAGMENT_RULE_VERSION,
    worldId: f.world.id, assumptionsId: f.assumptions.id, functionId, snapshotId, profile: f.world.profile, domain: INTEGER_FRAGMENT_DOMAIN,
    source: { binaryId, start: '64', end: '72', boundary: '68', virtualStart: '4096', virtualBoundary: '4100' },
    rangeLocalId: 17, semanticValueId: 'test-value', premises: { source: 'bytes', read: 'read', range: 'range' }, conclusion };
  const byteRange = { binaryId, start: '64', end: '72' };
  const graphInput = { nodes: [
    { id: 'root', family: 'SemanticEvidence', binaryId, semanticKind: 'unproven-root' },
    { id: 'proof', family: 'DataflowEvidence', binaryId, semanticKind: INTEGER_FRAGMENT_KIND, payload: { fragment } },
    { id: 'bytes', family: 'BinaryEvidence', binaryId, origin: { byteRanges: [byteRange] } },
    { id: 'read', family: 'SemanticEvidence', binaryId, semanticKind: 'scpa-canonical-owner-reference', payload: {
      reference: { binaryId, functionId, snapshotId, owner: 'semantic-ir' }, ownerRow: { kind: 'state-read',
        variable: { physicalIdentity: { kind: 'register', registerId: 'x0' } },
        attributes: { machineEffects: { architectureId: 'arm64', mode: 'a64' } }, outputs: ['test-value'],
        origin: { byteRanges: [{ binaryId, start: '68', end: '72' }], virtualRanges: [{ start: '4100', end: '4104' }] } } } },
    { id: 'range', family: 'DataflowEvidence', binaryId, semanticKind: 'scpa-demand-range-fact', payload: {
      ownerIdentity: { functionId }, bindings: [{ localId: 17, semanticValueId: 'test-value', bits: 64 }],
      value: { localId: 17, conditionalOn: [], fact: { bits: 64, constant: { value: '7' }, knownOne: '7', knownZero: conclusion.knownZero, range: conclusion.range } } } },
  ], edges: [{ from: 'root', to: 'proof', type: 'derived-from' },
    ...Object.values(fragment.premises).filter(id => !omitEdge || id !== 'read').map(to => ({ from: 'proof', to, type: 'derived-from' }))] };
  // Clone isolates fixture mutations from the frozen world/profile/domain.
  const input = structuredClone(graphInput); mutate?.(input.nodes[1].payload.fragment, input);
  const graph = new EvidenceGraph(input), bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
  view.setUint32(0, 0xd28000e0, true); view.setUint32(4, 0xd65f03c0, true);
  const readRange = req => ({ ...req, bytes: bytes.slice() });
  const work = workFor(t), registry = new CertificateCheckerRegistry();
  // These two checkers are protocol doubles only. Real owner reconstruction is
  // exercised separately in integer-native-replay.test.mjs.
  for (const kind of ['scpa-canonical-owner-reference', 'scpa-demand-range-fact']) {
    registry.register({ id: `test.${kind}`, version: '1', semanticKind: kind, level: 'source-binding-checked', execution: 'local-bounded',
      check: node => ({ status: ownerStatus, worldId: f.world.id, assumptionsId: f.assumptions.id, nodeId: node.id, propositionChecked: true }) });
  }
  registerIntegerFragmentChecker(registry, { work });
  return { ...f, graph, bytes, readRange, work, checkers: registry, roots: ['root'],
    resolveCanonicalNode: id => ({ worldId: f.world.id, node: graph.getNode(id) }), canonicalResolverExecution: 'local-bounded' };
}
async function replay(t, options = {}, overrides = {}) {
  const s = setup(t, options), exported = await exportEvidenceCertificate({ ...s, work: workFor(t), includeBytes: true });
  assert.equal(exported.status, 'completed');
  const result = await replayEvidenceCertificate(exported.certificate, { ...s, ...overrides });
  return { result, proof: result.nodeResults.find(n => n.nodeId === 'proof'), ...s };
}

test('byte-bound integer proof is partial derivation, not root acceptance', async t => {
  const { result, proof } = await replay(t);
  assert.equal(result.byteBinding, 'verified'); assert.equal(proof.status, 'verified');
  assert.equal(proof.detail.constant, '7'); assert.equal(proof.checker.level, 'derivation-checked');
  assert.equal(result.derivation.status, 'partially-checked'); assert.deepEqual(result.derivation.checkedNodeIds, ['proof']);
  assert.equal(result.derivation.rootsChecked, false); assert.equal(result.semantic, 'unknown');
});

for (const [label, mutate, status, reason] of [
  ['rule version', f => { f.ruleVersion = '99'; }, 'unknown', 'rule-unsupported'],
  ['rule ID', f => { f.ruleId = 'trusted-user-rule'; }, 'unknown', 'rule-unsupported'],
  ['world', f => { f.worldId = 'different'; }, 'rejected', 'profile-or-scope'],
  ['assumptions', f => { f.assumptionsId = 'different'; }, 'rejected', 'profile-or-scope'],
  ['profile', f => { f.profile.abiRevision = 'different'; }, 'rejected', 'profile-or-scope'],
  ['domain', f => { f.domain.entry = 'all-function-entries'; }, 'rejected', 'profile-or-scope'],
  ['snapshot', f => { f.snapshotId = 'different'; }, 'rejected', 'native-premise'],
  ['function', f => { f.functionId = 'different'; }, 'rejected', 'native-premise'],
  ['source offset', f => { f.source.start = '60'; }, 'rejected', 'native-premise'],
  ['source instruction alignment', f => { f.source.virtualStart = '4097'; }, 'rejected', 'native-premise'],
  ['source boundary', f => { f.source.boundary = '64'; }, 'rejected', 'native-premise'],
  ['range ID', f => { f.rangeLocalId = 18; }, 'rejected', 'native-premise'],
  ['semantic value', f => { f.semanticValueId = 'different'; }, 'rejected', 'native-premise'],
  ['register', f => { f.conclusion.register = 'x1'; }, 'rejected', 'native-premise'],
  ['conclusion', f => { f.conclusion.constant = '8'; }, 'rejected', 'range-proposition'],
  ['missing premise', f => { f.premises.read = 'absent'; }, 'unknown', 'premise-unavailable'],
  ['self premise', f => { f.premises.read = 'proof'; }, 'rejected', 'premise-kind'],
  ['duplicate premise', f => { f.premises.read = 'bytes'; }, 'rejected', 'premise-kind'],
  ['conditional owner fact', (_f, g) => { g.nodes[4].payload.value.conditionalOn = ['guard']; }, 'rejected', 'native-premise'],
]) test(`freshly rehashed ${label} mutant is not proof`, async t => {
  const { result, proof } = await replay(t, { mutate });
  assert.equal(result.integrity, 'verified'); assert.equal(proof.status, status); assert.match(proof.reason, new RegExp(reason));
  assert.notEqual(result.semantic, 'verified');
});

test('a source node without its dependency edge cannot satisfy a premise', async t => {
  const { proof } = await replay(t, { omitEdge: true, mutate: (_f, g) => { g.edges.push({ from: 'root', to: 'read', type: 'derived-from' }); } });
  assert.equal(proof.status, 'unknown'); assert.match(proof.reason, /premise-edge-missing/);
});
for (const status of ['unknown', 'rejected']) test(`current owner ${status} propagates without trusting the stored graph`, async t => {
  const { proof } = await replay(t, { ownerStatus: status });
  assert.equal(proof.status, status); assert.match(proof.reason, /current-premise-unverified/);
});
for (const profile of [{ endianness: 'be' }, { isaRevision: 'future-isa' }]) test(`unsupported profile ${JSON.stringify(profile)} stays unknown`, async t => {
  const { proof } = await replay(t, { profile }); assert.equal(proof.status, 'unknown'); assert.match(proof.reason, /profile-unsupported/);
});

test('embedded bytes, claimed statuses and matching owner DTOs are not fresh-byte authority', async t => {
  const { result, proof } = await replay(t, { mutate: (_f, g) => { g.nodes[1].payload.proofStatus = 'verified'; } }, { readRange: null });
  assert.equal(proof.status, 'unknown'); assert.match(proof.reason, /current-bytes-unavailable/); assert.equal(result.semantic, 'unknown');
});

test('current byte mutation stops before deriving a proposition', async t => {
  const { result, proof } = await replay(t, {}, { readRange: req => ({ ...req, bytes: new Uint8Array(8) }), stopOnRejection: true });
  assert.equal(result.semantic, 'rejected'); assert.equal(proof, undefined);
  assert.ok(result.rejected.some(r => r.reason === 'byte-content-mismatch'));
});

test('fresh bytes independently refute a false range even when both owner doubles agree', async t => {
  const { proof, result } = await replay(t, { mutate: (f, g) => {
    f.conclusion = { ...f.conclusion, constant: '8', knownOne: '8', knownZero: '18446744073709551607', range: { kind: 'interval', lower: '8', upper: '8' } };
    g.nodes[4].payload.value.fact = { ...f.conclusion, constant: { value: '8' } };
  } });
  assert.equal(proof.status, 'rejected'); assert.match(proof.reason, /singleton-contradicts/);
  assert.equal(result.derivation.status, 'rejected'); assert.deepEqual(result.derivation.rejectedNodeIds, ['proof']);
});

test('bounded local checkers charge work, while ordinary host checks still charge calls', async t => {
  const f = fixture(), node = { id: 'n', semanticKind: 'test' };
  for (const execution of ['local-bounded', 'host-call']) {
    const registry = new CertificateCheckerRegistry(), work = workFor(t, { calls: 0 });
    registry.register({ id: execution, version: '1', semanticKind: 'test', execution,
      check: n => ({ worldId: f.world.id, assumptionsId: f.assumptions.id, nodeId: n.id, propositionChecked: true, status: 'verified' }) });
    if (execution === 'host-call') await assert.rejects(registry.check(node, f, work), /calls|budget/);
    else { assert.equal((await registry.check(node, f, work)).status, 'verified'); assert.ok(work.cost().used.workUnits > 0); assert.equal(work.cost().used.calls ?? 0, 0); }
  }
});

test('local bounded execution does not bypass deadline or membership fences', async t => {
  const f = fixture(), node = { id: 'n', semanticKind: 'test' }, registry = new CertificateCheckerRegistry();
  const remove = registry.register({ id: 'hung', version: '1', semanticKind: 'test', execution: 'local-bounded', check: () => new Promise(() => {}) });
  await assert.rejects(registry.check(node, f, workFor(t, { deadlineMs: 25 })), /deadline/); remove();
  let off; off = registry.register({ id: 'retiring', version: '1', semanticKind: 'test', execution: 'local-bounded', check: n => {
    off(); return { worldId: f.world.id, assumptionsId: f.assumptions.id, nodeId: n.id, propositionChecked: true, status: 'verified' };
  } });
  assert.equal((await registry.check(node, f, workFor(t))).status, 'unknown');
});

for(const isaRevision of ['arm64:effects@7','arm64:effects@7.0.0'])test(`actual producer profile ${isaRevision} replays only the scoped integer fragment`,async t=>{
 const {result,proof}=await replay(t,{profile:{isaRevision}});
 assert.equal(proof.status,'verified');assert.equal(result.derivation.status,'partially-checked');
 assert.equal(result.semantic,'unknown');assert.equal(result.derivation.rootsChecked,false);
});
