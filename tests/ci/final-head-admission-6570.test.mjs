import assert from 'node:assert/strict';
import {
  FINAL_HEAD_ADMISSION_CONTEXT,
  FINAL_HEAD_ADMISSION_CHECK_NAME,
  evaluateFinalHeadAdmission,
  latestStatuses,
} from '../../tools/validation/final-head-admission.mjs';

const HEAD = '1340a18dd3f13b9a54f3e75b763cfbd8743202e7';
const OLD = '8ee3431a41c3c836b1979eeac6a033c67e4c1eb1';
const auto = (sha, verdict = 'APPROVED') => ({
  state: 'COMMENTED',
  commit_id: sha,
  body: `[AUTO-REVIEW:R0][HEAD:${sha}][VERDICT:${verdict}]`,
});
const status = (context, state, at = '2026-09-07T00:00:00Z') => ({ context, state, updated_at: at });
const check = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion, app: { slug: 'github-actions' } });
const greenEvidence = () => ({
  statuses: [
    status('ci/circleci: phase7-ownership', 'success'),
    status('ci/circleci: migration-guardrails', 'success'),
    status('CodeRabbit', 'success'),
  ],
  checkRuns: [check('PR fast gate')],
});

// Reproduces the #6570 landing class: approval was for an older head and the
// final head carried a red ownership status. Both facts must be visible.
{
  const result = evaluateFinalHeadAdmission({
    headSha: HEAD,
    reviews: [auto(OLD)],
    statuses: [
      status('ci/circleci: phase7-ownership', 'failure'),
      status('ci/circleci: migration-guardrails', 'success'),
      status('CodeRabbit', 'success'),
    ],
    checkRuns: [check('PR fast gate')],
  });
  assert.equal(result.state, 'failure');
  assert.ok(result.pending.includes('missing exact-head AUTO approval'));
  assert.ok(result.blockers.includes('CI status failed: ci/circleci: phase7-ownership'));
}

// A completely green final head is still not admissible until AUTO approval is
// explicitly bound to that exact SHA.
{
  const result = evaluateFinalHeadAdmission({ headSha: HEAD, reviews: [auto(OLD)], ...greenEvidence() });
  assert.equal(result.state, 'pending');
  assert.ok(result.pending.includes('missing exact-head AUTO approval'));
}

// Exact-head approval + CodeRabbit + CI + resolved review threads is admitted.
{
  const result = evaluateFinalHeadAdmission({
    headSha: HEAD,
    reviews: [auto(HEAD)],
    unresolvedReviewThreads: 0,
    ...greenEvidence(),
  });
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 1);
}

// Review blockers remain blockers even if every check is green.
{
  const unresolved = evaluateFinalHeadAdmission({
    headSha: HEAD,
    reviews: [auto(HEAD)],
    unresolvedReviewThreads: 2,
    ...greenEvidence(),
  });
  assert.equal(unresolved.state, 'failure');
  assert.ok(unresolved.blockers.some((reason) => reason.includes('unresolved review thread')));

  const requested = evaluateFinalHeadAdmission({
    headSha: HEAD,
    reviews: [auto(HEAD), { state: 'CHANGES_REQUESTED', commit_id: OLD, body: 'blocking review' }],
    ...greenEvidence(),
  });
  assert.equal(requested.state, 'failure');
  assert.ok(requested.blockers.includes('active GitHub changes-requested review'));
}

// In-flight CI stays pending rather than being misclassified as a pass/fail.
{
  const result = evaluateFinalHeadAdmission({
    headSha: HEAD,
    reviews: [auto(HEAD)],
    statuses: [status('CodeRabbit', 'success'), status('ci/circleci: phase7-ownership', 'pending')],
  });
  assert.equal(result.state, 'pending');
  assert.ok(result.pending.includes('CI status pending: ci/circleci: phase7-ownership'));
}

// The admission controller must ignore its own commit status/check to avoid a
// recursive self-dependency, while retaining the latest external status only.
{
  const latest = latestStatuses([
    status('ci/circleci: phase7-ownership', 'failure', '2026-09-07T00:00:00Z'),
    status('ci/circleci: phase7-ownership', 'success', '2026-09-07T00:01:00Z'),
  ]);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].state, 'success');

  const result = evaluateFinalHeadAdmission({
    headSha: HEAD,
    reviews: [auto(HEAD)],
    statuses: [
      status(FINAL_HEAD_ADMISSION_CONTEXT, 'pending'),
      status('CodeRabbit', 'success'),
      status('ci/circleci: phase7-ownership', 'success'),
    ],
    checkRuns: [check(FINAL_HEAD_ADMISSION_CHECK_NAME, 'failure')],
  });
  assert.equal(result.state, 'success');
}

assert.throws(
  () => evaluateFinalHeadAdmission({ headSha: 'not-a-sha' }),
  /final-head-admission-invalid-head-sha/,
);

console.log('final-head admission #6570 regression: PASS');
