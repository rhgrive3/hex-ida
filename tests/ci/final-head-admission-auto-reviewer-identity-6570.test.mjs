import assert from 'node:assert/strict';
import fs from 'node:fs';

import { evaluateFinalHeadAdmission } from '../../tools/validation/final-head-admission.mjs';

const HEAD = '1340a18dd3f13b9a54f3e75b763cfbd8743202e7';
const OLD = '8ee3431a41c3c836b1979eeac6a033c67e4c1eb1';
const TRUSTED = 'rhgrive3';
const REQUIRED = 'ci/circleci: phase7-ownership';
const auto = (reviewerId, verdict, at) => ({
  state: 'COMMENTED',
  commit_id: HEAD,
  submitted_at: at,
  author: { login: TRUSTED },
  body: `[AUTO-REVIEW:${reviewerId}][HEAD:${HEAD}][VERDICT:${verdict}]`,
});
const greenEvidence = {
  statuses: [
    { context: REQUIRED, state: 'success', updated_at: '2026-09-07T00:03:00Z' },
    {
      context: 'CodeRabbit',
      state: 'success',
      description: 'Review completed',
      updated_at: '2026-09-07T00:03:00Z',
      creator: { login: 'coderabbitai[bot]' },
    },
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

// A green exact head must become blocking when a newly-created inline comment
// creates an unresolved review thread. The workflow-source assertions above pin
// the event that causes this evaluator path to be re-run.
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

// R0 and R1 are independent logical reviewers even when the same trusted
// GitHub account mints both markers. A later R0 approval cannot erase R1's
// still-active CHANGES_REQUESTED state.
{
  const result = evaluate([
    auto('R1', 'CHANGES_REQUESTED', '2026-09-07T00:00:00Z'),
    auto('R0', 'APPROVED', '2026-09-07T00:02:00Z'),
  ]);
  assert.equal(result.state, 'failure');
  assert.equal(result.evidence.exactAutoApprovalCount, 1);
  assert.equal(result.evidence.exactAutoChangesRequestedCount, 1);
  assert.ok(result.blockers.includes('exact-head AUTO review requests changes'));
}

// Only a newer verdict from the same logical AUTO reviewer supersedes its
// prior verdict.
{
  const result = evaluate([
    auto('R1', 'CHANGES_REQUESTED', '2026-09-07T00:00:00Z'),
    auto('R1', 'APPROVED', '2026-09-07T00:02:00Z'),
  ]);
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 1);
  assert.equal(result.evidence.exactAutoChangesRequestedCount, 0);
}

// The canonical marker is one inseparable authority tuple. An OLD marker on a
// current commit cannot be laundered into current-head approval by a stray
// marker-shaped HEAD token later in the review body.
{
  const review = auto('R1', 'APPROVED', '2026-09-07T00:02:00Z');
  review.body = `[AUTO-REVIEW:R1][HEAD:${OLD}][VERDICT:APPROVED]\n[HEAD:${HEAD}]`;
  const result = evaluate([review]);
  assert.equal(result.state, 'pending');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
  assert.ok(result.pending.includes('missing exact-head AUTO approval'));
}

// Partial, non-leading, or multiple AUTO markers are never assembled into
// approval authority from independently matching tokens.
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
    assert.equal(result.state, 'pending');
    assert.equal(result.evidence.exactAutoApprovalCount, 0);
    assert.ok(result.pending.includes('missing exact-head AUTO approval'));
  }
}

console.log('final-head admission AUTO reviewer identity regression: PASS');
