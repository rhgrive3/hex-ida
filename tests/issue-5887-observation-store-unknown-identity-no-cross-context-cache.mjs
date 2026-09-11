// Regression for #5887: identity-unresolved analysis contexts must never share
// a deterministic cache authority. `analysisBinding()` fails closed with
// `complete:false` + `missing:[...]` when binary/analysis identity falls back
// to the unknown sentinels, unresolved context objects get a context-instance
// nonce in the binding key (no cross-context reuse after setContext()), and
// complete bindings keep the exact pre-existing key/hit semantics.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ObservationStore, analysisBinding } from '../js/ai/tools/storage/observation-store.js';

test('#5887 unresolved context A results are not reused in unresolved context B', () => {
  const store = new ObservationStore({ context:{} });
  const record = store.put({ tool:'demo', arguments:{ x:1 }, fullResult:{ binary:'A' } });
  assert.equal(record.binding.complete, false, 'unresolved binding must be marked incomplete');
  assert.deepEqual(record.binding.missing, ['binaryIdentity', 'analysisRevision']);
  const keyA = store.cacheKey('demo', { x:1 });
  assert.equal(keyA.includes(':u'), true, 'an unresolved binding key carries the context-instance nonce');

  store.setContext({});
  assert.equal(store.getCached('demo', { x:1 }), null,
    'a second identity-unresolved context must not hit context A\'s cached result');
  assert.notEqual(store.cacheKey('demo', { x:1 }), keyA,
    'a different unresolved context instance mints a different cache authority');

  // The record itself stays retrievable by its own detailRef only in the
  // context instance that minted it.
  assert.throws(() => store.get(record.id), /stale-detail-ref/,
    'context B must not read context A records through the shared unknown binding');
});

test('#5887 unknown→known resolution never launders unknown-era records', () => {
  const store = new ObservationStore({ context:{} });
  const record = store.put({ tool:'demo', arguments:{ x:1 }, fullResult:{ binary:'A' } });
  store.setContext({ binaryIdentity:'bin-B', analysisRevision:'analysis:9' });
  assert.equal(store.getCached('demo', { x:1 }), null, 'known binding must not reuse unknown-era cache');
  assert.throws(() => store.get(record.id), /stale-detail-ref/,
    'unknown-era record must be stale in a resolved context');
});

test('#5887 complete identity keeps deterministic cache hits across setContext', () => {
  const store = new ObservationStore({ context:{ binaryIdentity:'bin-A', analysisRevision:'analysis:1' } });
  const first = store.put({ tool:'demo', arguments:{ x:1 }, fullResult:{ binary:'A' } });
  assert.equal(first.binding.complete, true, 'resolved binding must be complete');
  assert.deepEqual(first.binding.missing, []);

  // Same context: deterministic hit.
  const hit = store.getCached('demo', { x:1 });
  assert.equal(hit && hit.fullResult.binary, 'A', 'same-context deterministic hit must be preserved');

  // Another complete context with the SAME identity: hit preserved (existing
  // deterministic authority), and key is byte-identical to the legacy layout.
  store.setContext({ binaryId:'bin-A', analysisRevision:'analysis:1' });
  const hit2 = store.getCached('demo', { x:1 });
  assert.equal(hit2 && hit2.fullResult.binary, 'A', 'same complete identity must keep the cache authority');
  assert.equal(analysisBinding({ binaryIdentity:'bin-A', analysisRevision:'analysis:1' }).key,
    analysisBinding({ binaryId:'bin-A', analysisRevision:'analysis:1' }).key,
    'complete binding keys stay deterministic and context-independent');

  // Different complete identity: stale guard must still reject.
  store.setContext({ binaryIdentity:'bin-B', analysisRevision:'analysis:1' });
  assert.equal(store.getCached('demo', { x:1 }), null, 'known A→known B stale guard must hold');
  assert.throws(() => store.get(first.id), /stale-detail-ref/);
});

test('#5887 unresolved context-instance nonce is stable per context object only', () => {
  const contextA = {};
  const contextB = {};
  const a1 = analysisBinding(contextA);
  const a2 = analysisBinding(contextA);
  const b1 = analysisBinding(contextB);
  assert.equal(a1.key, a2.key, 'same unresolved context object keeps one nonce (turn continuity)');
  assert.notEqual(a1.key, b1.key, 'distinct unresolved context objects never share a key');
  assert.equal(analysisBinding(contextA, { binaryIdentity:'bin-A' }).complete, false,
    'resolving only the binary identity leaves the binding incomplete');
  assert.notEqual(analysisBinding(contextA, { binaryIdentity:'bin-A', analysisRevision:'analysis:1' }).key.includes(':u'), true,
    'a fully extra-resolved binding completes and mints no nonce');

  // setContext() to a fresh unresolved object changes the nonce authority.
  const store = new ObservationStore({ context: contextA });
  const r1 = store.put({ tool:'demo', arguments:{}, fullResult:{} });
  store.setContext(contextB);
  assert.throws(() => store.get(r1.id), /stale-detail-ref/,
    'a different unresolved context instance must not read the previous instance records');
});

test('#5887 non-object unresolved contexts fail closed with no reusable authority', () => {
  // Direct analysisBinding with a non-object context is ephemeral: no stable
  // authority can ever be derived from it.
  assert.notEqual(analysisBinding('').key, analysisBinding('').key,
    'non-object contexts never produce a stable key');
  // The store coerces falsy contexts to a fresh object per setContext(), so
  // each re-set is a different unresolved context instance: no reuse.
  const store = new ObservationStore({ context:'' });
  store.put({ tool:'demo', arguments:{ x:1 }, fullResult:{ binary:'A' } });
  const k1 = store.cacheKey('demo', { x:1 });
  store.setContext('');
  assert.equal(store.getCached('demo', { x:1 }), null,
    'a re-set falsy context is a new unresolved instance and must not hit the old cache');
  assert.notEqual(store.cacheKey('demo', { x:1 }), k1,
    'each falsy-context (re)set mints a distinct context-instance authority');
});

test('#5887 same unresolved context instance keeps its own cache authority', () => {
  const context = {};
  const store = new ObservationStore({ context });
  store.put({ tool:'demo', arguments:{ x:1 }, fullResult:{ binary:'A' } });
  const hit = store.getCached('demo', { x:1 });
  assert.equal(hit && hit.fullResult.binary, 'A',
    'turn-to-turn continuity inside one unresolved context instance is preserved');
});
