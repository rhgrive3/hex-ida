import assert from 'node:assert/strict';
import { EvidenceStore } from '../../js/ai/evidence.js';

// Same ID upsert must not accumulate unreferenced payloads.
{
  const store = new EvidenceStore();
  store.add({ id: 'ev1', kind: 'observation', sourceTool: 'test', sourceData: { version: 1 } });
  const first = store.get('ev1').sourceRef.evidenceSourceId;
  assert.equal(store.sourcePayloads.size, 1);

  store.add({ id: 'ev1', kind: 'observation', sourceTool: 'test', sourceData: { version: 2 } });
  const second = store.get('ev1').sourceRef.evidenceSourceId;
  assert.notEqual(first, second);
  assert.equal(store.records.size, 1);
  assert.equal(store.sourcePayloads.size, 1);
  assert.deepEqual(store.sourceDataFor('ev1'), { version: 2 });
  assert.equal(store.sourcePayloads.get(first), undefined);
}

// Repeated upserts stay bounded.
{
  const store = new EvidenceStore();
  store.add({ id: 'ev1', kind: 'observation', sourceTool: 'test', sourceData: { version: 0 } });
  for (let i = 1; i <= 50; i++) {
    store.add({ id: 'ev1', kind: 'observation', sourceTool: 'test', sourceData: { version: i } });
  }
  assert.equal(store.records.size, 1);
  assert.equal(store.sourcePayloads.size, 1);
  assert.deepEqual(store.sourceDataFor('ev1'), { version: 50 });
}

// Distinct records keep distinct payloads.
{
  const store = new EvidenceStore();
  store.add({ id: 'a', kind: 'observation', sourceTool: 'test', sourceData: { v: 'a' } });
  store.add({ id: 'b', kind: 'observation', sourceTool: 'test', sourceData: { v: 'b' } });
  assert.equal(store.records.size, 2);
  assert.equal(store.sourcePayloads.size, 2);
}

// Updating one record must not drop another record's payload.
{
  const store = new EvidenceStore();
  store.add({ id: 'a', kind: 'observation', sourceTool: 'test', sourceData: { v: 1 } });
  store.add({ id: 'b', kind: 'observation', sourceTool: 'test', sourceData: { v: 2 } });
  const bId = store.get('b').sourceRef.evidenceSourceId;
  store.add({ id: 'a', kind: 'observation', sourceTool: 'test', sourceData: { v: 3 } });
  assert.equal(store.sourcePayloads.size, 2);
  assert.deepEqual(store.sourceDataFor('b'), { v: 2 });
  assert.ok(store.sourcePayloads.has(bId));
}

console.log('issue-6031 EvidenceStore upsert payload GC tests passed');
