import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FINAL_HEAD_ADMISSION_CONTEXT,
  FINAL_HEAD_ADMISSION_CHECK_NAME,
  evaluateFinalHeadAdmission,
  latestReviewsByAuthor,
  latestStatuses,
} from '../../tools/validation/final-head-admission.mjs';

// Post-#9036 contract: campaign-only draft and exact-head AUTO-approval gates
// are retired. Admission follows ordinary PR safety signals — real GitHub
// review blockers plus exact-head CI evidence — while AUTO markers and
// external review providers stay advisory. These regressions pin that exact
// contract: retired gates stay retired, retained gates stay enforced.
const HEAD = '1340a18dd3f13b9a54f3e75b763cfbd8743202e7';
const OLD = '8ee3431a41c3c836b1979eeac6a033c67e4c1eb1';
const TRUSTED = 'rhgrive3';
const REQUIRED = [
  'ci/circleci: phase7-ownership',
  'ci/circleci: migration-guardrails',
];
const auto = (sha, verdict = 'APPROVED', author = TRUSTED, at = '2026-09-07T00:00:00Z') => ({
  state: 'COMMENTED',
  commit_id: sha,
  submitted_at: at,
  author: { login: author },
  body: `[AUTO-REVIEW:R0][HEAD:${sha}][VERDICT:${verdict}]`,
});
const formal = (state, author = 'reviewer-a', at = '2026-09-07T00:00:00Z') => ({
  state,
  submitted_at: at,
  author: { login: author },
  body: `formal ${state}`,
});
const status = (context, state, at = '2026-09-07T00:00:00Z') => ({ context, state, updated_at: at });
const codeRabbitStatus = (
  description = 'Review completed',
  state = 'success',
  at = '2026-09-07T00:00:00Z',
  creator = 'coderabbitai[bot]',
) => ({
  context: 'CodeRabbit',
  state,
  description,
  updated_at: at,
  creator: { login: creator },
});
const check = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion, app: { slug: 'github-actions' } });
const codeRabbitCheck = (conclusion = 'success', checkStatus = 'completed', appSlug = 'coderabbitai') => ({
  name: 'CodeRabbit',
  status: checkStatus,
  conclusion,
  app: { slug: appSlug },
});
const greenEvidence = () => ({
  statuses: [
    status('ci/circleci: phase7-ownership', 'success'),
    status('ci/circleci: migration-guardrails', 'success'),
  ],
  checkRuns: [check('PR fast gate')],
});
const evaluate = (input) => evaluateFinalHeadAdmission({
  trustedAutoReviewers: [TRUSTED],
  requiredStatusContexts: REQUIRED,
  ...input,
});

