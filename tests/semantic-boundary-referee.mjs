import assert from 'node:assert/strict';
import fs from 'node:fs';
import { autoAnalyze } from '../js/auto.js';
import {
  SEMANTIC_BOUNDARY_GOAL_GUIDANCE,
  normalizeSemanticBoundaryAdmissionPolicy,
  normalizeSemanticBoundaryAmbiguityPolicy,
  semanticBoundaryGoalGuidance,
} from '../js/semantic-boundary-referee.js';
import {
  HOLDOUT_ADMISSION_POLICY,
  HOLDOUT_AMBIGUITY_POLICY,
  TRUE_OFFSET,
  acceptedChoice,
  acceptedNoul,
  runSyntheticBoundaryCase,
  syntheticShapeFixture,
} from './fixtures/semantic-boundary-holdout.mjs';

const HOLDOUT_MANIFEST = JSON.parse(fs.readFileSync(
  new URL('./fixtures/openmw-boundary-holdout.manifest.json', import.meta.url),
  'utf8',
));

function resultSignature(run) {
  return {
    top: run.result.top?.offset?.toString() || null,
    verdict: run.result.verdict,
    probability: run.result.top?.fusion?.probability ?? null,
    candidates: run.result.candidates.map((candidate) => ({
      offset: candidate.offset?.toString() || null,
      probability: candidate.fusion?.probability ?? null,
      evidence: (candidate.evidence || []).map((item) => item.code),
      proof: (candidate.proof || []).map((proof) => ({ fn: proof.fn?.toString() || null, work: proof.change?.work || null })),
    })),
  };
}

function candidateSignature(run, offsets) {
  const wanted = new Set(offsets.map((offset) => BigInt(offset).toString()));
  return run.result.candidates.filter((candidate) => wanted.has(candidate.offset?.toString())).map((candidate) => ({
    offset: candidate.offset.toString(),
    probability: candidate.fusion?.probability ?? null,
    evidence: (candidate.evidence || []).map((item) => item.code),
    proof: (candidate.proof || []).map((proof) => ({ fn: proof.fn?.toString() || null, work: proof.change?.work || null })),
  }));
}

const baseline = await runSyntheticBoundaryCase();
const baselineSignature = resultSignature(baseline);
assert.equal(baseline.result.top?.offset, 0x50n, 'fixture must expose the labelled D5 miss behind deterministic D4');
assert.equal(baseline.trace.candidateCount, 5);
assert.deepEqual(baseline.trace.verificationTargets, ['d1', 'd2', 'd3', 'd4']);

// 15. Removing every boundary option/callback leaves the existing verifier's
// result and analysis envelope unchanged.
{
  const legacy = await runSyntheticBoundaryCase({ legacyPath: true });
  assert.deepEqual(resultSignature(legacy), baselineSignature);
  assert.equal(legacy.analyzeCalls, baseline.analyzeCalls);
  assert.equal(legacy.trace, null);
}

// 1. Candidate counts at or below the ordinary verify limit never contact a referee.
{
  let calls = 0;
  const run = await runSyntheticBoundaryCase({ count: 4, referee: async () => { calls++; return acceptedChoice(); } });
  assert.equal(calls, 0);
  assert.equal(run.trace.eligibility, 'candidate-count');
}

// 2. A clear D4/D5 boundary remains fully deterministic.
{
  let calls = 0;
  const run = await runSyntheticBoundaryCase({ clearBoundary: true, referee: async () => { calls++; return acceptedChoice(); } });
  assert.equal(calls, 0);
  assert.equal(run.trace.eligibility, 'clear-boundary');
}

// 3. The actual background auto loop does not propagate the injected referee.
{
  let calls = 0;
  const { shapes } = syntheticShapeFixture();
  await autoAnalyze({
    strings: [], program: null, symbols: null, fields: null, shapes,
    analyze: async () => null,
    semanticBoundaryReferee: async () => { calls++; return acceptedChoice(); },
    pinpointBudget: 1,
  });
  assert.equal(calls, 0, 'background auto must make zero semantic-rank calls');
}

// 4. Incomplete or capped shape scans cannot leave the browser.
for (const options of [{ complete: false }, { capped: true }]) {
  let calls = 0;
  const run = await runSyntheticBoundaryCase({ ...options, referee: async () => { calls++; return acceptedChoice(); } });
  assert.equal(calls, 0);
  assert.equal(run.trace.eligibility, 'scan-incomplete');
}

