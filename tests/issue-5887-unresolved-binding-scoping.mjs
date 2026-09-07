// Regression for #5887: analysisBinding() normalized unresolved identities to
// fixed fallbacks ('binary:unknown', 'analysis:0', ...), so every
// identity-unresolved context shared one cache binding — a cached result from
// context A became a deterministic-cache hit in context B, and unknown→known
// transitions reused unknown-era records. Unresolved bindings are now scoped
// per context generation (fail-closed), while resolved identities keep exact
// cross-context continuity.
import assert from 'node:assert/strict';
import { ObservationStore, analysisBinding } from '../js/ai/tools/storage/observation-store.js';

const binA = { binaryId: 'bin-A', analysisRevision: 'rev-1', sliceIdentity: 'slice-1', projectRevision: 'proj-1', runtimeSessionId: 'rt-1' };
const binB = { binaryId: 'bin-B', analysisRevision: 'rev-1', sliceIdentity: 'slice-1', projectRevision: 'proj-1', runtimeSessionId: 'rt-1' };

{
  const binding = analysisBinding({});
  assert.equal(binding.resolved, false, 'an unresolved context must report itself unresolved');
  assert.ok(binding.missing.includes('binaryIdentity'), 'the missing binary identity is named');
}

{
  const resolved = analysisBinding(binA);
  assert.equal(resolved.resolved, true, 'a fully identified context reports resolved');
  assert.deepEqual(resolved.missing, []);
}

{
  const store = new ObservationStore({ context: {} });
  const first = store.put({ tool: 'demo', arguments: { x: 1 }, fullResult: { binary: 'A' } });
  assert.equal(first.binding.resolved, false);
  assert.ok(store.getCached('demo', { x: 1 }), 'same-context hits keep working');

  // 1: unresolved context A → unresolved context B must not reuse the cache.
  store.setContext({ app: { differentWorkbench: true } });
  assert.equal(store.getCached('demo', { x: 1 }), null, 'unknown→unknown must not hit');
  assert.equal(store.binding().resolved, false, 'the new context is unresolved too');
  assert.notEqual(store.binding().key, first.binding.key, 'each unresolved context generation gets its own key');

  // 3: unknown → known must not reuse unknown-era records.
  store.setContext({ ...binA });
  assert.equal(store.getCached('demo', { x: 1 }), null, 'unknown-era records cannot flow into a resolved binding');
  assert.equal(store.binding().resolved, true);

  // 2/6: resolved bindings keep exact cross-context continuity.
  const knownRecord = store.put({ tool: 'demo', arguments: { x: 1 }, fullResult: { binary: 'B' } });
  assert.equal(knownRecord.binding.resolved, true);
  assert.ok(store.getCached('demo', { x: 1 }), 'resolved same-identity hits work');
  store.setContext({ ...binA });
  assert.ok(store.getCached('demo', { x: 1 }), 'known→known same identity keeps the cache across setContext');

  // 4: known A → known B stays guarded by the real identities.
  store.setContext({ ...binB });
  assert.equal(store.getCached('demo', { x: 1 }), null, 'known A→known B must not hit');

  // 5: provenance of an unresolved record does not claim a resolved binary.
  assert.equal(first.binaryIdentity, 'binary:unknown', 'unknown provenance stays honestly labelled');
}