const workflowSource = fs.readFileSync(
  new URL('../../.github/workflows/final-head-admission.yml', import.meta.url),
  'utf8',
);
assert.match(
  workflowSource,
  /github\.paginate\(\s*github\.rest\.checks\.listForRef[\s\S]*filter: 'latest'/,
  'the privileged controller must paginate every check-run page',
);
assert.doesNotMatch(
  workflowSource,
  /const \{ data: checkData \} = await github\.rest\.checks\.listForRef/,
  'the privileged controller must not inspect only the first check-run page',
);

// Reproduces the #6570 landing class: the final head carried a red ownership
// status. That alone must fail admission regardless of any AUTO review
// evidence on older heads.
{
  const result = evaluate({
    headSha: HEAD,
    reviews: [auto(OLD)],
    statuses: [
      status('ci/circleci: phase7-ownership', 'failure'),
      status('ci/circleci: migration-guardrails', 'success'),
      codeRabbitStatus(),
    ],
    checkRuns: [check('PR fast gate')],
  });
  assert.equal(result.state, 'failure');
  assert.ok(result.blockers.includes('CI status failed: ci/circleci: phase7-ownership'));
  assert.ok(result.pending.every((reason) => !reason.includes('AUTO approval')));
}

// A completely green final head is admissible without AUTO approval: the
// exact-head AUTO gate was retired by #9036 and must not come back silently.
{
  const result = evaluate({ headSha: HEAD, reviews: [auto(OLD)], ...greenEvidence() });
  assert.equal(result.state, 'success');
  assert.ok(result.pending.every((reason) => !reason.includes('AUTO approval')));
  assert.ok(result.blockers.every((reason) => !reason.includes('AUTO review')));
}

// A forged marker from an untrusted PR participant carries no authority in
// either direction: it cannot admit, and it cannot block a green head.
{
  const result = evaluate({
    headSha: HEAD,
    reviews: [auto(HEAD, 'APPROVED', 'untrusted-contributor')],
    ...greenEvidence(),
  });
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
}

// A trusted exact-text marker without the review object's commit binding is
// inert evidence: green CI alone decides admission.
{
  const missingCommit = auto(HEAD);
  delete missingCommit.commit_id;
  const result = evaluate({
    headSha: HEAD,
    reviews: [missingCommit],
    ...greenEvidence(),
  });
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
}

// With no required-context configuration the evaluator fails safe as pending
// rather than silently admitting an underconfigured caller. The retired
// trusted-AUTO-reviewer check must stay retired.
{
  const result = evaluateFinalHeadAdmission({
    headSha: HEAD,
    reviews: [auto(HEAD)],
    ...greenEvidence(),
  });
  assert.equal(result.state, 'pending');
  assert.ok(result.pending.includes('no required CI status contexts configured'));
  assert.ok(result.pending.every((reason) => !reason.includes('trusted AUTO reviewer')));
}

// Complete required CI on the exact head is admitted without any AUTO review
// evidence at all; AUTO counters remain diagnostic-only at zero.
{
  const result = evaluate({
    headSha: HEAD,
    reviews: [],
    unresolvedReviewThreads: 0,
    ...greenEvidence(),
  });
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
  assert.equal(result.evidence.trustedAutoReviewerCount, 1);
  assert.equal(result.evidence.missingRequiredStatusCount, 0);
}

// External review is advisory: no provider status/check, pending/skipped,
// rate-limited, or failure evidence changes an otherwise admissible head.
{
  const cases = [
    { statuses: [], checkRuns: [] },
    { statuses: [codeRabbitStatus('Review pending', 'pending')], checkRuns: [] },
    { statuses: [codeRabbitStatus('Review skipped')], checkRuns: [] },
    { statuses: [codeRabbitStatus('Review rate limited')], checkRuns: [] },
    { statuses: [codeRabbitStatus('Review failed', 'failure')], checkRuns: [] },
    { statuses: [], checkRuns: [codeRabbitCheck('skipped')] },
    { statuses: [], checkRuns: [codeRabbitCheck('failure')] },
    { statuses: [], checkRuns: [codeRabbitCheck('success', 'in_progress')] },
    {
      statuses: [codeRabbitStatus('Review failed', 'failure')],
      checkRuns: [codeRabbitCheck('skipped')],
    },
  ];
  for (const { statuses, checkRuns } of cases) {
    const baseEvidence = greenEvidence();
    const result = evaluate({
      headSha: HEAD,
      reviews: [],
      ...baseEvidence,
      statuses: [...baseEvidence.statuses, ...statuses],
      checkRuns: [...baseEvidence.checkRuns, ...checkRuns],
    });
    assert.equal(result.state, 'success');
    assert.equal(result.pending.some((reason) => reason.includes('CodeRabbit')), false);
    assert.equal(result.blockers.some((reason) => reason.includes('CodeRabbit')), false);
  }

  // Provider success cannot grant anything on its own either: a red required
  // status still blocks even with a completed CodeRabbit review.
  const providerOnly = evaluate({
    headSha: HEAD,
    reviews: [],
    statuses: [
      status('ci/circleci: phase7-ownership', 'failure'),
      status('ci/circleci: migration-guardrails', 'success'),
      codeRabbitStatus('Review completed'),
    ],
    checkRuns: [check('PR fast gate')],
  });
  assert.equal(providerOnly.state, 'failure');
  assert.ok(providerOnly.blockers.includes('CI status failed: ci/circleci: phase7-ownership'));
  assert.equal(providerOnly.pending.some((reason) => reason.includes('CodeRabbit')), false);
}

// Provider check-runs are excluded from generic CI accounting, but required
// CI remains authoritative.
{
  for (const conclusion of ['neutral', 'skipped', 'failure']) {
    const baseEvidence = greenEvidence();
    const result = evaluate({
      headSha: HEAD,
      reviews: [],
      ...baseEvidence,
      checkRuns: [...baseEvidence.checkRuns, codeRabbitCheck(conclusion)],
    });
    assert.equal(result.state, 'success');
  }

  const completed = evaluate({
    headSha: HEAD,
    reviews: [],
    statuses: [
      status('ci/circleci: phase7-ownership', 'success'),
      status('ci/circleci: migration-guardrails', 'success'),
    ],
    checkRuns: [check('PR fast gate'), codeRabbitCheck('success')],
  });
  assert.equal(completed.state, 'success');

  const configuredAsRequired = evaluateFinalHeadAdmission({
    headSha: HEAD,
    reviews: [],
    statuses: [
      status('ci/circleci: phase7-ownership', 'success'),
      status('ci/circleci: migration-guardrails', 'success'),
      codeRabbitStatus('Review failed', 'failure'),
    ],
    checkRuns: [check('PR fast gate')],
    trustedAutoReviewers: [TRUSTED],
    requiredStatusContexts: [...REQUIRED, 'CodeRabbit'],
  });
  assert.equal(configuredAsRequired.state, 'success');
  assert.equal(configuredAsRequired.evidence.requiredStatusContextCount, REQUIRED.length);

  const genericNeutral = evaluate({
    headSha: HEAD,
    reviews: [],
    ...greenEvidence(),
    checkRuns: [check('PR fast gate'), check('optional-neutral', 'neutral')],
  });
  assert.equal(genericNeutral.state, 'success');
}

// Conflicting/ambiguous provider receipts remain advisory and cannot affect an
// otherwise complete admission.
{
  const at = '2026-09-07T00:05:00Z';
  const duplicateStatus = evaluate({
    headSha: HEAD,
    reviews: [],
    statuses: [
      status('ci/circleci: phase7-ownership', 'success'),
      status('ci/circleci: migration-guardrails', 'success'),
      codeRabbitStatus('Review completed', 'success', at),
      codeRabbitStatus('Review rate limited', 'success', at),
    ],
    checkRuns: [check('PR fast gate')],
  });
  assert.equal(duplicateStatus.state, 'success');

  const mixedEvidence = evaluate({
    headSha: HEAD,
    reviews: [],
    statuses: [
      status('ci/circleci: phase7-ownership', 'success'),
      status('ci/circleci: migration-guardrails', 'success'),
      codeRabbitStatus(),
    ],
    checkRuns: [check('PR fast gate'), codeRabbitCheck('neutral')],
  });
  assert.equal(mixedEvidence.state, 'success');
}

// Do not transiently succeed just because one required CI context appeared
// before the others were created for the final head.
{
  const result = evaluate({
    headSha: HEAD,
    reviews: [],
    statuses: [
      status('ci/circleci: phase7-ownership', 'success'),
      codeRabbitStatus(),
    ],
  });
  assert.equal(result.state, 'pending');
  assert.equal(result.evidence.missingRequiredStatusCount, 1);
  assert.ok(result.pending.includes('required CI status missing: ci/circleci: migration-guardrails'));
}

// Only the latest review from a reviewer is active. An older changes-requested
// review must not permanently poison a later approval.
{
  const reviews = [
    { state: 'CHANGES_REQUESTED', submitted_at: '2026-09-07T00:00:00Z', author: { login: 'reviewer-a' }, body: 'blocking review' },
    { state: 'APPROVED', submitted_at: '2026-09-07T00:01:00Z', author: { login: 'reviewer-a' }, body: 'fixed' },
  ];
  assert.equal(latestReviewsByAuthor(reviews).length, 1);
  const result = evaluate({ headSha: HEAD, reviews, ...greenEvidence() });
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoChangesRequestedCount, 0);
}

