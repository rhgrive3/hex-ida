import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceStore } from '../../../js/ai/evidence.js';

test('#4265 EvidenceStore rejects blank IDs before persistence', () => {
  const store = new EvidenceStore();
  assert.equal(store.add({ id:'   ', kind:'observation', status:'supported' }), null);
  assert.equal(store.all().length, 0);
  assert.doesNotThrow(() => store.canonicalSnapshot());
});

test('#4265 explicit IDs use the canonical trimmed key', () => {
  const store = new EvidenceStore();
  const padded = store.add({ id:' ev1 ', kind:'observation', status:'supported' });
  assert.equal(padded.id, 'ev1');
  assert.equal(store.get('ev1')?.id, 'ev1');
  assert.equal(store.get(' ev1 '), null);
  assert.doesNotThrow(() => store.canonicalSnapshot());
});

test('#4265 valid and auto-generated IDs keep existing behavior', () => {
  const store = new EvidenceStore();
  assert.equal(store.add({ id:'ev1', kind:'observation', status:'supported' }).id, 'ev1');
  const autoEmpty = store.add({ id:'', sourceTool:'tool-a', sourceId:'a', kind:'observation', status:'supported' });
  const autoMissing = store.add({ sourceTool:'tool-b', sourceId:'b', kind:'observation', status:'supported' });
  assert.match(autoEmpty.id, /^ev_[0-9a-f]+$/);
  assert.match(autoMissing.id, /^ev_[0-9a-f]+$/);
  assert.notEqual(autoEmpty.id, autoMissing.id);
  assert.doesNotThrow(() => store.canonicalSnapshot());
});
