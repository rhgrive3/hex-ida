import assert from 'node:assert/strict';
import fs from 'node:fs';

import { evaluateFinalHeadAdmission } from '../../tools/validation/final-head-admission.mjs';

// Post-#9036 contract: AUTO-reviewer identity is diagnostic-only. Markers from
// any logical reviewer on any head stay advisory; admission is decided by
// formal review blockers plus exact-head CI evidence. These regressions pin
// that retirement: marker-shape laundering must stay impossible to *count*,
// and the diagnostic counter must always read zero.
const HEAD = '1340a18dd3f13b9a54f3e75b763cfbd8743202e7';
const OLD = '8ee3431a41c3c836b1979eeac6a033c67e4c1eb1';
const TRUSTED = 'rhgrive3';
const REQUIRED = 'ci/circleci: phase7-ownership';
const auto = (reviewerId, verdict, at, headSha = HEAD) => ({
  state: 'COMMENTED',
  commit_id: headSha,
  submitted_at: at,
  author: { login: TRUSTED },
  body: `[AUTO-REVIEW:${reviewerId}][HEAD:${headSha}][VERDICT:${verdict}]`,
});
const greenEvidence = {
  statuses: [
    { context: REQUIRED, state: 'success', updated_at: '2026-09-07T00:03:00Z' },
  ],
  checkRuns: [{ name: 'PR fast gate', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }],
};
const evaluate = (reviews) => evaluateFinalHeadAdmission({
  headSha: HEAD,
  reviews,
  trustedAutoReviewers: [TRUSTED],
  requiredStatusContexts: [REQUIRED],
  unresolvedReviewThreads: 0,
  ...greenEvidence,
});

const workflowSource = fs.readFileSync(
  new URL('../../.github/workflows/final-head-admission.yml', import.meta.url),
  'utf8',
);
assert.ok(
  workflowSource.includes('pull_request_review_comment:\n    types: [created, edited, deleted]'),
  'inline review-comment mutations must re-evaluate final-head admission',
);
assert.ok(
  workflowSource.includes("context.eventName === 'pull_request_review_comment'"),
  'review-comment payloads must resolve their pull request/current head',
);
assert.ok(
  workflowSource.includes('ref: ${{ github.event.repository.default_branch }}'),
  'the privileged controller must continue loading only default-branch evaluator code',
);
assert.ok(
  workflowSource.includes('persist-credentials: false'),
  'the privileged controller checkout must remain credential-free',
);

// A green exact head admits; unresolved review threads remain a retained
// formal blocker. The workflow-source assertions above pin the event that
// re-runs this evaluator path.
{
  const reviews = [auto('R1', 'APPROVED', '2026-09-07T00:02:00Z')];
  const before = evaluate(reviews);
  assert.equal(before.state, 'success');

  const after = evaluateFinalHeadAdmission({
    headSha: HEAD,
    reviews,
    trustedAutoReviewers: [TRUSTED],
    requiredStatusContexts: [REQUIRED],
    unresolvedReviewThreads: 1,
    ...greenEvidence,
  });
  assert.equal(after.state, 'failure');
  assert.ok(after.blockers.includes('1 unresolved review thread(s)'));
}

// R0/R1 marker identity is inert: a CHANGES_REQUESTED marker from one logical
// reviewer cannot block a green head, and the diagnostic AUTO counters stay
// at zero regardless of how many markers exist.
{
  const result = evaluate([
    auto('R1', 'CHANGES_REQUESTED', '2026-09-07T00:00:00Z'),
    auto('R0', 'APPROVED', '2026-09-07T00:02:00Z'),
  ]);
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
  assert.equal(result.evidence.exactAutoChangesRequestedCount, 0);
}

// A newer verdict from the same logical reviewer does not change admission
// either: green required CI alone decides, and counters stay diagnostic.
{
  const result = evaluate([
    auto('R1', 'CHANGES_REQUESTED', '2026-09-07T00:00:00Z'),
    auto('R1', 'APPROVED', '2026-09-07T00:02:00Z'),
  ]);
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
  assert.equal(result.evidence.exactAutoChangesRequestedCount, 0);
}

// The canonical marker is one inseparable authority tuple. Marker-shape
// laundering must remain structurally uncountable: an OLD marker plus a stray
// HEAD token never counts as current-head approval (the counter is pinned at
// zero for every marker shape, so no token assembly can mint authority).
{
  const review = auto('R1', 'APPROVED', '2026-09-07T00:02:00Z');
  review.body = `[AUTO-REVIEW:R1][HEAD:${OLD}][VERDICT:APPROVED]\n[HEAD:${HEAD}]`;
  const result = evaluate([review]);
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
}

// Partial, non-leading, or multiple AUTO markers are never assembled into
// approval authority from independently matching tokens; the diagnostic
// counter stays zero for every malformed shape.
{
  const malformedBodies = [
    `[AUTO-REVIEW:R1]\n[HEAD:${HEAD}][VERDICT:APPROVED]`,
    `review prose\n[AUTO-REVIEW:R1][HEAD:${HEAD}][VERDICT:APPROVED]`,
    `[AUTO-REVIEW:R1][HEAD:${HEAD}][VERDICT:APPROVED]\n[AUTO-REVIEW:R0][HEAD:${HEAD}][VERDICT:APPROVED]`,
  ];
  for (const body of malformedBodies) {
    const review = auto('R1', 'APPROVED', '2026-09-07T00:02:00Z');
    review.body = body;
    const result = evaluate([review]);
    assert.equal(result.state, 'success');
    assert.equal(result.evidence.exactAutoApprovalCount, 0);
  }
}

// An OLD-head approval marker must not mint current-head approval authority
// either; the marker itself stays inert and CI decides.
{
  const result = evaluate([auto('R1', 'APPROVED', '2026-09-07T00:02:00Z', OLD)]);
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
}

console.log('final-head admission AUTO reviewer identity regression: PASS');
