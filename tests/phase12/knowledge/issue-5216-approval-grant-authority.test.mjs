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

// Mint an approval for `match` through the only legitimate path: a
// platform-trusted gesture delivered to the module-minted approval surface.
function approveThroughControl(match, { actorId = 'actor-a', onApproved = () => {} } = {}) {
  const control = createRecognitionApprovalControl(match, { actorId, onApproved });
  const event = fireTrustedApprovalGesture(control.surface, 'click');
  return { control, surface: control.surface, event };
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
  const control = createRecognitionApprovalControl(result, { actorId: 'actor-a', onApproved: () => { approved++; } });
  // The surface is module-minted; the host UI mounts it. The trusted-runner
  // delivery helper models the UA activating the rendered button.
  const surface = control.surface;
  assert.equal(typeof surface.addEventListener, 'function');
  const event = fireTrustedApprovalGesture(surface, 'click');
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

test('#5216 a trusted click on an unrelated real surface cannot promote an attacker-chosen result (review R2 round 2)', () => {
  // The exact R2-round-2 counterexample: the importer creates a control for
  // a result the user never approved and tries to transplant the approval
  // delivery onto an existing, legitimate, already-trusted element (a
  // navigation button) that the user clicks normally.
  const attackerResult = uniqueResult({ sourceEntityId: 'fn:attacker', packageEntryId: 'pkg:attacker' });
  let attackerApproved = 0;
  const control = createRecognitionApprovalControl(attackerResult, { actorId: 'attacker', onApproved: () => { attackerApproved++; } });
  assert.equal(control.attach, undefined, 'no attach(): the delivery surface cannot be caller-chosen');
  assert.equal(control.handleEvent, undefined, 'the delivery handler is not exported');

  // The attacker adds their own listener to a legitimate navigation button
  // and forwards whatever it receives (the old seam is gone — this is the
  // only forwarding an importer can do).
  const navigationButton = new globalThis.HarnessEventTarget();
  navigationButton.addEventListener('click', (event) => { void event; });
  // The user genuinely clicks the navigation button: trusted on that
  // surface — but the module-minted approval surface never received a
  // platform delivery, so nothing mints.
  const stolen = fireTrustedApprovalGesture(navigationButton, 'click');
  assert.equal(stolen.isTrusted, true);
  assert.equal(attackerApproved, 0, 'a trusted click on an unrelated element must not mint');

  // The attacker cannot trigger the module's delivery handler directly: it
  // is not exported, and a script-dispatched event on the module-minted
  // surface is untrusted by the platform.
  attackerApproved = 0;
  control.surface.dispatchEvent(new globalThis.Event('click', { trusted: true }));
  assert.equal(attackerApproved, 0, 'script dispatch can never mint (isTrusted false via the platform)');
  control.surface.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(attackerApproved, 0, 'a plain caller-built object is not a platform Event');
  control.surface.dispatchEvent(syntheticEvent('click'));
  assert.equal(attackerApproved, 0, 'synthetic (untrusted) events never mint');
  const shadowed = syntheticEvent('click');
  Object.defineProperty(shadowed, 'isTrusted', { value: true });
  control.surface.dispatchEvent(shadowed);
  assert.equal(attackerApproved, 0, 'an own isTrusted shadow cannot forge user activation');

  // The surface property is getter-only on the frozen control: the attacker
  // cannot swap the module-minted surface for their own element.
  assert.throws(() => { control.surface = new globalThis.HarnessEventTarget(); }, TypeError);
});

test('#5216 synthetic, forged and misdirected deliveries never mint', () => {
  let approved = 0;
  const control = createRecognitionApprovalControl(uniqueResult(), { actorId: 'actor-a', onApproved: () => { approved++; } });
  const surface = control.surface;
  // Synthetic platform event (script dispatch) on the real approval surface.
  surface.dispatchEvent(syntheticEvent('click'));
  assert.equal(approved, 0, 'synthetic (untrusted) events never issue');
  // Own-property isTrusted shadow on a real event, delivered to the surface.
  const shadowed = syntheticEvent('click');
  Object.defineProperty(shadowed, 'isTrusted', { value: true });
  surface.dispatchEvent(shadowed);
  assert.equal(approved, 0, 'an own isTrusted shadow cannot forge user activation');
  // Caller-built plain object claiming to be a trusted click.
  surface.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(approved, 0, 'a plain caller-built object is not a platform Event');
  // Indirect gesture type delivered by the platform.
  fireTrustedApprovalGesture(surface, 'load');
  assert.equal(approved, 0, 'indirect event types are not approval gestures');
  // A trusted gesture delivered to a DIFFERENT module-minted surface never
  // mints this control (per-control surface binding).
  const other = createRecognitionApprovalControl(uniqueResult({ sourceEntityId: 'fn:other', packageEntryId: 'pkg:other' }), { actorId: 'actor-a', onApproved: () => {} });
  fireTrustedApprovalGesture(other.surface, 'click');
  assert.equal(approved, 0, 'another control\'s surface delivery does not mint this match');
  // Released controls never mint.
  const released = createRecognitionApprovalControl(uniqueResult({ sourceEntityId: 'fn:rel', packageEntryId: 'pkg:rel' }), { actorId: 'actor-a', onApproved: () => { approved++; } });
  released.release();
  fireTrustedApprovalGesture(released.surface, 'click');
  assert.equal(approved, 0, 'a released control must not mint');
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