// Formal GitHub review state is a retained admission signal:
// a later comment cannot clear a still-active CHANGES_REQUESTED decision.
{
  const result = evaluate({
    headSha: HEAD,
    reviews: [
      formal('CHANGES_REQUESTED', 'reviewer-a', '2026-09-07T00:00:00Z'),
      formal('COMMENTED', 'reviewer-a', '2026-09-07T00:01:00Z'),
    ],
    ...greenEvidence(),
  });
  assert.equal(result.state, 'failure');
  assert.ok(result.blockers.includes('active GitHub changes-requested review'));
}

// A later formal APPROVED decision clears the same reviewer's earlier
// CHANGES_REQUESTED state, while the inverse ordering remains blocking.
{
  const cleared = evaluate({
    headSha: HEAD,
    reviews: [
      formal('CHANGES_REQUESTED', 'reviewer-a', '2026-09-07T00:00:00Z'),
      formal('APPROVED', 'reviewer-a', '2026-09-07T00:01:00Z'),
    ],
    ...greenEvidence(),
  });
  assert.equal(cleared.state, 'success');

  const blocked = evaluate({
    headSha: HEAD,
    reviews: [
      formal('APPROVED', 'reviewer-a', '2026-09-07T00:00:00Z'),
      formal('CHANGES_REQUESTED', 'reviewer-a', '2026-09-07T00:01:00Z'),
    ],
    ...greenEvidence(),
  });
  assert.equal(blocked.state, 'failure');
  assert.ok(blocked.blockers.includes('active GitHub changes-requested review'));
}

