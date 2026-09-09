// Regression for #5216 (review R2–R4): promoteKnowledgeSuggestion() must not
// accept approval evidence a caller can fabricate. That covers (a) plain
// self-declared {approved:true, targetMatchId} tokens, (b) duck-typed
// { consumeGrant(){…} } authority objects passed as options, (c) an untrusted
// caller self-minting an authority (an exported factory or the exported
// issuance seam imported from any other module), (d) issuance without a real
// user interaction, and (e) spending a grant under a different host project
// binding than it was minted under. Contract now: the consuming authority is
// module-private and host-held — promotion consumes grants only from that
// instance — issuance requires the platform Event of a browser-trusted
// user-activation gesture (real Event instance, isTrusted read through the
// captured prototype getter so an own-property shadow cannot forge it), and
// consumption re-verifies the host project binding current at consumption
// time. Grants stay single-use and bound to the match identity (match id,
// target entity, package entry/hash, algorithm version, actor identity,
// interaction type, project binding).
//
// The harness realm shim MUST be imported before the module: it installs the
// harness Event platform API this trusted-runner realm uses (static import
// order below).
import '../../phase12/knowledge/harness-event-realm.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as recognition from '../../../js/knowledge/phase12-recognition.js';
import { syntheticEvent, trustedApprovalGesture } from './harness-event-realm.mjs';
const { createMatchResult, promoteKnowledgeSuggestion, issueRecognitionApprovalGrant } = recognition;

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

test('#5216 the authority factory is not exported: untrusted code cannot self-mint an issuer', () => {
  assert.equal(recognition.createRecognitionApprovalAuthority, undefined,
    'creating an authority must be impossible from outside the module');
  assert.equal(typeof recognition.issueRecognitionApprovalGrant, 'function',
    'the host issuance seam is the only way to obtain a grant');
});

test('#5216 a plain self-declared token is rejected', () => {
  assert.throws(
    () => promoteKnowledgeSuggestion(result, { actorId: 'attacker', approvalToken: { approved: true, targetMatchId: result.id } }),
    /approval/,
  );
  assert.throws(() => promoteKnowledgeSuggestion(result, { actorId: 'attacker' }), /approval/);
});

test('#5216 a duck-typed forged authority object cannot consume its own grant', () => {
  assert.throws(
    () => promoteKnowledgeSuggestion(result, {
      approvalAuthority: { consumeGrant: () => ({ actorId: 'attacker', matchId: result.id, sourceEntityId: result.sourceEntityId, packageEntryId: result.packageEntryId, packageContentHash: null, algorithmVersion: result.algorithmVersion }) },
      approvalGrant: 'forged',
    }),
    /host-issued/,
    'promotion must not accept caller-supplied authority objects',
  );
  assert.throws(
    () => promoteKnowledgeSuggestion(result, {
      approvalAuthority: { consumeGrant() { throw new Error('never called'); } },
      approvalGrant: 'forged',
    }),
    /host-issued/,
  );
});

test('#5216 an untrusted self-mint via any exported surface cannot promote', () => {
  // No exported binding may expose authority machinery: nothing carries
  // grant issuance or consumption, and the factory is absent.
  assert.equal(recognition.createRecognitionApprovalAuthority, undefined);
  for (const [name, value] of Object.entries(recognition)) {
    assert.ok(!value?.issueGrant, `${name} must not expose grant issuance`);
    assert.ok(!value?.consumeGrant, `${name} must not expose grant consumption`);
  }
  // Even a forged token cannot pass without host issuance.
  assert.throws(
    () => promoteKnowledgeSuggestion(result, { approvalGrant: 'recognition-grant_forged' }),
    /not valid/,
  );
});

test('#5216 importing the module is not enough to mint approval: issuance requires the platform Event of a browser-trusted gesture', () => {
  // The exact R4 counterexample: a caller-made plain object claiming
  // { type:'click', isTrusted:true } is not approval evidence — it is not a
  // platform Event at all.
  assert.throws(
    () => issueRecognitionApprovalGrant(result, { actorId: 'attacker', interaction: { type: 'click', isTrusted: true } }),
    /platform Event/,
    'a plain caller-built object is not an interaction event',
  );
  // A real platform Event that was not trusted by the user agent (script
  // constructed / dispatched) carries isTrusted false and must fail.
  assert.throws(
    () => issueRecognitionApprovalGrant(result, { actorId: 'attacker', interaction: syntheticEvent('click') }),
    /browser-trusted/,
    'synthetic platform events are not approval evidence',
  );
  // An own-property isTrusted shadow must not defeat the getter read.
  const shadowed = syntheticEvent('click');
  Object.defineProperty(shadowed, 'isTrusted', { value: true });
  assert.throws(
    () => issueRecognitionApprovalGrant(result, { actorId: 'attacker', interaction: shadowed }),
    /browser-trusted/,
    'an own isTrusted shadow cannot forge user activation',
  );
  // An indirect event type is not a direct approval gesture.
  assert.throws(
    () => issueRecognitionApprovalGrant(result, { actorId: 'attacker', interaction: trustedApprovalGesture('load') }),
    /direct approval gesture/,
    'indirect event types are not approval gestures',
  );
  // Missing / non-event interactions fail closed.
  assert.throws(
    () => issueRecognitionApprovalGrant(result, { actorId: 'attacker' }),
    /user interaction/,
    'issuance without any interaction event must fail',
  );
  assert.throws(
    () => issueRecognitionApprovalGrant(result, { actorId: 'attacker', interaction: 'click' }),
    /user interaction/,
    'a bare string is not an interaction event',
  );
  // The self-minted "authority" therefore never exists: even a call that
  // imagined a grant cannot pass the module-private consumption check.
  assert.throws(
    () => promoteKnowledgeSuggestion(result, { approvalGrant: 'recognition-grant_attacker_minted' }),
    /not valid/,
  );
});

