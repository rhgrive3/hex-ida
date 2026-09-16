import assert from 'node:assert/strict';
import { createMatchResult, recognitionCanClaimUnique, promoteKnowledgeSuggestion } from '../../../js/knowledge/phase12-recognition.js';

const forgedEntity = { toString() { return 'function:victim'; } };
const forgedEntry = { toString() { return 'libc:malloc'; } };
const forgedScore = { valueOf() { return 1; } };

// identity must be primitive strings, never String()-coerced structured values
assert.throws(() => createMatchResult({
  sourceEntityId: forgedEntity,
  packageEntryId: 'libc:malloc',
  candidates: [{ packageEntryId: 'libc:malloc', score: 1, confidence: 1 }],
}), TypeError, 'object source identity must not be String()-coerced');

assert.throws(() => createMatchResult({
  sourceEntityId: 'function:victim',
  packageEntryId: forgedEntry,
  candidates: [{ packageEntryId: forgedEntry, score: 1, confidence: 1 }],
}), TypeError, 'object package identity must not be String()-coerced');

for (const bad of [123, true, ['function:victim'], { toString() { return 'x'; } }]) {
  assert.throws(() => createMatchResult({
    sourceEntityId: bad,
    packageEntryId: 'libc:malloc',
    candidates: [{ packageEntryId: 'libc:malloc', score: 1, confidence: 1 }],
  }), TypeError, 'structured source identity must be rejected');
}

assert.throws(() => createMatchResult({
  sourceEntityId: 'function:victim',
  packageEntryId: 'libc:malloc',
  candidates: [{ sourceEntityId: forgedEntity, packageEntryId: 'libc:malloc', score: 1, confidence: 1 }],
}), TypeError, 'structured candidate source identity must be rejected');

// score/confidence must be primitive finite numbers, never Number()-coerced
for (const bad of ['0.9', [0.9], {}, forgedScore, NaN, Infinity, -Infinity]) {
  assert.throws(() => createMatchResult({
    sourceEntityId: 'fn:a',
    packageEntryId: 'pkg:a',
    candidates: [{ packageEntryId: 'pkg:a', score: bad, confidence: bad }],
  }), TypeError, `non-primitive/non-finite score ${String(bad)} must be rejected`);
}

for (const good of [0, 0.5, 1]) {
  const accepted = createMatchResult({
    sourceEntityId: 'fn:a',
    packageEntryId: 'pkg:a',
    candidates: [{ packageEntryId: 'pkg:a', score: good, confidence: good }],
  });
  assert.equal(accepted.score, good);
  assert.equal(accepted.confidence, good);
}

const valid = createMatchResult({
  sourceEntityId: 'function:victim',
  packageEntryId: 'libc:malloc',
  candidates: [{ packageEntryId: 'libc:malloc', tier: 'semantic', score: 1, confidence: 1 }],
});
assert.equal(valid.sourceEntityId, 'function:victim');
assert.equal(recognitionCanClaimUnique(valid), true, 'valid unique suggestion is still claimable');

// L4 promotion must re-validate target identity/score before minting a fact
const forgedResult = {
  id: 'match:forged',
  authority: 'L2-suggestion',
  status: 'suggestion',
  unique: true,
  candidateSearchTruncated: false,
  completeness: 'complete',
  conflictingFeatures: [],
  score: 1,
  confidence: 1,
  evidenceIds: [],
  sourceEntityId: forgedEntity,
  packageEntryId: 'libc:malloc',
};
assert.throws(
  () => promoteKnowledgeSuggestion(forgedResult, { actorId: 'local-user' }),
  (error) => error instanceof TypeError && /identity/i.test(error.message),
  'structured identity must not reach L4 canonical promotion',
);

console.log('phase12 recognition #3925 coercion fail-closed: ok');
