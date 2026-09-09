import assert from 'node:assert/strict';

import { EvidenceStore } from '../js/ai/evidence.js';

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