// 4b. A goal without calibrated guidance never reaches the network, even when
// the deterministic boundary looks ambiguous: the question would be ill-posed
// and its answer would have no measured basis.  Adding a labelled holdout case
// is what makes a goal eligible again.
for (const goalId of ['money', 'score', 'level', 'item', 'attack', 'damage']) {
  let calls = 0;
  const run = await runSyntheticBoundaryCase({ goalId, referee: async () => { calls++; return acceptedChoice('c1'); } });
  assert.equal(calls, 0, `${goalId} must not contact a referee`);
  if (run.trace) assert.equal(run.trace.eligibility, 'uncalibrated-goal', `${goalId} rejection reason`);
}
// `level`/`item` are the sharp case: their candidate list is byte-for-byte the
// same five resources as `hp`, so the boundary question would be ill-posed.
for (const goalId of ['level', 'item']) {
  const run = await runSyntheticBoundaryCase({ goalId, referee: async () => acceptedChoice('c1') });
  assert.ok(run.trace, `${goalId} must reach the boundary planning stage`);
  assert.equal(run.trace.candidateCount, 5);
  assert.equal(run.trace.eligibility, 'uncalibrated-goal');
}
for (const goalId of ['hp', 'stamina']) {
  let calls = 0;
  const run = await runSyntheticBoundaryCase({ goalId, referee: async () => { calls++; return acceptedChoice('c1'); } });
  assert.equal(calls, 1, `${goalId} is calibrated and may ask`);
  assert.equal(run.trace.eligibility, 'eligible');
}

// Cancellation is also a hard no-egress condition.
{
  let calls = 0;
  const run = await runSyntheticBoundaryCase({ cancelled: true, referee: async () => { calls++; return acceptedChoice(); } });
  assert.equal(calls, 0);
  assert.equal(run.trace.eligibility, 'cancelled');
}

// 5. Abstention preserves the ordinary D1..D4 result exactly.
{
  const run = await runSyntheticBoundaryCase({
    referee: async () => ({
      model: 'openjev', method: 'choice', challengerId: null,
      probabilities: { c0: 0.05, c1: 0.05, none: 0.9 }, abstain: true,
    }),
  });
  assert.deepEqual(resultSignature(run), baselineSignature);
  assert.deepEqual(run.trace.verificationTargets, ['d1', 'd2', 'd3', 'd4']);
  assert.equal(run.trace.referee.status, 'abstain');
}

// 6. A malformed-in-context recommendation of D4 gets no extra probe.
{
  const run = await runSyntheticBoundaryCase({ mode: 'probe', referee: async () => acceptedChoice('c0') });
  assert.deepEqual(resultSignature(run), baselineSignature);
  assert.equal(run.trace.probe.attempted, false);
  assert.equal(run.trace.referee.status, 'challenger-not-tail');
}

// 7 and 9. An admitted D5 challenger receives exactly one preliminary probe;
// D1..D3 retain their ordinary verification positions unchanged.
const gated = await runSyntheticBoundaryCase({ mode: 'probe', referee: async () => acceptedChoice('c1') });
assert.equal(gated.trace.probe.analyzeCalls, 1, 'one-probe means one analyzer call before normal verification');
assert.equal(gated.trace.probe.success, true);
assert.deepEqual(gated.trace.verificationTargets, ['d1', 'd2', 'd3', 'd5']);
assert.deepEqual(candidateSignature(gated, [0x20n, 0x30n, 0x40n]), candidateSignature(baseline, [0x20n, 0x30n, 0x40n]));
assert.equal(gated.analyzeCalls, baseline.analyzeCalls + 1, 'the gated path adds at most its single bounded probe');
assert.equal(gated.result.top?.offset, TRUE_OFFSET, 'binary-grounded probe may rescue the labelled D5 candidate');

// 8. A failed probe mutates neither verification selection nor result, and it
// stays inside the reserved window cap.
{
  const failed = await runSyntheticBoundaryCase({ mode: 'probe', probeFails: true, referee: async () => acceptedChoice('c1') });
  assert.deepEqual(resultSignature(failed), baselineSignature);
  assert.deepEqual(failed.trace.verificationTargets, ['d1', 'd2', 'd3', 'd4']);
  assert.ok(failed.trace.probe.analyzeCalls >= 1 && failed.trace.probe.analyzeCalls <= 3);
  assert.equal(failed.trace.probe.success, false);
  assert.equal(failed.trace.probe.status, 'change-not-reconfirmed');
  assert.ok(failed.analyzeCalls <= baseline.analyzeCalls + 3, 'a failed probe cannot exceed the reserved window cap');
}

