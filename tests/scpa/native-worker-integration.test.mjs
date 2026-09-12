import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';

test('native ABI API traverses real platform dispatch, source bytes, cache and canonical projection', async t => {
  const f = await nativeWorkerFixture(t), result = await f.invoke('abiInputBindings', { functionId: '0x1000' });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.calls[0].arguments[0].register, 'x0');
  assert.equal(result.requestedFunctionLocator, '0x1000'); assert.equal(result.exact, false);
  assert.equal(f.counters.workers, 1); assert.equal(f.counters.reads, 1);
});
test('native interprocedural query uses persisted continuation without reloading prepared functions', async t => {
  const f = await nativeWorkerFixture(t);
  const a = await f.invoke('abiInputBindings', { functionId: '0x1000' });
  const c = await f.invoke('abiInputBindings', { functionId: '0x2000' });
  const before = f.counters.workers;
  let r = await f.invoke('interproceduralQuery', { scope: { functionIds: ['0x1000', '0x2000'] },
    select: { op: 'eq', field: 'entityId', value: a.calls[0].arguments[0].definitionId },
    flow: { to: { op: 'eq', field: 'entityId', value: c.parameters[0].definitionId }, edgeKinds: ['call-summary'], maxDepth: 4 } });
  let pages = 0; const results = [];
  while (true) {
    results.push(...r.results);
    if (!r.continuation) break;
    assert.ok(++pages < 10); r = await f.invoke('resumeSemanticQuery', { cursor: r.continuation.cursor });
  }
  assert.equal(results.length, 1);
  assert.equal(results[0].edges[0].witness.owner, 'existing-abi-and-compat-register-inputs');
  assert.equal(r.scopeMode, 'explicit-interprocedural');
  assert.equal(r.semanticClosure, 'unknown'); assert.equal(r.exact, false);
  assert.equal(f.counters.workers - before, 2);
});
test('native value catalog supplies owner identity accepted by the actual range worker', async t => {
  const f = await nativeWorkerFixture(t), catalog = await f.invoke('rangeValueCatalog', { functionId: '0x1000', limit: 256 });
  assert.equal(catalog.status, 'completed', catalog.reason); assert.ok(catalog.values.length > 0);
  const result = await f.invoke('refineValueFacts', { functionId: '0x1000', ownerIdentity: catalog.ownerIdentity,
    request: { valueIds: catalog.values.slice(0, 4).map(r => r.localId), goals: ['constant', 'interval'] } });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.published, false); assert.equal(result.exact, false); assert.equal(result.values.length, 4);
});
test('native range IDs cannot cross function or snapshot owners', async t => {
  const f = await nativeWorkerFixture(t), catalog = await f.invoke('rangeValueCatalog', { functionId: '0x1000' });
  const result = await f.invoke('refineValueFacts', { functionId: '0x2000', ownerIdentity: catalog.ownerIdentity,
    request: { valueIds: [catalog.values[0].localId] } });
  assert.equal(result.status, 'stale'); assert.equal(result.values.length, 0);
});
test('native scalar input projection cannot publish after worker cost exceeds parent budget', async t => {
  const f = await nativeWorkerFixture(t);
  const answer = await f.invoke('abiInputBindings', { functionId: '0x1000' }, { workUnits: 4 });
  assert.notEqual(answer.status, 'completed'); assert.equal(answer.calls, undefined);
  assert.equal(f.backend._artifactRuntime().store.metrics.publishes, 0);
});
test('actual platform handler rejects attempts to enable native ports on another architecture', async t => {
  const f = await nativeWorkerFixture(t);
  await assert.rejects(f.call('semanticFunction', { scopedCanonicalProjection: true, scopedLocalProjection: { kind: 'flow-inputs' },
    input: { architecture: 'arm64e' } }), /scoped-local-arm64-required/);
});
