import assert from 'node:assert/strict';

import { HypothesisStore } from '../js/ai/hypothesis.js';

function evidenceStore() {
  const verified = new Map([
    ['ev-support', { status: 'verified' }],
    ['ev-contradiction', { status: 'verified' }],
  ]);
  return {
    has: (id) => verified.has(id),
    get: (id) => verified.get(id) || null,
  };
}

function attemptMutation(callback) {
  try { callback(); } catch { /* frozen accessors may throw in strict mode */ }
}

const store = new HypothesisStore(evidenceStore());
const created = store.upsert({
  id: 'h-4434',
  claim: 'original claim',
  status: 'open',
  supportEvidenceIds: ['ev-support'],
  contradictionEvidenceIds: [],
  missingEvidence: ['one more check'],
});
assert.ok(created);

// Every public route that returns the record must be safe to hand to UI/model
// callers. Mutating the returned object or any nested collection must not
// change the store's authority state.
for (const leaked of [created, store.get('h-4434'), store.all()[0]]) {
  attemptMutation(() => { leaked.status = 'verified'; });
  attemptMutation(() => { leaked.claim = 'tampered claim'; });
  attemptMutation(() => { leaked.supportEvidenceIds.push('forged-support'); });
  attemptMutation(() => { leaked.contradictionEvidenceIds.splice(0, 1); });
  attemptMutation(() => { leaked.missingEvidence[0] = 'tampered missing check'; });
}
assert.equal(store.get('h-4434').status, 'open');
assert.equal(store.get('h-4434').claim, 'original claim');
assert.deepEqual(store.get('h-4434').supportEvidenceIds, ['ev-support']);
assert.deepEqual(store.get('h-4434').contradictionEvidenceIds, []);
assert.deepEqual(store.get('h-4434').missingEvidence, ['one more check']);

const verified = store.verify('h-4434', ['ev-support']);
assert.equal(verified.status, 'verified');
assert.ok(Object.isFrozen(verified));
attemptMutation(() => { verified.status = 'open'; });
attemptMutation(() => { verified.supportEvidenceIds.push('forged-support'); });
assert.equal(store.get('h-4434').status, 'verified');
assert.deepEqual(store.get('h-4434').supportEvidenceIds, ['ev-support']);

const rejected = store.reject('h-4434', ['ev-contradiction']);
assert.equal(rejected.status, 'rejected');
attemptMutation(() => { rejected.status = 'verified'; });
attemptMutation(() => { rejected.contradictionEvidenceIds.push('forged-contradiction'); });
assert.equal(store.get('h-4434').status, 'rejected');
assert.deepEqual(store.get('h-4434').contradictionEvidenceIds, ['ev-contradiction']);

console.log('issue #4434 hypothesis record immutability: PASS');