// 8a. One unhelpful window must not end the probe: a later scanned site that
// does reconfirm the write settles the probe after exactly one bounded retry.
{
  const retried = await runSyntheticBoundaryCase({
    mode: 'probe',
    probeBarrenSites: 1,
    referee: async () => acceptedChoice('c1'),
  });
  assert.equal(retried.trace.probe.success, true);
  assert.equal(retried.trace.probe.status, 'reconfirmed');
  assert.equal(retried.trace.probe.analyzeCalls, 2, 'the probe retried exactly one unhelpful site');
  assert.equal(retried.trace.probe.candidateId, 'd5');
  assert.deepEqual(retried.trace.verificationTargets, ['d1', 'd2', 'd3', 'd5']);
  assert.equal(retried.result.top?.offset, TRUE_OFFSET, 'a probe that needed a retry still settles the labelled D5 candidate');
  assert.ok(retried.analyzeCalls > gated.analyzeCalls, 'the retry costs exactly the extra window it opened');
}

// 8b. The retry is bounded: when every scanned site is unhelpful the probe
// gives up after at most VERIFY_FUNCTIONS windows and the result is the exact
// deterministic baseline.
{
  const bounded = await runSyntheticBoundaryCase({
    mode: 'probe',
    probeBarrenSites: 9,
    referee: async () => acceptedChoice('c1'),
  });
  assert.equal(bounded.trace.probe.success, false);
  assert.ok(bounded.trace.probe.analyzeCalls <= 3, 'probe windows are capped at VERIFY_FUNCTIONS');
  assert.deepEqual(resultSignature(bounded), baselineSignature);
  assert.deepEqual(bounded.trace.verificationTargets, ['d1', 'd2', 'd3', 'd4']);
}

// 10. A very confident semantic preference in shadow mode cannot add evidence,
// proof, confidence, or a stronger verdict by itself.
{
  const shadow = await runSyntheticBoundaryCase({ referee: async () => acceptedChoice('c1') });
  assert.deepEqual(resultSignature(shadow), baselineSignature);
  assert.equal(shadow.trace.referee.margin, 0.88);
  assert.equal(shadow.trace.mode, 'shadow');
  for (const candidate of shadow.result.candidates) {
    assert.equal((candidate.evidence || []).some((item) => /jev|semantic/i.test(item.code)), false);
  }
}

// A parallel noul response is also shadow-only and uses one callback/request.
{
  let calls = 0;
  const shadow = await runSyntheticBoundaryCase({ referee: async () => { calls++; return acceptedNoul('c1'); } });
  assert.equal(calls, 1);
  assert.equal(shadow.trace.referee.method, 'noul');
  assert.deepEqual(resultSignature(shadow), baselineSignature);
}

// 11. Every provider failure shape is fail-open to the deterministic result.
for (const referee of [
  async () => { throw new Error('timeout'); },
  async () => ({ model: 'wrong-model', method: 'choice', challengerId: 'c1', probabilities: { c0: 0.1, c1: 0.9, none: 0 }, abstain: false }),
  async () => ({ model: 'openjev', method: 'choice', challengerId: 'c7', probabilities: { c0: 0.1, c1: 0.9, none: 0 }, abstain: false }),
  async () => ({ model: 'openjev', method: 'choice', challengerId: 'c1', probabilities: { c0: 0.1, none: 0 }, abstain: false }),
  async () => ({ model: 'openjev', method: 'choice', challengerId: 'c1', probabilities: { c0: 0.9, c1: 0.9, none: 0 }, abstain: false }),
]) {
  const failed = await runSyntheticBoundaryCase({ mode: 'probe', referee });
  assert.deepEqual(resultSignature(failed), baselineSignature);
  assert.deepEqual(failed.trace.verificationTargets, ['d1', 'd2', 'd3', 'd4']);
  assert.equal(failed.trace.probe.attempted, false);
}

