import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { EvidenceStore } from '../../../js/ai/evidence.js';

const sourceData = {
  verified: false,
  nested: { value: 1 },
  facts: [{ address: '0x100', labels: ['original'] }],
};
const store = new EvidenceStore();
const added = store.add({
  id: 'ev-4436-supported',
  kind: 'observation',
  status: 'supported',
  sourceTool: 'issue-4436',
  sourceData,
  navigation: { address: '0x100', path: { segment: 'original' } },
});

assert.equal(added.status, 'supported');
assert.ok(added.sourceRef?.evidenceSourceId, 'local source payload should have a provenance identity');

// The caller-owned input must not remain an alias of the lossless local
// payload. Otherwise mutation after add() changes what sourceDataFor() returns.
sourceData.nested.value = 99;
sourceData.facts[0].labels.push('forged-input');
assert.deepEqual(store.sourceDataFor('ev-4436-supported'), {
  verified: false,
  nested: { value: 1 },
  facts: [{ address: '0x100', labels: ['original'] }],
});

const views = [
  ['add', added],
  ['get', store.get('ev-4436-supported')],
  ['all', store.all()[0]],
  ['byStatus', store.byStatus('supported')[0]],
  ['recentByStatus', store.recentByStatus('supported')[0]],
  ['pinned', store.pinned(['ev-4436-supported'])[0]],
];

for (const [name, view] of views) {
  assert.ok(view, `${name} must expose the evidence record`);
  assert.equal(Object.isFrozen(view), true, `${name} record must be frozen`);
  assert.equal(Object.isFrozen(view.sourceRef), true, `${name} sourceRef must be frozen`);
  assert.equal(Object.isFrozen(view.navigation.path), true, `${name} navigation must be deeply frozen`);
  assert.equal(Object.isFrozen(view.sourceData.facts[0].labels), true, `${name} sourceData arrays must be frozen`);
  assert.throws(() => { view.status = 'verified'; }, TypeError, `${name} cannot forge verification`);
  assert.throws(() => { view.sourceRef.evidenceSourceId = 'forged'; }, TypeError, `${name} cannot rewrite provenance`);
  assert.throws(() => { view.navigation.path.segment = 'forged'; }, TypeError, `${name} cannot rewrite navigation`);
  assert.throws(() => { view.sourceData.facts[0].labels.push('forged'); }, TypeError, `${name} cannot rewrite nested source data`);
}

const payload = store.sourceDataFor('ev-4436-supported');
assert.equal(Object.isFrozen(payload), true, 'sourceDataFor must return an owned frozen payload');
assert.equal(Object.isFrozen(payload.nested), true);
assert.throws(() => { payload.nested.value = 7; }, TypeError);
assert.throws(() => { payload.facts[0].labels.push('forged'); }, TypeError);

// A failed mutation attempt through every public view must not desynchronise
// the secondary status index or make the record appear verified.
assert.deepEqual(store.byStatus('supported').map((record) => record.id), ['ev-4436-supported']);
assert.deepEqual(store.byStatus('verified').map((record) => record.id), []);

store.restorePersistedConfirmed([{
  id: 'ev-4436-verified',
  kind: 'observation',
  status: 'verified',
  sourceTool: 'issue-4436',
  sourceData: { proof: { result: 'canonical' } },
}]);
const verified = store.get('ev-4436-verified');
assert.equal(verified.status, 'verified');
assert.equal(Object.isFrozen(verified), true);
assert.throws(() => { verified.status = 'supported'; }, TypeError, 'verified records remain immutable');
assert.throws(() => { verified.sourceData.proof.result = 'forged'; }, TypeError, 'verified payload remains immutable');
assert.deepEqual(store.verifiedIds(), ['ev-4436-verified']);
assert.deepEqual(store.byStatus('supported').map((record) => record.id), ['ev-4436-supported']);

console.log('issue-4436 EvidenceStore record immutability tests passed');

// The full source payload is lossless, unlike the compact JSON-safe record.
// Native containers must retain their types and graph relationships while
// mutations of either the input or a returned copy cannot reach the store.
const buffer = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
const bytes = new Uint16Array(buffer, 2, 2);
const view = new DataView(buffer, 1, 5);
const key = { name: 'original-key' };
const structured = {
  buffer, bytes, view, key,
  date: new Date('2026-01-02T00:00:00Z'),
  map: new Map([[key, { bytes }]]),
  set: new Set([key]),
  expression: /a/g,
};
structured.self = structured;
structured.expression.lastIndex = 1;
const structuredStore = new EvidenceStore();
structuredStore.add({ id: 'structured', sourceData: structured });

