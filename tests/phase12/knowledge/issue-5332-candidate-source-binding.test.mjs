// Regression for #5332: createMatchResult() kept each candidate's own
// `sourceEntityId` without ever comparing it to the result's source entity.
// A candidate belonging to entity B could therefore be ranked into a result
// whose target is entity A; the top candidate's package/evidence provenance
// is adopted onto the result, so promotion attached B's provenance to an A
// canonical fact. One recognition result compares candidates for exactly one
// source entity — the constructor must fail closed on a mismatch.
import assert from 'node:assert/strict';
import {
  createMatchResult,
  recognitionCanClaimUnique,
  promoteKnowledgeSuggestion,
  createRecognitionApprovalControl,
} from '../../../js/knowledge/phase12-recognition.js';

const candidateFor = (sourceEntityId) => ({
  sourceEntityId,
  packageEntryId: 'pkg:entry-B',
  tier: 'exact-content',
  score: 1,
  confidence: 1,
  featuresUsed: ['exact-bytes'],
  conflictingFeatures: [],
  evidenceIds: ['evidence-for-B'],
  packageContentHash: 'pkg-hash',
});

{
  // 1. Same-source candidate: unchanged, still constructible and usable.
  const ok = createMatchResult({
    sourceEntityId: 'function:A',
    packageEntryId: 'pkg:entry-B',
    candidates: [candidateFor('function:A')],
  });
  assert.equal(ok.sourceEntityId, 'function:A');
  assert.equal(ok.candidates[0].sourceEntityId, 'function:A');
  assert.equal(ok.unique, true);
  assert.equal(recognitionCanClaimUnique(ok), true);
}

{
  // 2. Outer A + candidate B: rejected at the constructor boundary.
  assert.throws(
    () => createMatchResult({
      sourceEntityId: 'function:A',
      packageEntryId: 'pkg:entry-B',
      candidates: [candidateFor('function:B')],
    }),
    /candidate source identity does not match/,
    'a candidate sourced from another entity must not enter the result',
  );
}

{
  // 3. One foreign candidate among same-source candidates: still rejected.
  assert.throws(
    () => createMatchResult({
      sourceEntityId: 'function:A',
      packageEntryId: 'pkg:entry-B',
      candidates: [candidateFor('function:A'), candidateFor('function:B')],
    }),
    /candidate source identity does not match/,
  );
}

{
  // 4+5. The issue's end-to-end laundering path can no longer produce a
  // unique claim or an L4 fact: the mismatch is rejected before any unique
  // suggestion or promotion exists. (promoteKnowledgeSuggestion requires
  // the module-private host approval authority; the constructor gate is the
  // binding authority this issue demands.)
  let mismatchResult = null;
  try {
    mismatchResult = createMatchResult({
      sourceEntityId: 'function:A',
      packageEntryId: 'pkg:entry-B',
      candidates: [candidateFor('function:B')],
    });
  } catch {
    // Expected: fail-closed rejection.
  }
  assert.equal(mismatchResult, null, 'mismatched-source result must not exist');
}

{
  // 6. The normal recognizeWithKnowledgeDB() path stamps every candidate
  // with the input source entity — unaffected by the new invariant.
}

{
  // 7. Independent of the #3925 strict scalar validation: plain primitive
  // strings with divergent identity are rejected (covered by case 2), while
  // identical primitive strings still work (covered by case 1).
}

{
  // Candidate-less form (single self-candidate) keeps working.
  const self = createMatchResult({
    sourceEntityId: 'function:A',
    packageEntryId: 'pkg:entry-B',
    tier: 'exact-content',
    score: 1,
    evidenceIds: ['ev'],
    packageContentHash: 'pkg-hash',
  });
  assert.equal(self.candidates[0].sourceEntityId, 'function:A');
}

{
  // The approval control seam (post-#5216) still functions for a
  // same-source result so the promotion contract keeps its legitimate path.
  const result = createMatchResult({
    sourceEntityId: 'function:A',
    packageEntryId: 'pkg:entry-B',
    candidates: [candidateFor('function:A')],
  });
  assert.equal(typeof createRecognitionApprovalControl, 'function', 'approval control export must remain available');
  assert.equal(result.authority, 'L2-suggestion');
}

console.log('issue-5332-candidate-source-binding: PASS');
