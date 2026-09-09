// Regression for #5216 (review R2–R5): promoteKnowledgeSuggestion() must not
// accept approval evidence a caller can fabricate, and issuance must be bound
// host-side to the actual approval control for the target match. Covered
// classes: (a) plain self-declared {approved:true, targetMatchId} tokens,
// (b) duck-typed { consumeGrant(){…} } authority objects, (c) an untrusted
// caller self-minting an authority (no factory, no issuance seam), (d)
// caller-passed interaction events — even REAL trusted platform events —
// because Event.isTrusted proves user input happened, not that this
// suggestion was approved: a trusted click observed on another UI must not
// be launderable into an approval for an attacker-chosen result, (e) replay
// of an already-spent approval, (f) host project-binding re-verification at
// consumption. Contract: the consuming authority is module-private and
// host-held; the only issuance seam is createRecognitionApprovalControl(),
// a one-shot control bound to exactly one match whose approval record is
// minted (module-private, never handed out as data) only when the platform
// delivers a browser-trusted approval gesture to the surface the control is
// attached to (captured Event.prototype currentTarget getter), and the
// creator's onApproved continuation runs the local promotion.
//
// The harness realm shim MUST be imported before the module: it installs the
// harness Event platform API this trusted-runner realm uses (static import
// order below).
import '../../phase12/knowledge/harness-event-realm.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as recognition from '../../../js/knowledge/phase12-recognition.js';
import { fireTrustedApprovalGesture, syntheticEvent } from './harness-event-realm.mjs';
const { createMatchResult, promoteKnowledgeSuggestion, createRecognitionApprovalControl } = recognition;

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

// Mint an approval for `match` through the only legitimate path: a rendered
// approval surface carrying the control's listener, activated by a real
// trusted gesture delivered to THAT surface.
function approveThroughControl(match, { actorId = 'actor-a', surface = new globalThis.HarnessEventTarget(), onApproved = () => {} } = {}) {
  const control = createRecognitionApprovalControl(match, { actorId, onApproved });
  control.attach(surface);
  surface.addEventListener('click', control.handleEvent);
  const event = fireTrustedApprovalGesture(surface, 'click');
  surface.removeEventListener('click', control.handleEvent);
  return { control, surface, event };
}

test('#5216 the authority factory and the caller-supplied issuance seam are gone', () => {
  assert.equal(recognition.createRecognitionApprovalAuthority, undefined,
    'creating an authority must be impossible from outside the module');
  assert.equal(recognition.issueRecognitionApprovalGrant, undefined,
    'a caller-passed trusted event must not be issuable as approval evidence (review R5)');
  assert.equal(typeof recognition.createRecognitionApprovalControl, 'function',
    'the only issuance seam is a host-rendered approval control bound to one match');
});

test('#5216 a plain self-declared token is rejected', () => {
  assert.throws(
    () => promoteKnowledgeSuggestion(result, { actorId: 'attacker', approvalToken: { approved: true, targetMatchId: result.id } }),
    /cannot be supplied/,
  );
  assert.throws(() => promoteKnowledgeSuggestion(result, { actorId: 'attacker' }), /approval is required/);
});

test('#5216 a duck-typed forged authority object and caller approval options are rejected', () => {
  for (const options of [
    { actorId: 'attacker', approvalAuthority: { consumeGrant: () => ({ actorId: 'attacker', matchId: result.id, sourceEntityId: result.sourceEntityId, packageEntryId: result.packageEntryId, packageContentHash: null, algorithmVersion: result.algorithmVersion }) } },
    { actorId: 'attacker', approvalAuthority: { consumeFor: () => ({ actorId: 'attacker', matchId: result.id }) } },
    { actorId: 'attacker', approvalGrant: 'forged-token' },
    { actorId: 'attacker', interaction: new globalThis.Event('click', { trusted: true }) },
  ]) {
    assert.throws(
      () => promoteKnowledgeSuggestion(result, options),
      /cannot be supplied/,
      'promotion must not accept caller-supplied approval evidence of any shape',
    );
  }
});

test('#5216 an untrusted self-mint via any exported surface cannot promote', () => {
  assert.equal(recognition.createRecognitionApprovalAuthority, undefined);
  for (const [name, value] of Object.entries(recognition)) {
    assert.ok(!value?.issueGrant, `${name} must not expose grant issuance`);
    assert.ok(!value?.consumeGrant, `${name} must not expose grant consumption`);
    assert.ok(!value?.consumeFor, `${name} must not expose approval consumption`);
  }
  assert.throws(
    () => promoteKnowledgeSuggestion(result, { actorId: 'attacker' }),
    /approval is required/,
    'without a host approval control delivery nothing can be promoted',
  );
});