new Uint8Array(buffer).fill(99);
structured.date.setTime(0);
structured.map.clear();
structured.set.clear();
key.name = 'changed-input';
structured.expression.lastIndex = 0;

function checkStructuredPayload(payload) {
  assert.ok(payload.buffer instanceof ArrayBuffer);
  assert.ok(payload.bytes instanceof Uint16Array);
  assert.ok(payload.view instanceof DataView);
  assert.deepEqual([...new Uint8Array(payload.buffer)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(payload.bytes.byteOffset, 2);
  assert.equal(payload.bytes.length, 2);
  assert.equal(payload.view.byteOffset, 1);
  assert.equal(payload.view.byteLength, 5);
  assert.equal(payload.bytes.buffer, payload.buffer, 'views share the owned buffer');
  assert.equal(payload.view.buffer, payload.buffer);
  assert.equal(payload.self, payload, 'cyclic source structure is retained');
  assert.ok(payload.date instanceof Date);
  assert.equal(payload.date.toISOString(), '2026-01-02T00:00:00.000Z');
  assert.ok(payload.map instanceof Map);
  assert.equal(payload.map.size, 1);
  assert.equal(payload.map.get(payload.key).bytes, payload.bytes);
  assert.ok(payload.set instanceof Set);
  assert.equal(payload.set.size, 1);
  assert.ok(payload.set.has(payload.key), 'shared map/set key identity is retained');
  assert.equal(payload.key.name, 'original-key');
  assert.equal(Object.isFrozen(payload.key), true, 'plain native-container entries remain frozen');
  assert.ok(payload.expression instanceof RegExp);
  assert.equal(payload.expression.source, 'a');
  assert.equal(payload.expression.flags, 'g');
  assert.equal(payload.expression.lastIndex, 1);
}

const structuredCopy = structuredStore.sourceDataFor('structured');
checkStructuredPayload(structuredCopy);
structuredCopy.bytes[0] = 0;
structuredCopy.view.setUint8(0, 0);
structuredCopy.date.setTime(0);
structuredCopy.map.clear();
structuredCopy.set.clear();
assert.equal(structuredCopy.expression.exec('baab').index, 1);
const nextStructuredCopy = structuredStore.sourceDataFor('structured');
checkStructuredPayload(nextStructuredCopy);
assert.notEqual(nextStructuredCopy.buffer, structuredCopy.buffer, 'each read owns its backing storage');

if (typeof SharedArrayBuffer === 'function') {
  const shared = new SharedArrayBuffer(2);
  new Uint8Array(shared).set([9, 10]);
  structuredStore.add({ id: 'shared', sourceData: { shared, bytes: new Uint8Array(shared) } });
  new Uint8Array(shared).fill(0);
  const first = structuredStore.sourceDataFor('shared');
  assert.ok(first.shared instanceof SharedArrayBuffer);
  assert.equal(first.bytes.buffer, first.shared);
  assert.deepEqual([...first.bytes], [9, 10]);
  first.bytes.fill(0);
  assert.deepEqual([...structuredStore.sourceDataFor('shared').bytes], [9, 10]);
}

console.log('issue-4436 structured source payload isolation tests passed');

const foreign = runInNewContext(`(() => {
  const buffer = Uint8Array.from([11, 12, 13]).buffer;
  return { buffer, bytes: new Uint8Array(buffer, 1), view: new DataView(buffer),
    date: new Date('2026-01-02T00:00:00Z'), map: new Map([['key', 1]]), set: new Set([2]) };
})()`);
structuredStore.add({ id: 'foreign', sourceData: foreign });
foreign.bytes.fill(0);
foreign.date.setTime(0);
foreign.map.clear();
foreign.set.clear();
const foreignCopy = structuredStore.sourceDataFor('foreign');
assert.ok(foreignCopy.buffer instanceof ArrayBuffer);
assert.ok(foreignCopy.bytes instanceof Uint8Array);
assert.ok(foreignCopy.view instanceof DataView);
assert.equal(foreignCopy.bytes.buffer, foreignCopy.buffer);
assert.equal(foreignCopy.view.buffer, foreignCopy.buffer);
assert.equal(foreignCopy.bytes.byteOffset, 1);
assert.deepEqual([...foreignCopy.bytes], [12, 13]);
assert.equal(foreignCopy.date.toISOString(), '2026-01-02T00:00:00.000Z');
assert.deepEqual([...foreignCopy.map], [['key', 1]]);
assert.deepEqual([...foreignCopy.set], [2]);
