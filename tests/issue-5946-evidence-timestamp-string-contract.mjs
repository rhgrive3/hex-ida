import assert from 'node:assert/strict';
import test from 'node:test';

import { EvidenceStore } from '../js/ai/evidence.js';
import { evidenceStoreToCanonicalGraph, legacyAiEvidenceToCanonical } from '../js/core/evidence/compat.js';

test('#5946 numeric timestamp is rejected at the add() boundary', () => {
  const store = new EvidenceStore();
  assert.throws(
    () => store.add({ id: 'ev-numeric-ts', kind: 'observation', timestamp: 1 }),
    (err) => err instanceof TypeError && err.message === 'evidence-invalid-timestamp',
  );
  assert.equal(store.has('ev-numeric-ts'), false, 'invalid record must not enter the store');
});

test('#5946 store with a rejected timestamp still snapshots (no poisoned records)', () => {
  const store = new EvidenceStore();
  try {
    store.add({ id: 'ev-numeric-ts', kind: 'observation', timestamp: 1234567890 });
  } catch { /* rejected above; the store must stay clean */ }
  const snap = store.canonicalSnapshot().toJSON();
  assert.deepEqual(snap.nodes, []);
});

test('#5946 string and default timestamps keep snapshotting', () => {
  const store = new EvidenceStore();
  store.add({ id: 'ev-string-ts', kind: 'observation', timestamp: '2026-01-01T00:00:00.000Z' });
  store.add({ id: 'ev-default-ts', kind: 'observation' });
  const stored = store.get('ev-default-ts');
  assert.equal(typeof stored.timestamp, 'string');
  assert.ok(!Number.isNaN(Date.parse(stored.timestamp)));
  const snap = store.canonicalSnapshot().toJSON();
  const ids = snap.nodes.map((node) => node.id);
  assert.ok(ids.includes('ev-string-ts'));
  assert.ok(ids.includes('ev-default-ts'));
});

test('#5946 canonical createdAt contract stays string-only for legacy records', () => {
  assert.equal(legacyAiEvidenceToCanonical({ id: 'ev-ok', kind: 'observation', timestamp: '2026-01-01T00:00:00.000Z' }).createdAt, '2026-01-01T00:00:00.000Z');
  assert.throws(
    () => legacyAiEvidenceToCanonical({ id: 'ev-numeric-ts', kind: 'observation', timestamp: 1 }),
    (err) => err instanceof TypeError && /created-at/.test(err.message),
  );
});
