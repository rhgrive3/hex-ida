import assert from 'node:assert/strict';
import { createMatchResult, recognitionCanClaimUnique } from '../../../js/knowledge/phase12-recognition.js';

const tied = createMatchResult({
  sourceEntityId: 'entity-a',
  packageEntryId: 'entry-a',
  ambiguityWindow: 'not-a-number',
  candidates: [
    { packageEntryId: 'entry-a', score: 0.9, confidence: 0.9 },
    { packageEntryId: 'entry-b', score: 0.9, confidence: 0.9 },
  ],
});

assert.equal(tied.ambiguityMargin, 0);
assert.equal(tied.unique, false);
assert.equal(tied.status, 'ambiguous');
assert.equal(recognitionCanClaimUnique(tied), false);

const infinite = createMatchResult({
  sourceEntityId: 'entity-a',
  packageEntryId: 'entry-a',
  ambiguityWindow: Infinity,
  candidates: [
    { packageEntryId: 'entry-a', score: 0.9 },
    { packageEntryId: 'entry-b', score: 0.89 },
  ],
});
assert.equal(infinite.status, 'ambiguous');

console.log('phase12 recognition ambiguity window: ok');