// A dismissal is an explicit formal clearing event. An unknown review state
// fails closed instead of being ignored as if it were a harmless comment.
{
  const dismissed = formal('DISMISSED', 'reviewer-a', '2026-09-07T00:00:00Z');
  dismissed.dismissed_at = '2026-09-07T00:02:00Z';
  const cleared = evaluate({
    headSha: HEAD,
    reviews: [
      formal('CHANGES_REQUESTED', 'reviewer-a', '2026-09-07T00:00:00Z'),
      dismissed,
    ],
    ...greenEvidence(),
  });
  assert.equal(cleared.state, 'success');

  const unknown = evaluate({
    headSha: HEAD,
    reviews: [
      formal('REVIEWED', 'reviewer-a', '2026-09-07T00:01:00Z'),
    ],
    ...greenEvidence(),
  });
  assert.equal(unknown.state, 'failure');
}

// The inverse ordering is blocking for formal reviews: a newer
// changes-requested review overrides an older approval from the same reviewer.
{
  const reviews = [
    { state: 'APPROVED', submitted_at: '2026-09-07T00:00:00Z', author: { login: 'reviewer-a' }, body: 'looks good' },
    { state: 'CHANGES_REQUESTED', submitted_at: '2026-09-07T00:01:00Z', author: { login: 'reviewer-a' }, body: 'blocking review' },
  ];
  const result = evaluate({ headSha: HEAD, reviews, ...greenEvidence() });
  assert.equal(result.state, 'failure');
  assert.ok(result.blockers.includes('active GitHub changes-requested review'));
}

// AUTO review markers carry no authority after #9036: even a trusted,
// exact-head CHANGES_REQUESTED marker must not block a green head.
{
  const reviews = [
    auto(HEAD, 'APPROVED', TRUSTED, '2026-09-07T00:00:00Z'),
    auto(HEAD, 'CHANGES_REQUESTED', TRUSTED, '2026-09-07T00:01:00Z'),
  ];
  const result = evaluate({ headSha: HEAD, reviews, ...greenEvidence() });
  assert.equal(result.state, 'success');
  assert.ok(result.blockers.every((reason) => !reason.includes('AUTO review')));
}

// Equal-newest conflicting CI statuses are all retained, so neither input
// order can hide a failure.
{
  const at = '2026-09-07T00:03:00Z';
  const conflicts = [
    [
      status('ci/circleci: phase7-ownership', 'success', at),
      status('ci/circleci: phase7-ownership', 'failure', at),
    ],
    [
      status('ci/circleci: phase7-ownership', 'failure', at),
      status('ci/circleci: phase7-ownership', 'success', at),
    ],
  ];
  for (const conflict of conflicts) {
    assert.equal(latestStatuses(conflict).length, 2);
    const result = evaluate({
      headSha: HEAD,
      reviews: [],
      statuses: [
        ...conflict,
        status('ci/circleci: migration-guardrails', 'success', at),
        codeRabbitStatus('Review completed', 'success', at),
      ],
      checkRuns: [check('PR fast gate')],
    });
    assert.equal(result.state, 'failure');
    assert.ok(result.blockers.includes('CI status failed: ci/circleci: phase7-ownership'));
  }
}

// Equal-newest conflicting AUTO verdicts are inert: they neither admit nor
// block, and latestReviewsByAuthor still deduplicates per author identity.
{
  const at = '2026-09-07T00:04:00Z';
  const conflicts = [
    [
      auto(HEAD, 'APPROVED', TRUSTED, at),
      auto(HEAD, 'CHANGES_REQUESTED', TRUSTED, at),
    ],
    [
      auto(HEAD, 'CHANGES_REQUESTED', TRUSTED, at),
      auto(HEAD, 'APPROVED', TRUSTED, at),
    ],
  ];
  for (const reviews of conflicts) {
    assert.equal(latestReviewsByAuthor(reviews).length, 2);
    const result = evaluate({
      headSha: HEAD,
      reviews,
      ...greenEvidence(),
    });
    assert.equal(result.state, 'success');
    assert.equal(result.evidence.exactAutoChangesRequestedCount, 0);
  }
}