test('#5216 an approval control promotes exactly its bound match once', () => {
  let approved = 0;
  const { event } = approveThroughControl(result, { actorId: 'actor-a', onApproved: () => { approved++; } });
  assert.equal(event.isTrusted, true, 'the harness delivered a browser-trusted gesture');
  assert.equal(approved, 1, 'the creator continuation ran once');
  const fact = promoteKnowledgeSuggestion(result, { actorId: 'actor-a' });
  assert.equal(fact.authority, 'L4-local-canonical');
  assert.equal(fact.confirmation, 'user-confirmed');
  assert.equal(fact.provenance.actorId, 'actor-a', 'L4 actor must come from the minted approval record');
  assert.equal(fact.provenance.approvedMatchId, result.id);
  assert.equal(fact.provenance.approvalGesture, 'click');
  // Single-use: a second promotion has no approval record to consume.
  assert.throws(() => promoteKnowledgeSuggestion(result, { actorId: 'actor-a' }), /approval is required/);
});

test('#5216 a trusted click observed on another UI cannot issue for an attacker-chosen result (review R5)', () => {
  // The exact R5 counterexample: an arbitrary in-page caller renders its own
  // approval control for a result the user never approved and tries to
  // launder a trusted click that happened elsewhere (navigation, another
  // panel, any unrelated button).
  const attackerResult = uniqueResult({ sourceEntityId: 'fn:attacker', packageEntryId: 'pkg:attacker' });
  let attackerApproved = 0;
  const attackerSurface = new globalThis.HarnessEventTarget();
  const control = createRecognitionApprovalControl(attackerResult, { actorId: 'attacker', onApproved: () => { attackerApproved++; } });
  control.attach(attackerSurface);

  // (1) Live laundering: the attacker listens on some other surface and
  // forwards the trusted event object to their control during that other
  // dispatch. The platform delivered it to the OTHER surface, so the
  // captured currentTarget getter reports that other target, not the
  // attacker's approval surface.
  const otherSurface = new globalThis.HarnessEventTarget();
  otherSurface.addEventListener('click', (stolen) => control.handleEvent(stolen));
  otherSurface.dispatchEvent(new globalThis.Event('click', { trusted: true }));
  assert.equal(attackerApproved, 0, 'a trusted click delivered to another surface must not issue');

  // (2) Post-dispatch replay: the event object survives the dispatch, but
  // currentTarget is null outside delivery.
  const replayed = fireTrustedApprovalGesture(otherSurface, 'click');
  assert.equal(replayed.isTrusted, true, 'the stolen event was genuinely trusted on the other surface');
  control.handleEvent(replayed);
  assert.equal(attackerApproved, 0, 'a replayed trusted event from another UI must not issue');

  // (3) Attaching the control to an unrelated surface after binding is
  // refused, and synthetic/untrusted deliveries are ignored.
  assert.throws(() => control.attach(new globalThis.HarnessEventTarget()), /already bound/);
  attackerSurface.addEventListener('click', control.handleEvent);
  attackerSurface.dispatchEvent(syntheticEvent('click'));
  assert.equal(attackerApproved, 0, 'synthetic (untrusted) events never issue');
  // The user actually activating the rendered approval surface is the only
  // path — and it promotes exactly the rendered match, once.
  fireTrustedApprovalGesture(attackerSurface, 'click');
  assert.equal(attackerApproved, 1);
  const fact = promoteKnowledgeSuggestion(attackerResult, { actorId: 'attacker' });
  assert.equal(fact.provenance.approvedMatchId, attackerResult.id);
  assert.throws(() => promoteKnowledgeSuggestion(attackerResult, { actorId: 'attacker' }), /approval is required/, 'single-use');
});

test('#5216 non-approval gestures and forged event shapes never issue', () => {
  let approved = 0;
  const surface = new globalThis.HarnessEventTarget();
  const control = createRecognitionApprovalControl(uniqueResult(), { actorId: 'actor-a', onApproved: () => { approved++; } });
  control.attach(surface);
  surface.addEventListener('click', control.handleEvent);
  // Indirect event type (not a direct approval gesture).
  surface.addEventListener('load', control.handleEvent);
  fireTrustedApprovalGesture(surface, 'load');
  assert.equal(approved, 0);
  // Own-property isTrusted shadow on a real event, delivered to the surface.
  const shadowed = syntheticEvent('click');
  Object.defineProperty(shadowed, 'isTrusted', { value: true });
  surface.dispatchEvent(shadowed);
  assert.equal(approved, 0, 'an own isTrusted shadow cannot forge user activation');
  // Caller-built plain object claiming to be a trusted click.
  surface.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(approved, 0, 'a plain caller-built object is not a platform Event');
  // Unbound control (attach refused) never issues.
  const loose = createRecognitionApprovalControl(uniqueResult(), { actorId: 'actor-a', onApproved: () => { approved++; } });
  const otherSurface = new globalThis.HarnessEventTarget();
  otherSurface.addEventListener('click', loose.handleEvent);
  fireTrustedApprovalGesture(otherSurface, 'click');
  assert.equal(approved, 0, 'a control not bound to the delivery surface must not issue');
});

