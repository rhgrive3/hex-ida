import assert from 'node:assert/strict';
import { ToolRegistry } from '../../../js/ai/tools/registry-core.js';
import { ObservationStore } from '../../../js/ai/tools/storage/observation-store.js';
import { EvidenceStore } from '../../../js/ai/evidence.js';

// #8826: observation admission must own an immutable snapshot of the tool
// result. A caller that mutates the live object after execute() returns must
// never make a deterministic cache hit serve new bytes under previously
// verified evidence, and detailRef resolution must stay pinned to the exact
// admitted source content.

function makeRegistry() {
  const shared = {
    result: {
      address: '0x1000',
      kind: 'constant-fact',
      evidence: ['source:one'],
      verifiedEvidenceIds: ['source:one'],
      verified: true,
      value: 'A',
      nested: { list: [1n, 2n] },
    },
  };
  const registry = new ToolRegistry({
    context: { binaryIdentity: 'bin:8826', analysisRevision: 'rev:1' },
    evidenceStore: new EvidenceStore(),
  });
  registry.register({
    name: 'mutable_probe',
    verifier: true,
    category: 'verification',
    execute: async () => shared,
    modelProjection: (x) => x,
  });
  return { registry, shared };
}

function mutate(shared) {
  shared.result = {
    address: '0x2000',
    kind: 'constant-fact',
    evidence: ['source:two'],
    verifiedEvidenceIds: ['source:two'],
    verified: true,
    value: 'B',
    nested: { list: [3n, 4n] },
  };
}

// 1. Core integrity split: cached hit must serve the admitted snapshot, with
//    exactly the evidence that was verified for that snapshot.
{
  const { registry, shared } = makeRegistry();
  const first = await registry.execute('mutable_probe', {});
  assert.equal(first.cached, undefined);
  assert.equal(first.result.result.value, 'A');
  const firstEvidenceIds = first.evidenceIds;
  assert.ok(firstEvidenceIds.length > 0, 'verifier tool must produce evidence');

  mutate(shared);

  const second = await registry.execute('mutable_probe', {});
  assert.equal(second.cached, true);
  assert.equal(second.result.result.value, 'A', 'cache hit must never serve post-admission caller mutation');
  assert.equal(second.result.result.address, '0x1000');
  assert.deepEqual(second.evidenceIds, firstEvidenceIds);
  for (const item of second.evidence) {
    assert.equal(item.sourceData.value, 'A');
    assert.equal(item.sourceData.address, '0x1000');
  }
  assert.deepEqual(second.result.result.nested, { list: ['0x1', '0x2'] }, 'bigint leaves keep the existing jsonSafe identity');
}

// 2. detailRef permanence: provenance detail for the verified evidence keeps
//    resolving to the admitted source content, not to mutated caller data.
{
  const { registry, shared } = makeRegistry();
  const first = await registry.execute('mutable_probe', {});
  mutate(shared);
  const detail = registry.observationStore.detail({ detailRef: first.detailRef, path: '$.result.value' });
  assert.equal(detail.data, 'A');
}

// 3. Admission ownership: nested containers must be store-owned deep copies
//    (frozen), never caller aliases — even for tools that are not cached.
{
  const registry = new ToolRegistry({
    context: { binaryIdentity: 'bin:8826', analysisRevision: 'rev:1' },
    observationStore: new ObservationStore({ context: { binaryIdentity: 'bin:8826', analysisRevision: 'rev:1' } }),
  });
  const nested = { list: [{ deep: true }] };
  registry.register({
    name: 'alias_probe',
    execute: async () => ({ nested }),
  });
  const result = await registry.execute('alias_probe', {});
  const record = registry.observationStore.get(result.detailRef);
  assert.notEqual(record.fullResult.nested, nested, 'nested object must not remain a caller alias');
  assert.notEqual(record.fullResult.nested.list, nested.list);
  assert.equal(Object.isFrozen(record.fullResult), true);
  assert.equal(Object.isFrozen(record.fullResult.nested.list[0]), true);
  assert.throws(() => { record.fullResult.nested.list[0].deep = false; }, TypeError);
  // A caller mutating its own nested object after the fact must not be able
  // to alter what the record resolves to later.
  nested.list[0].deep = 'mutated';
  assert.equal(registry.observationStore.get(result.detailRef).fullResult.nested.list[0].deep, true);
}

