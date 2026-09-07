import assert from 'node:assert/strict';

import { evaluateFinalHeadAdmission } from '../../tools/validation/final-head-admission.mjs';

const HEAD = '1340a18dd3f13b9a54f3e75b763cfbd8743202e7';
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

console.log('final-head admission AUTO reviewer identity regression: PASS');
