import assert from 'node:assert/strict';
import { HypothesisStore } from '../../../js/ai/hypothesis.js';

function evidenceStore() {
  const records = new Map([
    ['ev-support', { id: 'ev-support', status: 'verified' }],
    ['ev-contradiction', { id: 'ev-contradiction', status: 'verified' }],
  ]);
  return {
    has(id) { return records.has(id); },
    get(id) { return records.get(id) || null; },
  };
}

{
  const store = new HypothesisStore(evidenceStore());
  const initial = store.upsert({
    id: 'h-supported',
    claim: 'candidate A is relevant',
    confidence: 0.7,
    status: 'supported',
    supportEvidenceIds: ['ev-support'],
    missingEvidence: ['verify caller'],
  });
  assert.equal(initial.status, 'supported');

  const confidenceOnly = store.upsert({ id: 'h-supported', confidence: 0.8 });
  assert.equal(confidenceOnly.confidence, 0.8);
  assert.equal(confidenceOnly.claim, 'candidate A is relevant');
  assert.equal(confidenceOnly.status, 'supported', 'omitting status must preserve the existing supported verdict');
  assert.deepEqual(confidenceOnly.supportEvidenceIds, ['ev-support'], 'omitting supportEvidenceIds must preserve the evidence link');
  assert.deepEqual(confidenceOnly.missingEvidence, ['verify caller']);

  const claimOnly = store.upsert({ id: 'h-supported', claim: 'candidate A remains relevant' });
  assert.equal(claimOnly.claim, 'candidate A remains relevant');
  assert.equal(claimOnly.status, 'supported');
  assert.deepEqual(claimOnly.supportEvidenceIds, ['ev-support']);

  const explicitClear = store.upsert({ id: 'h-supported', supportEvidenceIds: [] });
  assert.equal(explicitClear.status, 'open', 'explicitly clearing support must invalidate supported status');
  assert.deepEqual(explicitClear.supportEvidenceIds, []);
}

{
  const store = new HypothesisStore(evidenceStore());
  store.upsert({
    id: 'h-open-downgrade',
    claim: 'candidate B',
    status: 'supported',
    supportEvidenceIds: ['ev-support'],
  });
  const downgraded = store.upsert({ id: 'h-open-downgrade', status: 'open' });
  assert.equal(downgraded.status, 'open', 'an explicit open status must remain an intentional downgrade');
  assert.deepEqual(downgraded.supportEvidenceIds, ['ev-support'], 'status-only updates must not silently erase evidence relationships');
}

{
  const store = new HypothesisStore(evidenceStore());
  store.upsert({
    id: 'h-contradiction',
    claim: 'candidate C',
    status: 'open',
    contradictionEvidenceIds: ['ev-contradiction'],
    missingEvidence: ['inspect writer'],
  });
  const partial = store.upsert({ id: 'h-contradiction', confidence: 0.4 });
  assert.equal(partial.status, 'open');
  assert.deepEqual(partial.contradictionEvidenceIds, ['ev-contradiction'], 'omitted contradiction evidence must be preserved');
  assert.deepEqual(partial.missingEvidence, ['inspect writer'], 'omitted missing evidence must be preserved');

  const cleared = store.upsert({ id: 'h-contradiction', contradictionEvidenceIds: [], missingEvidence: [] });
  assert.deepEqual(cleared.contradictionEvidenceIds, [], 'an explicit empty contradiction list must clear it');
  assert.deepEqual(cleared.missingEvidence, [], 'an explicit empty missingEvidence list must clear it');
}

{
  const store = new HypothesisStore(evidenceStore());
  store.upsert({ id: 'h-verified', claim: 'verified claim', supportEvidenceIds: ['ev-support'] });
  const verified = store.verify('h-verified', ['ev-support']);
  assert.equal(verified.status, 'verified');
  const verifiedRewrite = store.upsert({ id: 'h-verified', claim: 'model rewrite', confidence: 0.01, supportEvidenceIds: [] });
  assert.strictEqual(verifiedRewrite, verified, 'model partial updates must not rewrite a deterministic verified hypothesis');

  store.upsert({ id: 'h-rejected', claim: 'rejected claim' });
  const rejected = store.reject('h-rejected', ['ev-contradiction']);
  assert.equal(rejected.status, 'rejected');
  const rejectedRewrite = store.upsert({ id: 'h-rejected', claim: 'model rewrite', contradictionEvidenceIds: [] });
  assert.strictEqual(rejectedRewrite, rejected, 'model partial updates must not rewrite a deterministic rejected hypothesis');
}

{
  const store = new HypothesisStore(evidenceStore());
  store.upsert({
    id: 'h-prototype',
    claim: 'prototype fields are not updates',
    status: 'supported',
    supportEvidenceIds: ['ev-support'],
  });
  const inherited = Object.create({ status: 'open', supportEvidenceIds: [] });
  inherited.id = 'h-prototype';
  inherited.confidence = 0.9;
  const updated = store.upsert(inherited);
  assert.equal(updated.status, 'supported', 'inherited status must not count as an explicit update');
  assert.deepEqual(updated.supportEvidenceIds, ['ev-support'], 'inherited evidence arrays must not clear canonical links');
}

console.log('[phase12] #4588 hypothesis partial-upsert semantics passed');