test('#5216 a host-issued grant succeeds exactly once, then replays fail', () => {
  const grant = issueRecognitionApprovalGrant(result, { actorId: 'actor-a', interaction: trustedApprovalGesture('click') });
  const fact = promoteKnowledgeSuggestion(result, { approvalGrant: grant.token });
  assert.equal(fact.authority, 'L4-local-canonical');
  assert.equal(fact.confirmation, 'user-confirmed');
  assert.equal(fact.provenance.actorId, 'actor-a', 'L4 actor must come from the verified grant');
  assert.equal(fact.provenance.approvedMatchId, result.id);
  assert.throws(
    () => promoteKnowledgeSuggestion(result, { approvalGrant: grant.token }),
    /not valid/,
    'grant replay must fail closed',
  );
});

test('#5216 grants stay bound to match identity, actor and package content', () => {
  const other = uniqueResult({ sourceEntityId: 'fn:2000', packageEntryId: 'pkg:other' });
  const changedHash = uniqueResult({ packageContentHash: 'hash-b' });
  const grant = issueRecognitionApprovalGrant(result, { actorId: 'actor-a', interaction: trustedApprovalGesture('pointerdown') });
  assert.throws(
    () => promoteKnowledgeSuggestion(other, { approvalGrant: grant.token }),
    /bound to a different/,
  );
  assert.throws(
    () => promoteKnowledgeSuggestion(changedHash, { approvalGrant: grant.token }),
    /bound to a different/,
  );
  assert.throws(
    () => promoteKnowledgeSuggestion(result, { approvalGrant: grant.token, actorId: 'actor-b' }),
    /bound to a different actor/,
  );
  // The bound actor can still promote exactly once.
  promoteKnowledgeSuggestion(result, { approvalGrant: grant.token });
});

test('#5216 the host project/binary binding is recorded on grants and re-verified at consumption (review R4)', () => {
  recognition.configureRecognitionApprovalHost({ projectBinding: 'project-A' });
  try {
    const grant = issueRecognitionApprovalGrant(result, { actorId: 'actor-a', interaction: trustedApprovalGesture('click') });
    assert.equal(grant.projectBinding, 'project-A');
    assert.equal(grant.interactionType, 'click', 'the approval gesture is part of the grant provenance');
    // Re-binding the host (e.g. a different project/binary loaded) must
    // invalidate the previously minted grant — consumption re-verifies the
    // binding CURRENT at consumption time.
    recognition.configureRecognitionApprovalHost({ projectBinding: 'project-B' });
    assert.throws(
      () => promoteKnowledgeSuggestion(result, { approvalGrant: grant.token }),
      /bound to a different project binding/,
      'a grant minted under one binding cannot be spent after the host re-binds',
    );
    // A grant minted under the new binding promotes normally.
    const grantB = issueRecognitionApprovalGrant(result, { actorId: 'actor-a', interaction: trustedApprovalGesture('click') });
    const fact = promoteKnowledgeSuggestion(result, { approvalGrant: grantB.token });
    assert.equal(fact.confirmation, 'user-confirmed');
  } finally {
    recognition.configureRecognitionApprovalHost({ projectBinding: null });
  }
});

test('#5216 an unbound grant cannot be spent once the host carries a binding', () => {
  const grant = issueRecognitionApprovalGrant(result, { actorId: 'actor-a', interaction: trustedApprovalGesture('click') });
  assert.equal(grant.projectBinding, null);
  recognition.configureRecognitionApprovalHost({ projectBinding: 'project-A' });
  try {
    assert.throws(
      () => promoteKnowledgeSuggestion(result, { approvalGrant: grant.token }),
      /bound to a different project binding/,
      'an unbound grant cannot be spent under any binding',
    );
  } finally {
    recognition.configureRecognitionApprovalHost({ projectBinding: null });
  }
});

test('#5216 ambiguous/truncated promotion stays forbidden (grant not even consulted)', () => {
  const ambiguous = createMatchResult({
    sourceEntityId: 'fn:3000', packageEntryId: 'pkg:a',
    candidates: [
      { packageEntryId: 'pkg:a', score: 0.94 },
      { packageEntryId: 'pkg:b', score: 0.93 },
    ],
  });
  assert.throws(() => promoteKnowledgeSuggestion(ambiguous, { approvalGrant: 'unused' }), /ambiguous or truncated/);
  const truncated = uniqueResult({ candidateSearchTruncated: true });
  assert.throws(() => promoteKnowledgeSuggestion(truncated, { approvalGrant: 'unused' }), /ambiguous or truncated/);
});
