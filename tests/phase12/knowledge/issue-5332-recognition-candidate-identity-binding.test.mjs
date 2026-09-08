// Regression for #5332: createMatchResult() preserved candidate-side
// sourceEntityId values without ever checking them against the result's own
// sourceEntityId. A candidate belonging to a different entity could be ranked
// first, and its package/evidence provenance then flowed into the result's
// top-level fields and onward into promoteKnowledgeSuggestion()'s L4 fact —
// laundering entity B's match evidence into entity A's canonical fact.
// Contract now: candidates are alternatives for ONE source entity; a
// mismatched candidate.sourceEntityId fails closed at the constructor
// boundary.
import assert from 'node:assert/strict';
import {
  createMatchResult,
  recognitionCanClaimUnique,
  promoteKnowledgeSuggestion,
} from '../../../js/knowledge/phase12-recognition.js';

function expectIdentityMismatch(fn, label) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof TypeError, true, `${label}: expected TypeError, got ${error.constructor.name}: ${error.message}`);
    assert.match(error.message, /candidate source entity mismatch/, `${label}: unexpected message: ${error.message}`);
    return true;
  }, label);
}

// 1. The issue's exact scenario: single high-score candidate for entity B
//    inside a result targeting entity A must be rejected outright.
expectIdentityMismatch(() => createMatchResult({
  sourceEntityId: 'function:A',
  packageEntryId: 'pkg:entry-B',
  candidates: [{
    sourceEntityId: 'function:B',
    packageEntryId: 'pkg:entry-B',
    tier: 'exact-content',
    score: 1,
    confidence: 1,
    featuresUsed: ['exact-bytes'],
    conflictingFeatures: [],
    evidenceIds: ['evidence-for-B'],
    packageContentHash: 'pkg-hash',
  }],
}), 'single mismatched candidate is rejected');

// 2. Even when the mismatched candidate is NOT ranked first, its presence
//    would still taint ranking/provenance, so it must fail closed too.
expectIdentityMismatch(() => createMatchResult({
  sourceEntityId: 'function:A',
  packageEntryId: 'pkg:entry-A',
  candidates: [
    { sourceEntityId: 'function:A', packageEntryId: 'pkg:entry-A', score: 1 },
    { sourceEntityId: 'function:B', packageEntryId: 'pkg:entry-B', score: 0.5 },
  ],
}), 'mismatched non-top candidate is rejected');

// 3. No laundering path: promotion must stay unreachable for a mismatched
//    result (already covered by the constructor throw, but pin the chain:
//    no fact may carry entity B provenance under entity A target).
{
  let fact = null;
  try {
    const result = createMatchResult({
      sourceEntityId: 'function:A',
      packageEntryId: 'pkg:entry-B',
      candidates: [{ sourceEntityId: 'function:B', packageEntryId: 'pkg:entry-B', score: 1 }],
    });
    fact = promoteKnowledgeSuggestion(result, {
      actorId: 'local-user',
      approvalToken: { approved: true, targetMatchId: result.id },
    });
  } catch {
    // constructor rejection is the expected fail-closed outcome
  }
  assert.equal(fact, null, 'no L4 fact may be produced from a mismatched match result');
}

// 4. Canonical control: candidates that inherit the result identity
//    (candidate.sourceEntityId absent → falls back to the result identity)
//    keep working, uniqueness intact.
{
  const result = createMatchResult({
    sourceEntityId: 'function:A',
    packageEntryId: 'pkg:entry-A',
    candidates: [{
      packageEntryId: 'pkg:entry-A',
      tier: 'exact-content',
      score: 1,
      confidence: 1,
      evidenceIds: ['evidence-for-A'],
    }],
  });
  assert.equal(result.sourceEntityId, 'function:A');
  assert.equal(result.candidates[0].sourceEntityId, 'function:A');
  assert.equal(result.unique, true);
  assert.equal(recognitionCanClaimUnique(result), true);
}

// 5. Canonical control: explicit matching candidate identities are accepted.
{
  const result = createMatchResult({
    sourceEntityId: 'entity-a',
    packageEntryId: 'entry-a',
    candidates: [
      { sourceEntityId: 'entity-a', packageEntryId: 'entry-a', score: 0.99, tier: 'exact-content' },
      { sourceEntityId: 'entity-a', packageEntryId: 'entry-b', score: 0.5 },
    ],
  });
  assert.equal(result.unique, true);
  assert.equal(result.status, 'suggestion');
}

// 6. The dynamic path (recognizeWithKnowledgeDB) maps every match onto the
//    input's own identity, so it must remain unaffected by the new gate.
{
  const calls = [];
  const db = {
    async findMatches(input) {
      calls.push(input);
      return [
        { identity: 'exact', confidence: 0.97, record: { identityKey: 'entry-a' }, reasons: ['exact-bytes'], evidence: [{ id: 'ev-1' }] },
        { identity: 'normalized', confidence: 0.8, record: { identityKey: 'entry-b' }, reasons: ['relaxed'], evidence: [] },
      ];
    },
  };
  const result = await recognize(db);
  assert.equal(result.sourceEntityId, 'function:A');
  assert.equal(result.candidateCount, 2);
  assert.equal(result.unique, true);

  async function recognize(db) {
    const { recognizeWithKnowledgeDB } = await import('../../../js/knowledge/phase12-recognition.js');
    return recognizeWithKnowledgeDB({ db, input: { sourceEntityId: 'function:A', packageEntryId: 'pkg' } });
  }
}

console.log('issue-5332 recognition candidate identity binding: ok');
