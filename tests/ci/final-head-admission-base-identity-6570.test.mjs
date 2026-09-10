import assert from 'node:assert/strict';
import fs from 'node:fs';

import { evaluateFinalHeadAdmission } from '../../tools/validation/final-head-admission-tuple.mjs';

const HEAD = '11'.repeat(20);
const BASE_OLD = '22'.repeat(20);
const BASE_NEW = '33'.repeat(20);
const TRUSTED = 'rhgrive3';
const REQUIRED = ['ci/circleci: migration-guardrails'];

const status = (context, state = 'success') => ({
  context,
  state,
  updated_at: '2026-09-10T00:00:00Z',
});
const check = () => ({
  name: 'PR fast gate',
  status: 'completed',
  conclusion: 'success',
  app: { slug: 'github-actions' },
});
const auto = ({ base = BASE_OLD, verdict = 'APPROVED', body = null } = {}) => ({
  state: 'COMMENTED',
  commit_id: HEAD,
  submitted_at: '2026-09-10T00:01:00Z',
  author: { login: TRUSTED },
  body: body ?? `[AUTO-REVIEW:R1][HEAD:${HEAD}][BASE:${base}][VERDICT:${verdict}]`,
});
const evaluate = (currentBaseSha, reviews) => evaluateFinalHeadAdmission({
  headSha: HEAD,
  currentBaseSha,
  reviews,
  statuses: REQUIRED.map((context) => status(context)),
  checkRuns: [check()],
  unresolvedReviewThreads: 0,
  trustedAutoReviewers: [TRUSTED],
  requiredStatusContexts: REQUIRED,
});

{
  const result = evaluate(BASE_OLD, [auto()]);
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 1);
}

// Same HEAD, different live BASE: old approval authority must disappear.
{
  const result = evaluate(BASE_NEW, [auto({ base: BASE_OLD })]);
  assert.equal(result.state, 'pending');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
  assert.ok(result.pending.includes('missing exact-head AUTO approval'));
}

// BASE-less and malformed/ambiguous BASE forms are never current-tuple evidence.
for (const body of [
  `[AUTO-REVIEW:R1][HEAD:${HEAD}][VERDICT:APPROVED]`,
  `[AUTO-REVIEW:R1][HEAD:${HEAD}][BASE:${BASE_NEW}][BASE:${BASE_NEW}][VERDICT:APPROVED]`,
  `[AUTO-REVIEW:R1][HEAD:${HEAD}][VERDICT:APPROVED][BASE:${BASE_NEW}]`,
  `[AUTO-REVIEW:R1][HEAD:${HEAD}][BASE:${BASE_NEW}][VERDICT:APPROVED] [AUTO-REVIEW:R1][HEAD:${HEAD}][BASE:${BASE_NEW}][VERDICT:APPROVED]`,
]) {
  const result = evaluate(BASE_NEW, [auto({ body })]);
  assert.equal(result.state, 'pending');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
}

// A stale-base CHANGES_REQUESTED marker is not authority for the current tuple;
// a current-base approval from the same logical reviewer can therefore admit.
{
  const stale = auto({ base: BASE_OLD, verdict: 'CHANGES_REQUESTED' });
  stale.submitted_at = '2026-09-10T00:02:00Z';
  const current = auto({ base: BASE_NEW, verdict: 'APPROVED' });
  const result = evaluate(BASE_NEW, [current, stale]);
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoChangesRequestedCount, 0);
}

assert.throws(
  () => evaluateFinalHeadAdmission({ headSha: HEAD, reviews: [] }),
  /final-head-admission-invalid-base-sha/,
);

const workflowSource = fs.readFileSync(
  new URL('../../.github/workflows/final-head-admission.yml', import.meta.url),
  'utf8',
);
assert.match(workflowSource, /push:\s*\n\s*branches:\s*\[main\]/);
assert.match(workflowSource, /github\.rest\.repos\.getBranch/);
assert.match(workflowSource, /currentBaseSha:\s*evaluatedBaseSha/);
assert.match(workflowSource, /context\.eventName === 'push'/);
assert.match(workflowSource, /fresh \(HEAD,BASE\) AUTO review required/);

// #6570 delayed-writer regression: the controller must re-fetch both mutable
// tuple authorities after evaluation and before the final status write. This
// prevents an old run from resurrecting success after B_old -> B_new (or H -> H2).
const evaluationIndex = workflowSource.indexOf('const result = evaluator.evaluateFinalHeadAdmission');
const refetchPrIndex = workflowSource.indexOf('const { data: currentPr } = await github.rest.pulls.get', evaluationIndex);
const refetchBaseIndex = workflowSource.indexOf('const { data: currentBaseBranch } = await github.rest.repos.getBranch', refetchPrIndex);
const driftGuardIndex = workflowSource.indexOf('currentHeadSha !== headSha || currentBaseSha !== evaluatedBaseSha', refetchBaseIndex);
const finalWriteIndex = workflowSource.indexOf('await github.rest.repos.createCommitStatus', driftGuardIndex);
assert.ok(evaluationIndex >= 0, 'workflow evaluates a concrete (HEAD,BASE) tuple');
assert.ok(refetchPrIndex > evaluationIndex, 'PR head is re-fetched after evaluation');
assert.ok(refetchBaseIndex > refetchPrIndex, 'target branch is re-fetched after PR head');
assert.ok(driftGuardIndex > refetchBaseIndex, 'head/base drift is checked after both re-fetches');
assert.ok(finalWriteIndex > driftGuardIndex, 'status write happens only after the tuple drift guard');
assert.match(
  workflowSource.slice(driftGuardIndex, finalWriteIndex),
  /if \(currentHeadSha !== headSha \|\| currentBaseSha !== evaluatedBaseSha\)[\s\S]*?return;/,
  'a drifted tuple exits before the evaluated result can be published',
);
