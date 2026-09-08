import assert from 'node:assert/strict';
import test from 'node:test';

import { EvidenceStore } from '../js/ai/evidence.js';

test('#5405 an id-based rejection must not leave an orphaned sourceData payload', () => {
  const store = new EvidenceStore();
  const rejected = store.add({ id: 42, sourceTool: 'test', sourceData: { value: 1 } });
  assert.equal(rejected, null);
  assert.equal(store.records.size, 0);
  assert.equal(store.sourcePayloads.size, 0, 'no payload may persist for a rejected record');
});

test('#5405 repeated rejected inputs do not accumulate payloads', () => {
  const store = new EvidenceStore();
  for (let i = 0; i < 25; i += 1) {
    assert.equal(store.add({ id: 42, sourceTool: 'test', sourceData: { attempt: i } }), null);
  }
  assert.equal(store.sourcePayloads.size, 0);
});

test('#5405 valid string ids keep persisting sourceData', () => {
  const store = new EvidenceStore();
  const added = store.add({ id: 'ev_ok', sourceTool: 'test', sourceData: { value: 1 } });
  assert.ok(added);
  assert.equal(store.records.size, 1);
  assert.equal(store.sourcePayloads.size, 1);
});

test('#5405 canonical digest ids also reject before persistence when malformed', () => {
  const store = new EvidenceStore();
  // Non-string non-null id values of any shape are rejected up front.
  for (const badId of [42, true, { id: 1 }, ['ev_x']]) {
    assert.equal(store.add({ id: badId, sourceTool: 'test', sourceData: { n: 1 } }), null);
  }
  assert.equal(store.sourcePayloads.size, 0);
  assert.equal(store.records.size, 0);
});
