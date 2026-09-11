import assert from 'node:assert/strict';
import test from 'node:test';

import { ObservationStore } from '../js/ai/tools/storage/observation-store.js';
import { EvidenceStore } from '../js/ai/evidence.js';

function storeWithRecord() {
  const store = new ObservationStore({ context: { binaryId: 'b1' } });
  const record = store.put({ tool: 't', arguments: {}, fullResult: { secret: true } });
  store.pin(record.id);
  return { store, record };
}

test('#5425 ObservationStore get must not alias structured refs onto canonical ids', () => {
  const { store, record } = storeWithRecord();
  assert.equal(store.get(record.id).id, record.id, 'canonical string ref keeps working');
  for (const forged of [[record.id], { ref: record.id }, { toString() { return record.id; } }, 0, true]) {
    assert.throws(() => store.get(forged), (error) => error.message === 'unknown-detail-ref',
      `structured ref ${JSON.stringify(forged)?.slice(0, 30)} must not reach the record`);
  }
});

test('#5425 pin/unpin must not alias structured refs either', () => {
  const { store, record } = storeWithRecord();
  assert.equal(store.unpin(record.id), true);
  assert.equal(store.pin([record.id]), false, 'structured ref must not flip retention of the canonical record');
  assert.equal(store.pin(String(record.id)), true, 'string ref keeps pin semantics');
  assert.equal(store.unpin({ x: 1 }), false);
});

test('#5425 EvidenceStore must not launder a structured detailRef into a canonical ref', () => {
  const { store, record } = storeWithRecord();
  const evidenceStore = new EvidenceStore({}, { observationStore: store });
  const evidence = evidenceStore.add({
    kind: 'observation',
    status: 'supported',
    sourceRef: { detailRef: [record.id], path: '$' },
  });
  assert.equal(evidence, null, 'malformed explicit sourceRef must be rejected, not laundered');
  assert.equal(
    [...evidenceStore.records.values()].some((item) => item.sourceRef?.detailRef === record.id),
    false,
    'no evidence record may reference the canonical observation through coercion',
  );
});

test('#5425 bindingKey/evidenceSourceId follow the same identity contract', () => {
  const evidenceStore = new EvidenceStore();
  for (const malformed of [
    { evidenceSourceId: ['src-1'] },
    { detailRef: 'obs_x', bindingKey: { k: 1 } },
    { detailRef: 42 },
    42,
    ['detailRef'],
  ]) {
    assert.equal(evidenceStore.add({ kind: 'observation', status: 'supported', sourceRef: malformed }), null,
      `malformed sourceRef ${JSON.stringify(malformed)} must be rejected`);
  }
});

test('#5425 canonical string refs and absent refs keep existing semantics', () => {
  const { store, record } = storeWithRecord();
  const evidenceStore = new EvidenceStore({}, { observationStore: store });
  const fromString = evidenceStore.add({ kind: 'observation', status: 'supported', sourceRef: record.id });
  assert.equal(fromString.sourceRef.detailRef, record.id);
  const fromObject = evidenceStore.add({
    kind: 'observation', status: 'supported',
    sourceRef: { detailRef: record.id, path: '$.result', bindingKey: 'binding-1' },
  });
  assert.deepEqual(fromObject.sourceRef, { detailRef: record.id, path: '$.result', bindingKey: 'binding-1' });
  // Absent sourceRef + sourceData still routes through the observation store.
  const fromData = evidenceStore.add({ kind: 'observation', status: 'supported', sourceData: { a: 1 } });
  assert.ok(fromData.sourceRef?.detailRef || fromData.sourceRef?.evidenceSourceId);
});
