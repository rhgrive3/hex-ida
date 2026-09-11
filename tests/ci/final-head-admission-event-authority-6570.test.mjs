import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  admissionAuthorityCheckRuns,
  admissionEvidenceRevision,
  evaluateFinalHeadAdmission,
} from '../../tools/validation/final-head-admission-tuple.mjs';

const HEAD = '11'.repeat(20);
const BASE = '22'.repeat(20);
const TRUSTED = 'rhgrive3';
const REQUIRED = ['ci/circleci: migration-guardrails'];

const status = (state = 'success') => ({
  context: REQUIRED[0],
  state,
  updated_at: '2026-09-11T15:30:00Z',
});
const auto = () => ({
  state: 'COMMENTED',
  commit_id: HEAD,
  submitted_at: '2026-09-11T15:31:00Z',
  author: { login: TRUSTED },
  body: `[AUTO-REVIEW:R1][HEAD:${HEAD}][BASE:${BASE}][VERDICT:APPROVED]`,
});
const check = ({
  name,
  appSlug,
  conclusion = 'success',
  status: checkStatus = 'completed',
}) => ({
  name,
  status: checkStatus,
  conclusion,
  app: { slug: appSlug },
});
const evaluate = (checkRuns = [], unresolvedReviewThreads = 0) => evaluateFinalHeadAdmission({
  headSha: HEAD,
  currentBaseSha: BASE,
  reviews: [auto()],
  statuses: [status()],
  checkRuns,
  unresolvedReviewThreads,
  trustedAutoReviewers: [TRUSTED],
  requiredStatusContexts: REQUIRED,
});
const evidence = (checkRuns = [], unresolvedReviewThreads = 0) => ({
  draft: false,
  reviews: [auto()],
  statuses: [status()],
  checkRuns,
  unresolvedReviewThreads,
});

const ghaFailure = check({
  name: 'Unlisted GitHub Actions job',
  appSlug: 'github-actions',
  conclusion: 'failure',
});
const externalSuccess = check({
  name: 'External security scan',
  appSlug: 'external-ci',
});
const externalFailure = check({
  name: 'External security scan',
  appSlug: 'external-ci',
  conclusion: 'failure',
});

// GitHub Actions check-run changes do not reliably emit check_run workflows.
// They are therefore outside this controller's check authority. Required CI
// remains fail-closed through the explicit commit-status denominator.
assert.deepEqual(admissionAuthorityCheckRuns([ghaFailure]), []);
assert.equal(evaluate([ghaFailure]).state, 'success');
assert.equal(
  admissionEvidenceRevision(evidence([ghaFailure])),
  admissionEvidenceRevision(evidence([])),
);

// External check runs do emit check_run events, so they remain authority.
assert.deepEqual(admissionAuthorityCheckRuns([externalSuccess]), [externalSuccess]);
assert.equal(evaluate([externalSuccess]).state, 'success');
assert.equal(evaluate([externalFailure]).state, 'failure');
assert.notEqual(
  admissionEvidenceRevision(evidence([externalSuccess])),
  admissionEvidenceRevision(evidence([externalFailure])),
);

// Review-thread resolution is independently enforced by the active native
// required-thread-resolution ruleset. It must not be mutable controller evidence
// because Actions has no resolve/unresolve trigger for that thread state.
assert.equal(evaluate([], 1).state, 'success');
assert.equal(
  admissionEvidenceRevision(evidence([], 0)),
  admissionEvidenceRevision(evidence([], 1)),
);

const workflowSource = fs.readFileSync(
  new URL('../../.github/workflows/final-head-admission.yml', import.meta.url),
  'utf8',
);
assert.match(workflowSource, /check_run:\s*\n\s*types: \[created, rerequested, completed, requested_action\]/);
assert.match(workflowSource, /context\.eventName === 'check_run'/);
assert.match(workflowSource, /github\.event\.check_run\.head_sha/);
assert.match(workflowSource, /required_review_thread_resolution/);
assert.doesNotMatch(workflowSource, /readUnresolvedReviewThreads/);
assert.doesNotMatch(workflowSource, /reviewThreads\(first:/);
