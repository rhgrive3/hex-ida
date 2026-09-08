// Regression for #5216: promoteKnowledgeSuggestion() accepted a plain
// self-declared { approved:true, targetMatchId } object as "user approval",
// so any caller could forge human confirmation and launder an L2 suggestion
// into an L4-local-canonical knowledge fact. Contract now: promotion
// requires an opaque single-use grant issued by a host-held
// createRecognitionApprovalAuthority() bound to the exact match id, target
// entity, package identity/hash, algorithm version, actor identity and
// project/binary binding; replay and cross-target/cross-actor reuse fail
// closed, and L4 provenance comes from the verified grant.
import assert from 'node:assert/strict';
import { createMatchResult, promoteKnowledgeSuggestion, createRecognitionApprovalAuthority } from '../../../js/knowledge/phase12-recognition.js';

function uniqueResult(overrides = {}) {
  return createMatchResult({
    sourceEntityId: 'fn:1000',
    packageEntryId: 'pkg:entry',
    packageContentHash: 'hash-a',
    candidates: [{
      sourceEntityId: 'fn:1000', packageEntryId: 'pkg:entry', tier: 'semantic',
      score: 0.95, confidence: 0.95, featuresUsed: ['semantic-hash'],
      conflictingFeatures: [], evidenceIds: ['ev:1'],
    }],
    ...overrides,
  });
}

const result = uniqueResult();

// 1. A hand-made {approved:true, targetMatchId} token is rejected.
assert.throws(
  () => promoteKnowledgeSuggestion(result, { actorId: 'attacker', approvalToken: { approved: true, targetMatchId: result.id } }),
  /approval/,
);
// Missing authority/grant entirely is rejected the same way.
assert.throws(() => promoteKnowledgeSuggestion(result, { actorId: 'attacker' }), /approval/);
assert.throws(
  () => promoteKnowledgeSuggestion(result, { actorId: 'attacker', approvalAuthority: createRecognitionApprovalAuthority(), approvalGrant: 'made-up' }),
  /not valid/,
);

const authority = createRecognitionApprovalAuthority({ projectBinding: 'project-A' });

// 2. A grant issued for a different match result cannot promote this one.
{
  const other = uniqueResult({ sourceEntityId: 'fn:2000', packageEntryId: 'pkg:other' });
  const otherGrant = authority.issueGrant(other, { actorId: 'actor-a' });
  assert.throws(
    () => promoteKnowledgeSuggestion(result, { approvalAuthority: authority, approvalGrant: otherGrant.token }),
    /bound to a different/,
  );
}

// 3. A consumed grant cannot be replayed.
{
  const grant = authority.issueGrant(result, { actorId: 'actor-a' });
  const fact = promoteKnowledgeSuggestion(result, { approvalAuthority: authority, approvalGrant: grant.token });
  assert.equal(fact.authority, 'L4-local-canonical');
  assert.equal(fact.confirmation, 'user-confirmed');
  assert.equal(fact.provenance.actorId, 'actor-a', 'L4 actor must come from the verified grant');
  assert.equal(fact.provenance.approvedMatchId, result.id);
  assert.throws(
    () => promoteKnowledgeSuggestion(result, { approvalAuthority: authority, approvalGrant: grant.token }),
    /not valid/,
    'grant replay must fail closed',
  );
}

// 4. Bindings: package content hash, actor and project/binary authority.
{
  const changedHash = uniqueResult({ packageContentHash: 'hash-b' });
  const grant = authority.issueGrant(result, { actorId: 'actor-a' });
  assert.throws(
    () => promoteKnowledgeSuggestion(changedHash, { approvalAuthority: authority, approvalGrant: grant.token }),
    /bound to a different/,
    'a grant must not survive a package/binary binding change',
  );
  // Same authority instance (same binding) still works for the bound match.
  promoteKnowledgeSuggestion(result, { approvalAuthority: authority, approvalGrant: grant.token });
  const foreignAuthority = createRecognitionApprovalAuthority({ projectBinding: 'project-B' });
  const grantB = foreignAuthority.issueGrant(result, { actorId: 'actor-a' });
  assert.throws(
    () => promoteKnowledgeSuggestion(result, { approvalAuthority: authority, approvalGrant: grantB.token }),
    /not valid/,
    'grants are bound to their issuing host authority (project/binary binding)',
  );
  assert.throws(
    () => promoteKnowledgeSuggestion(result, { approvalAuthority: foreignAuthority, approvalGrant: grantB.token, actorId: 'actor-b' }),
    /bound to a different actor/,
    'actor mismatch fails closed',
  );
}

// 5. Ambiguous/truncated promotion stays forbidden (grant not even consulted).
{
  const ambiguous = createMatchResult({
    sourceEntityId: 'fn:3000', packageEntryId: 'pkg:a',
    candidates: [
      { packageEntryId: 'pkg:a', score: 0.94 },
      { packageEntryId: 'pkg:b', score: 0.93 },
    ],
  });
  assert.throws(
    () => promoteKnowledgeSuggestion(ambiguous, { approvalAuthority: authority, approvalGrant: 'unused' }),
    /ambiguous or truncated/,
  );
  const truncated = uniqueResult({ candidateSearchTruncated: true });
  assert.throws(
    () => promoteKnowledgeSuggestion(truncated, { approvalAuthority: authority, approvalGrant: 'unused' }),
    /ambiguous or truncated/,
  );
}

// 6. A valid host-issued grant succeeds exactly once with bound provenance.
{
  const freshAuthority = createRecognitionApprovalAuthority({ projectBinding: 'project-A' });
  const grant = freshAuthority.issueGrant(result, { actorId: 'actor-c' });
  const fact = promoteKnowledgeSuggestion(result, { approvalAuthority: freshAuthority, approvalGrant: grant.token, name: 'chosen-name' });
  assert.equal(fact.kind, 'knowledge-fact');
  assert.equal(fact.targetEntityId, result.sourceEntityId);
  assert.deepEqual(fact.value, { packageEntryId: 'pkg:entry', name: 'chosen-name' });
  assert.equal(fact.provenance.actorId, 'actor-c');
}
