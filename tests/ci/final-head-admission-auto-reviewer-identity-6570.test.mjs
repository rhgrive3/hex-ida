import assert from 'node:assert/strict';
import fs from 'node:fs';

import { evaluateFinalHeadAdmission } from '../../tools/validation/final-head-admission.mjs';

const HEAD = '1340a18dd3f13b9a54f3e75b763cfbd8743202e7';
const OLD = '8ee3431a41c3c836b1979eeac6a033c67e4c1eb1';
const REQUIRED = 'ci/circleci: phase7-ownership';
const auto = (reviewerId, verdict, at, head = HEAD, author = 'rhgrive3') => ({
  state: 'COMMENTED',
  commit_id: head,
  submitted_at: at,
  author: { login: author },
  body: `[AUTO-REVIEW:${reviewerId}][HEAD:${head}][VERDICT:${verdict}]`,
});
const formal = (state, at, author = 'reviewer-a') => ({
  state,
  submitted_at: at,
  author: { login: author },
  body: `formal ${state}`,
});
const greenEvidence = {
  statuses: [{ context: REQUIRED, state: 'success', updated_at: '2026-09-07T00:03:00Z' }],
  checkRuns: [{ name: 'PR fast gate', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }],
};
const evaluate = (reviews, extra = {}) => evaluateFinalHeadAdmission({
  headSha: HEAD,
  reviews,
  requiredStatusContexts: [REQUIRED],
  unresolvedReviewThreads: 0,
  ...greenEvidence,
  ...extra,
});

const workflowSource = fs.readFileSync(
  new URL('../../.github/workflows/final-head-admission.yml', import.meta.url),
  'utf8',
);
assert.ok(
  workflowSource.includes('pull_request_review_comment:\n    types: [created, edited, deleted]'),
  'inline review-comment mutations must re-evaluate unresolved-thread state',
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

// AUTO markers are retained only as historical/commentary evidence. They no
// longer grant or revoke admission authority; ordinary GitHub review blockers
// plus exact-head CI are the authoritative policy.
{
  const noMarker = evaluate([]);
  const trustedApprove = evaluate([auto('R1', 'APPROVED', '2026-09-07T00:02:00Z')]);
  const trustedReject = evaluate([auto('R1', 'CHANGES_REQUESTED', '2026-09-07T00:02:00Z')]);
  const untrustedApprove = evaluate([auto('R1', 'APPROVED', '2026-09-07T00:02:00Z', HEAD, 'someone-else')]);
  const staleApprove = evaluate([auto('R1', 'APPROVED', '2026-09-07T00:02:00Z', OLD)]);

  for (const result of [noMarker, trustedApprove, trustedReject, untrustedApprove, staleApprove]) {
    assert.equal(result.state, 'success');
    assert.equal(result.evidence.exactAutoApprovalCount, 0);
    assert.equal(result.evidence.exactAutoChangesRequestedCount, 0);
  }
}

// Multiple logical AUTO reviewers likewise cannot manufacture a blocker or an
// approval. Marker ordering/identity is no longer part of admission authority.
{
  const result = evaluate([
    auto('R1', 'CHANGES_REQUESTED', '2026-09-07T00:00:00Z'),
    auto('R0', 'APPROVED', '2026-09-07T00:01:00Z'),
    auto('R1', 'APPROVED', '2026-09-07T00:02:00Z'),
  ]);
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
  assert.equal(result.evidence.exactAutoChangesRequestedCount, 0);
}

// Retiring AUTO authority must not weaken real GitHub review blockers.
{
  const blocked = evaluate([
    formal('CHANGES_REQUESTED', '2026-09-07T00:00:00Z'),
    auto('R1', 'APPROVED', '2026-09-07T00:01:00Z'),
  ]);
  assert.equal(blocked.state, 'failure');
  assert.ok(blocked.blockers.includes('active GitHub changes-requested review'));

  const cleared = evaluate([
    formal('CHANGES_REQUESTED', '2026-09-07T00:00:00Z'),
    formal('APPROVED', '2026-09-07T00:02:00Z'),
    auto('R1', 'CHANGES_REQUESTED', '2026-09-07T00:03:00Z'),
  ]);
  assert.equal(cleared.state, 'success');
}

// Reviewer trust configuration is now diagnostic-only. Omitting it must not
// create the retired "missing exact-head AUTO approval" pending state.
{
  const result = evaluateFinalHeadAdmission({
    headSha: HEAD,
    reviews: [],
    requiredStatusContexts: [REQUIRED],
    unresolvedReviewThreads: 0,
    ...greenEvidence,
  });
  assert.equal(result.state, 'success');
  assert.equal(result.pending.includes('missing exact-head AUTO approval'), false);
  assert.equal(result.pending.includes('no trusted AUTO reviewer configured'), false);
  assert.equal(result.evidence.trustedAutoReviewerCount, 0);
}

// Review comments still re-trigger the controller because they can create or
// resolve review threads even though their AUTO-shaped text carries no power.
{
  const result = evaluate([auto('R1', 'APPROVED', '2026-09-07T00:02:00Z')], {
    unresolvedReviewThreads: 1,
  });
  assert.equal(result.state, 'failure');
  assert.ok(result.blockers.includes('1 unresolved review thread(s)'));
}

console.log('final-head admission AUTO reviewer retirement regression: PASS');