// 4. Arguments are admitted as owned snapshots too.
{
  const registry = new ToolRegistry({
    context: { binaryIdentity: 'bin:8826', analysisRevision: 'rev:1' },
    observationStore: new ObservationStore({ context: { binaryIdentity: 'bin:8826', analysisRevision: 'rev:1' } }),
  });
  registry.register({ name: 'echo_args', execute: async (args) => ({ echo: { query: args.query } }) });
  const liveArgs = { query: 'original' };
  const result = await registry.execute('echo_args', liveArgs);
  liveArgs.query = 'mutated';
  const record = registry.observationStore.get(result.detailRef);
  assert.equal(record.arguments.query, 'original');
}

// 5. Fail-closed admission: a result that cannot be safely snapshotted is
//    neither cache-reusable nor evidence-authoritative, and never silently
//    aliases a live reference into a cache entry.
{
  let calls = 0;
  const registry = new ToolRegistry({
    context: { binaryIdentity: 'bin:8826', analysisRevision: 'rev:1' },
    observationStore: new ObservationStore({ context: { binaryIdentity: 'bin:8826', analysisRevision: 'rev:1' } }),
  });
  registry.register({
    name: 'hostile_probe',
    verifier: true,
    category: 'verification',
    evidence: ['source:hostile'],
    execute: async () => {
      calls += 1;
      return { result: { verified: true, evidence: ['source:hostile'], payload() { return 'live'; } } };
    },
    modelProjection: (x) => x,
  });
  const first = await registry.execute('hostile_probe', {});
  const record = registry.observationStore.get(first.detailRef);
  assert.equal(record.snapshotOwned, false);
  assert.equal(record.cacheKey, null, 'unsnapshottable results must never enter the reusable cache');
  assert.deepEqual(first.evidenceIds, [], 'unsnapshottable results must not mint evidence');
  const second = await registry.execute('hostile_probe', {});
  assert.equal(second.cached, undefined, 'unsnapshottable results must be recomputed, never served from cache');
  assert.equal(calls, 2);
  assert.deepEqual(second.evidenceIds, []);
}

// 6. Budget fail-closed: an over-budget snapshot degrades to the same
//    non-cacheable/non-authoritative path instead of exhausting the store.
{
  const registry = new ToolRegistry({
    context: { binaryIdentity: 'bin:8826', analysisRevision: 'rev:1' },
    observationStore: new ObservationStore({ context: { binaryIdentity: 'bin:8826', analysisRevision: 'rev:1' } }),
  });
  registry.register({
    name: 'deep_probe',
    execute: async () => {
      let deep = { leaf: true };
      for (let i = 0; i < 80; i += 1) deep = { child: deep };
      return deep;
    },
  });
  const result = await registry.execute('deep_probe', {});
  const record = registry.observationStore.get(result.detailRef);
  assert.equal(record.snapshotOwned, false);
  assert.equal(record.cacheKey, null);
}

// 7. Bounded-scan metadata survives admission inside the owned snapshot, so a
//    cache hit cannot lose or gain completeness signals after verification.
{
  const registry = new ToolRegistry({
    context: { binaryIdentity: 'bin:8826', analysisRevision: 'rev:1' },
    observationStore: new ObservationStore({ context: { binaryIdentity: 'bin:8826', analysisRevision: 'rev:1' } }),
  });
  let calls = 0;
  registry.register({
    name: 'bounded_probe',
    execute: async () => {
      calls += 1;
      const rows = [{ address: '0x10' }, { address: '0x20' }];
      Object.defineProperty(rows, 'truncated', { value: true, enumerable: false, configurable: true });
      Object.defineProperty(rows, 'reason', { value: 'result-limit', enumerable: false, configurable: true });
      return rows;
    },
  });
  const first = await registry.execute('bounded_probe', {});
  assert.equal(first.completeness.complete, false, 'admission must carry the bounded-scan marker');
  const second = await registry.execute('bounded_probe', {});
  assert.equal(second.cached, true);
  assert.equal(second.completeness.complete, false, 'cache hit must not resurrect bounded results as complete');
  assert.equal(calls, 1);
  const detail = registry.observationStore.detail({ detailRef: first.detailRef });
  assert.equal(detail.completeness.complete, false);
}

console.log('issue #8826 observation-snapshot ownership: PASS');