test('#5216 approval controls refuse invalid construction', () => {
  assert.throws(() => createRecognitionApprovalControl(null, { actorId: 'a', onApproved: () => {} }), /suggestion required/);
  assert.throws(() => createRecognitionApprovalControl(result, { onApproved: () => {} }), /actor identity is required/);
  assert.throws(() => createRecognitionApprovalControl(result, { actorId: 'a' }), /onApproved continuation is required/);
  assert.throws(
    () => createRecognitionApprovalControl(uniqueResult({ candidateSearchTruncated: true }), { actorId: 'a', onApproved: () => {} }),
    /ambiguous or truncated/,
  );
  const ambiguous = createMatchResult({
    sourceEntityId: 'fn:3000', packageEntryId: 'pkg:a',
    candidates: [
      { packageEntryId: 'pkg:a', score: 0.94 },
      { packageEntryId: 'pkg:b', score: 0.93 },
    ],
  });
  assert.throws(() => createRecognitionApprovalControl(ambiguous, { actorId: 'a', onApproved: () => {} }), /ambiguous or truncated/);
  assert.throws(() => promoteKnowledgeSuggestion(ambiguous, { actorId: 'a' }), /ambiguous or truncated/, 'ambiguous promotion stays forbidden');
  assert.throws(() => promoteKnowledgeSuggestion(uniqueResult({ candidateSearchTruncated: true }), { actorId: 'a' }), /ambiguous or truncated/);
});

test('#5216 grants stay bound to match identity, actor and package content', () => {
  const other = uniqueResult({ sourceEntityId: 'fn:2000', packageEntryId: 'pkg:other' });
  const changedHash = uniqueResult({ packageContentHash: 'hash-b' });
  approveThroughControl(result, { actorId: 'actor-a' });
  assert.throws(
    () => promoteKnowledgeSuggestion(other, { actorId: 'actor-a' }),
    /approval is required/,
    'another match has no approval record of its own',
  );
  assert.throws(
    () => promoteKnowledgeSuggestion(changedHash, { actorId: 'actor-a' }),
    /approval is required/,
  );
  // A control for the changed hash mints a record whose package content is
  // verified at consumption; a result claiming the same match id with
  // tampered content cannot consume it.
  approveThroughControl(changedHash, { actorId: 'actor-a' });
  const tampered = { ...changedHash, packageContentHash: 'hash-X' };
  assert.throws(
    () => promoteKnowledgeSuggestion(tampered, { actorId: 'actor-a' }),
    /different package content/,
    'the minted record is bound to the package content it was approved for',
  );
  assert.throws(
    () => promoteKnowledgeSuggestion(changedHash, { actorId: 'actor-b' }),
    /bound to a different actor/,
  );
  promoteKnowledgeSuggestion(changedHash, { actorId: 'actor-a' });
});

test('#5216 the host project binding is recorded and re-verified at consumption (review R4)', () => {
  const bindingMatch = uniqueResult({ sourceEntityId: 'fn:binding-a', packageEntryId: 'pkg:binding-a' });
  recognition.configureRecognitionApprovalHost({ projectBinding: 'project-A' });
  try {
    approveThroughControl(bindingMatch, { actorId: 'actor-a' });
    recognition.configureRecognitionApprovalHost({ projectBinding: 'project-B' });
    assert.throws(
      () => promoteKnowledgeSuggestion(bindingMatch, { actorId: 'actor-a' }),
      /bound to a different project binding/,
      'a record minted under one binding cannot be spent after the host re-binds',
    );
    approveThroughControl(bindingMatch, { actorId: 'actor-a' });
    const fact = promoteKnowledgeSuggestion(bindingMatch, { actorId: 'actor-a' });
    assert.equal(fact.confirmation, 'user-confirmed');
  } finally {
    recognition.configureRecognitionApprovalHost({ projectBinding: null });
  }
});

test('#5216 an unbound approval cannot be spent once the host carries a binding', () => {
  const unboundMatch = uniqueResult({ sourceEntityId: 'fn:binding-b', packageEntryId: 'pkg:binding-b' });
  approveThroughControl(unboundMatch, { actorId: 'actor-a' });
  recognition.configureRecognitionApprovalHost({ projectBinding: 'project-A' });
  try {
    assert.throws(
      () => promoteKnowledgeSuggestion(unboundMatch, { actorId: 'actor-a' }),
      /bound to a different project binding/,
      'an unbound record cannot be spent under any binding',
    );
  } finally {
    recognition.configureRecognitionApprovalHost({ projectBinding: null });
  }
});
