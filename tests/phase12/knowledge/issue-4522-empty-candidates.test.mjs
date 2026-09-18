import assert from 'node:assert/strict';
import { createMatchResult, recognizeWithKnowledgeDB } from '../../../js/knowledge/phase12-recognition.js';

assert.throws(
  () => createMatchResult({ sourceEntityId: 'fn:1', packageEntryId: 'pkg:1', candidates: [] }),
  (error) => error?.message === 'recognition candidates are required',
  'an explicit empty candidate set must fail at the constructor boundary',
);

const noMatch = await recognizeWithKnowledgeDB({
  db: { findMatches: async () => [] },
  input: { sourceEntityId: 'fn:1' },
});
assert.deepEqual(noMatch, {
  status: 'no-match',
  completeness: 'complete',
  candidateSearchTruncated: false,
  candidates: [],
});

const sorted = createMatchResult({
  sourceEntityId: 'fn:1',
  packageEntryId: 'pkg:fallback',
  candidates: [
    { packageEntryId: 'pkg:low', score: 0.2 },
    { packageEntryId: 'pkg:high', score: 0.9 },
  ],
});
assert.equal(sorted.candidates[0].packageEntryId, 'pkg:high');
assert.equal(sorted.candidateCount, 2);
assert.equal(sorted.status, 'suggestion');

console.log('issue-4522-empty-candidates: PASS');
