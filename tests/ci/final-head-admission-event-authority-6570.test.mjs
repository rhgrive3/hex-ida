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

const unlistedGhaFailure = check({
  name: 'Unlisted GitHub Actions job',
  appSlug: 'github-actions',
  conclusion: 'failure',
});
const prFastGateSuccess = check({
  name: 'fast',
  appSlug: 'github-actions',
});
const prFastGateFailure = check({
  name: 'fast',
  appSlug: 'github-actions',
  conclusion: 'failure',
});
const invariantGateSuccess = check({
  name: 'invariant-gates',
  appSlug: 'github-actions',
});
const invariantGateFailure = check({
  name: 'invariant-gates',
  appSlug: 'github-actions',
  conclusion: 'failure',
});
const invariantGatePending = check({
  name: 'invariant-gates',
  appSlug: 'github-actions',
  conclusion: null,
  status: 'in_progress',
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

// Unknown/non-event-covered GitHub Actions checks remain outside controller
// authority. The event-covered PR fast gate's production `jobs.fast` check
// is authoritative and must fail closed when its exact-head check is not green.
assert.deepEqual(admissionAuthorityCheckRuns([unlistedGhaFailure]), []);
assert.equal(evaluate([unlistedGhaFailure]).state, 'success');
assert.deepEqual(admissionAuthorityCheckRuns([prFastGateSuccess]), [prFastGateSuccess]);
assert.equal(evaluate([prFastGateSuccess]).state, 'success');
assert.deepEqual(admissionAuthorityCheckRuns([prFastGateFailure]), [prFastGateFailure]);
assert.equal(evaluate([prFastGateFailure]).state, 'failure');
assert.notEqual(
  admissionEvidenceRevision(evidence([prFastGateSuccess])),
  admissionEvidenceRevision(evidence([prFastGateFailure])),
);

// Invariant Gates is workflow-run covered, but the authoritative terminal
// GitHub Actions check is the aggregate job check named `invariant-gates`.
assert.deepEqual(admissionAuthorityCheckRuns([invariantGateSuccess]), [invariantGateSuccess]);
assert.equal(evaluate([invariantGateSuccess]).state, 'success');
assert.deepEqual(admissionAuthorityCheckRuns([invariantGateFailure]), [invariantGateFailure]);
assert.equal(evaluate([invariantGateFailure]).state, 'failure');
assert.deepEqual(admissionAuthorityCheckRuns([invariantGatePending]), [invariantGatePending]);
assert.equal(evaluate([invariantGatePending]).state, 'pending');
assert.notEqual(
  admissionEvidenceRevision(evidence([invariantGateSuccess])),
  admissionEvidenceRevision(evidence([invariantGateFailure])),
);
assert.notEqual(
  admissionEvidenceRevision(evidence([invariantGateSuccess])),
  admissionEvidenceRevision(evidence([invariantGatePending])),
);

// External check runs emit check_run events, so they remain authority.
assert.deepEqual(admissionAuthorityCheckRuns([externalSuccess]), [externalSuccess]);
assert.equal(evaluate([externalSuccess]).state, 'success');
assert.equal(evaluate([externalFailure]).state, 'failure');
assert.notEqual(
  admissionEvidenceRevision(evidence([externalSuccess])),
  admissionEvidenceRevision(evidence([externalFailure])),
);

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
assert.match(workflowSource, /workflow_run:\s*\n\s*workflows:\s*\n\s*- PR fast gate/);
assert.match(workflowSource, /context\.eventName === 'check_run'/);
assert.match(workflowSource, /github\.event\.check_run\.head_sha/);
assert.match(workflowSource, /required_review_thread_resolution/);
assert.doesNotMatch(workflowSource, /readUnresolvedReviewThreads/);
assert.doesNotMatch(workflowSource, /reviewThreads\(first:/);

const prFastGateSource = fs.readFileSync(
  new URL('../../.github/workflows/pr-fast-gate.yml', import.meta.url),
  'utf8',
);
assert.match(prFastGateSource, /^name: PR fast gate$/m);
assert.match(prFastGateSource, /^jobs:\s*\n  fast:/m);

const invariantGateSource = fs.readFileSync(
  new URL('../../.github/workflows/invariant-gates.yml', import.meta.url),
  'utf8',
);
assert.match(invariantGateSource, /^name: Invariant Gates$/m);
assert.match(invariantGateSource, /^  invariant-gates:\s*\n    name: invariant-gates$/m);