// Review blockers remain blockers even if every check is green.
{
  const unresolved = evaluate({
    headSha: HEAD,
    reviews: [],
    unresolvedReviewThreads: 2,
    ...greenEvidence(),
  });
  assert.equal(unresolved.state, 'failure');
  assert.ok(unresolved.blockers.some((reason) => reason.includes('unresolved review thread')));

  const requested = evaluate({
    headSha: HEAD,
    reviews: [
      { state: 'CHANGES_REQUESTED', submitted_at: '2026-09-07T00:01:00Z', author: { login: 'reviewer-b' }, body: 'blocking review' },
    ],
    ...greenEvidence(),
  });
  assert.equal(requested.state, 'failure');
  assert.ok(requested.blockers.includes('active GitHub changes-requested review'));
}

// A failing additional check beyond the first API page must still block
// admission after workflow pagination.
{
  const lateChecks = [
    ...Array.from({ length: 100 }, (_, index) => check(`observed-check-${index}`)),
    check('late-failing-check', 'failure'),
  ];
  const result = evaluate({
    headSha: HEAD,
    reviews: [],
    ...greenEvidence(),
    checkRuns: [check('PR fast gate'), ...lateChecks],
  });
  assert.equal(result.state, 'failure');
  assert.ok(result.blockers.includes('CI check failed: late-failing-check'));
}

// In-flight CI stays pending rather than being misclassified as a pass/fail.
{
  const result = evaluate({
    headSha: HEAD,
    reviews: [],
    statuses: [
      codeRabbitStatus(),
      status('ci/circleci: phase7-ownership', 'pending'),
      status('ci/circleci: migration-guardrails', 'success'),
    ],
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

  const result = evaluate({
    headSha: HEAD,
    reviews: [],
    statuses: [
      status(FINAL_HEAD_ADMISSION_CONTEXT, 'pending'),
      codeRabbitStatus(),
      status('ci/circleci: phase7-ownership', 'success'),
      status('ci/circleci: migration-guardrails', 'success'),
    ],
    checkRuns: [check(FINAL_HEAD_ADMISSION_CHECK_NAME, 'failure')],
  });
  assert.equal(result.state, 'success');
}

// AUTO marker shapes (including BASE segments) must remain inert evidence:
// they can neither grant admission nor block a green head, in any verdict.
{
  const baseMarker = (sha, verdict = 'APPROVED') => ({
    state: 'COMMENTED',
    commit_id: sha,
    submitted_at: '2026-09-10T00:00:00Z',
    author: { login: TRUSTED },
    body: `[AUTO-REVIEW:R2][HEAD:${sha}][BASE:${sha.slice(0, 4)}${'a'.repeat(36)}][VERDICT:${verdict}]`,
  });
  const approved = evaluate({
    headSha: HEAD,
    reviews: [baseMarker(HEAD)],
    ...greenEvidence(),
  });
  assert.equal(approved.state, 'success', 'an APPROVED marker stays advisory on a green head');
  const rejected = evaluate({
    headSha: HEAD,
    reviews: [baseMarker(HEAD, 'CHANGES_REQUESTED')],
    ...greenEvidence(),
  });
  assert.equal(rejected.state, 'success', 'a BASE-segment CHANGES_REQUESTED marker cannot block a green head');
}

// Current-base marker binding was retired with the AUTO gate: stale bases,
// BASE-less legacy markers, and matching tuples are all advisory-only.
{
  const NEW_BASE = 'b'.repeat(40);
  const marker = (sha, verdict, base) => ({
    state: 'COMMENTED',
    commit_id: sha,
    submitted_at: '2026-09-10T00:00:00Z',
    author: { login: TRUSTED },
    body: base
      ? `[AUTO-REVIEW:R2][HEAD:${sha}][BASE:${base}][VERDICT:${verdict}]`
      : `[AUTO-REVIEW:R2][HEAD:${sha}][VERDICT:${verdict}]`,
  });
  const cases = [
    marker(HEAD, 'APPROVED', 'a'.repeat(40)),
    marker(HEAD, 'APPROVED', null),
    marker(HEAD, 'APPROVED', NEW_BASE),
    marker(HEAD, 'CHANGES_REQUESTED', NEW_BASE),
  ];
  for (const reviews of [cases]) {
    const result = evaluate({
      headSha: HEAD,
      reviews,
      ...greenEvidence(),
    });
    assert.equal(result.state, 'success', 'AUTO markers must not influence current-base admission');
    assert.equal(result.evidence.exactAutoApprovalCount, 0);
  }
}

assert.throws(
  () => evaluate({ headSha: 'not-a-sha' }),
  /final-head-admission-invalid-head-sha/,
);

console.log('final-head admission #6570/#7647 regressions: PASS');
