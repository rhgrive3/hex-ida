import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';
import { INTEGER_FRAGMENT_KIND } from '../../js/core/evidence/arm64-integer-fragment.js';
const rows = (addText = '#0x10') => ({ '0x1000': [
  ['mov', 'x9, #0x1ff0', 0xd283fe09], ['add', `x9, x9, ${addText}`, 0x91004129],
  ['str', 'x9, [sp]', 0xf90003e9], ['ret', '', 0xd65f03c0],
] });
async function publish(f) {
  let result = await f.invoke('demandQuery', { query: { scope: { functionIds: ['0x1000'] }, select: { op: 'all' }, resultLimit: 32 }, precision: { maximumValues: 64 } });
  for (let i = 0; result.continuation && i < 32; i++) result = await f.invoke('resumeDemandQuery', { cursor: result.continuation.cursor });
  assert.equal(result.continuation, null); assert.ok(result.publication?.artifactId, result.reason);
  return result;
}

test('real native owners propose an unchecked conclusion; only replay derives the scoped integer fact', async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: rows() }), result = await publish(f), artifactId = result.publication.artifactId;
  assert.equal(result.answer.exact, false);
  const before = await f.invoke('explainDemandResult', { artifactId, view: 'graph' });
  const proofs = before.graph.nodes.filter(n => n.semanticKind === INTEGER_FRAGMENT_KIND);
  assert.equal(proofs.length, 1); assert.equal(proofs[0].payload.proofStatus, 'not-checked');
  assert.equal(proofs[0].payload.fragment.conclusion.constant, '8192');
  const replay = await f.invoke('replayDemandResult', { artifactId });
  assert.equal(replay.status, 'completed'); assert.equal(replay.integrity, 'verified'); assert.equal(replay.byteBinding, 'verified');
  assert.equal(replay.derivation.status, 'partially-checked'); assert.equal(replay.derivation.checkedNodeIds.length, 1);
  assert.equal(replay.ownerReplay.counters.integerDerivations, 1); assert.equal(replay.ownerReplay.counters.integerRejected, 0);
  assert.equal(replay.semantic, 'unknown'); assert.equal(replay.exact, false); assert.equal(replay.quarantine, null);
  assert.ok(replay.cost.used.calls < replay.cost.limits.calls);
  assert.deepEqual((await f.invoke('explainDemandResult', { artifactId, view: 'graph' })).graph, before.graph);
});

test('integrity-only replay never inherits prior successful derivation authority', async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: rows() }), { publication } = await publish(f);
  const owners = await f.invoke('replayDemandResult', { artifactId: publication.artifactId });
  assert.equal(owners.derivation.checkedNodeIds.length, 1);
  const result = await f.invoke('replayDemandResult', { artifactId: publication.artifactId, level: 'integrity' });
  assert.equal(result.status, 'completed'); assert.equal(result.derivation.checkedNodeIds.length, 0);
  assert.equal(result.ownerReplay, null); assert.equal(result.semantic, 'unknown'); assert.equal(result.quarantine, null);
});

test('same-owner mnemonic mutation is refuted by fresh bytes and withdraws only the observed artifact', async t => {
  // The test adapter intentionally disagrees with its bytes. The actual worker
  // and range owner still execute, so same-owner equality alone would miss it.
  const f = await nativeWorkerFixture(t, { rowsByLocator: rows('#0x11') }), { publication } = await publish(f);
  const result = await f.invoke('replayDemandResult', { artifactId: publication.artifactId });
  assert.equal(result.status, 'completed'); assert.equal(result.integrity, 'verified'); assert.equal(result.byteBinding, 'verified');
  assert.equal(result.ownerReplay.counters.integerRejected, 1); assert.equal(result.semantic, 'rejected');
  assert.equal(result.derivation.status, 'rejected');
  assert.ok(result.nodeResults.some(n => n.reason === 'independent-integer-singleton-contradicts-conclusion'));
  assert.equal(result.quarantine.status, 'quarantined');
  assert.notEqual((await f.invoke('explainDemandResult', { artifactId: publication.artifactId })).status, 'completed');
});

test('an intervening store remains unsupported instead of replaying through a memory effect', async t => {
  const input = rows(); input['0x1000'].splice(1, 0, ['str', 'x9, [sp]', 0xf90003e9]);
  const f = await nativeWorkerFixture(t, { rowsByLocator: input }), { publication } = await publish(f);
  const result = await f.invoke('replayDemandResult', { artifactId: publication.artifactId });
  assert.equal(result.status, 'completed'); assert.equal(result.semantic, 'unknown'); assert.equal(result.quarantine, null);
  assert.ok(result.ownerReplay.counters.integerUnknown > 0);
  assert.ok(result.nodeResults.some(n => n.reason === 'integer-fragment-opcode-unsupported'));
});

test('changed current binary bytes cannot reuse a previously successful proof', async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: rows() }), { publication } = await publish(f);
  assert.equal((await f.invoke('replayDemandResult', { artifactId: publication.artifactId })).derivation.status, 'partially-checked');
  f.data[64] ^= 0x20;
  const result = await f.invoke('replayDemandResult', { artifactId: publication.artifactId });
  assert.equal(result.semantic, 'rejected'); assert.equal(result.ownerReplay.counters.integerDerivations, 0);
  assert.equal(result.quarantine.status, 'quarantined');
});

test('replay stopped by the parent budget does not quarantine or invent a proof', async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: rows() }), { publication } = await publish(f);
  const result = await f.invoke('replayDemandResult', { artifactId: publication.artifactId }, { workUnits: 1 });
  assert.notEqual(result.semantic, 'verified'); assert.notEqual(result.status, 'completed');
  assert.equal((await f.invoke('explainDemandResult', { artifactId: publication.artifactId })).status, 'completed');
});