// The browser-visible callback packet is an explicit fact allow-list.  The
// internal offset/rank/score/role and source representations cannot escape it.
{
  let packet = null;
  await runSyntheticBoundaryCase({ referee: async (value) => { packet = value; return acceptedChoice('c1'); } });
  assert.ok(packet);
  assert.deepEqual(Object.keys(packet.goal).sort(), ['id', 'label']);
  assert.deepEqual(packet.candidates.map((candidate) => candidate.id), ['c0', 'c1']);
  for (const candidate of packet.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), [
      'clamped', 'completeness', 'crossObject', 'decreases', 'functionCount', 'id', 'identityKnown',
      'increases', 'loadCount', 'scaled', 'size', 'storeCount', 'usedAsAmount', 'usedCross', 'usedScaled',
    ]);
    const encoded = JSON.stringify(candidate);
    assert.equal(/address|offset|shapeScore|resourceScore|damageSourceScore|role|rank|pseudocode|assembly/i.test(encoded), false);
  }
}

// The model-facing prompt wording is calibrated, not intuition: every goal with
// guidance must name a holdout fixture that exists and actually labels that
// goal.  This is what stops an unvalidated prompt from being added silently.
{
  assert.equal(semanticBoundaryGoalGuidance('hp'), SEMANTIC_BOUNDARY_GOAL_GUIDANCE.hp.text);
  assert.equal(semanticBoundaryGoalGuidance('money'), '', 'uncalibrated goals keep the neutral wording');
  assert.equal(semanticBoundaryGoalGuidance('constructor'), '');
  assert.equal(semanticBoundaryGoalGuidance('toString'), '');
  assert.equal(semanticBoundaryGoalGuidance(null), '');
  const labelled = new Set(HOLDOUT_MANIFEST.cases.map((entry) => entry.goal));
  for (const [goalId, entry] of Object.entries(SEMANTIC_BOUNDARY_GOAL_GUIDANCE)) {
    assert.equal(typeof entry.text, 'string');
    assert.ok(entry.text.length > 0, `${goalId} guidance must not be empty`);
    assert.equal(entry.calibratedBy, 'openmw-boundary-holdout', `${goalId} guidance must cite the source-grounded holdout`);
    assert.equal(HOLDOUT_MANIFEST.kind, 'external-source-grounded-arm64-fixture');
    assert.ok(labelled.has(goalId), `${goalId} guidance has no labelled holdout case`);
  }
  // Measured ranks on the breadth-faithful fixture: the hp truth wins outright and
  // the stamina truth sits inside the ordinary verified set, so neither case puts a
  // labelled truth in the boundary set the referee can reach.  These used to be
  // 5 and 1 on a fixture that had the one surviving discriminator (update-site
  // breadth) inverted relative to the upstream source.
  const labelledRanks = new Map(HOLDOUT_MANIFEST.cases.map((entry) => [entry.goal, entry.expectedDeterministicRank]));
  assert.equal(labelledRanks.get('hp'), 1);
  assert.equal(labelledRanks.get('stamina'), 2);
  for (const entry of HOLDOUT_MANIFEST.cases) {
    // reachability is derived from rank, never asserted independently
    assert.equal(entry.boundaryTruthReachable, entry.expectedDeterministicRank >= 4, `${entry.goal} reachability must follow from its rank`);
    assert.equal(entry.oracleChallengerId, entry.boundaryTruthReachable ? `d${entry.expectedDeterministicRank}` : null, `${entry.goal} oracle target must follow from its rank`);
  }
}

// The frozen ambiguity/admission policies live in the labelled fixture, and the
// synthetic holdout must use exactly the same pair, so both harnesses measure
// one policy identity instead of two that happen to look alike.
{
  const ambiguity = normalizeSemanticBoundaryAmbiguityPolicy(HOLDOUT_MANIFEST.policies?.ambiguity);
  const admission = normalizeSemanticBoundaryAdmissionPolicy(HOLDOUT_MANIFEST.policies?.admission);
  assert.ok(ambiguity, 'the OpenMW fixture must freeze a valid ambiguity policy');
  assert.ok(admission, 'the OpenMW fixture must freeze a valid admission policy');
  assert.deepEqual(ambiguity, HOLDOUT_AMBIGUITY_POLICY);
  assert.deepEqual(admission, HOLDOUT_ADMISSION_POLICY);
  assert.equal(normalizeSemanticBoundaryAmbiguityPolicy({ schema: 'hex-semantic-boundary-ambiguity/v1' }), null);
  assert.equal(normalizeSemanticBoundaryAdmissionPolicy({ schema: 'hex-semantic-boundary-admission/v1', minProbability: 2 }), null);
}

process.stdout.write('  ok  semantic boundary referee remains shadow-first and binary-grounded\n');
