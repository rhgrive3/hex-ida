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
const externalSuccess = check({
  name: 'External security scan',
  appSlug: 'external-ci',
});
const externalFailure = check({
  name: 'External security scan',
  appSlug: 'external-ci',
  conclusion: 'failure',
});

// The controller subscribes to workflow display names, but GitHub publishes
// check runs under job names. Keep the authority denominator bound to the real
// emitted terminal job checks so a workflow_run can never trigger an evaluation
// that then discards the failure which caused it.
const workflowCheckContracts = [
  ['pr-fast-gate.yml', 'PR fast gate', [['fast', 'fast']]],
  ['invariant-gates.yml', 'Invariant Gates', [['invariant-gates', 'invariant-gates']]],
  ['agent-loop-resilience.yml', 'Agent loop resilience', [['resilience', 'resilience']]],
  ['ai-eval-contract.yml', 'AI evaluation contract', [['contract', 'contract']]],
  ['issue-2528-canonical-claims.yml', 'Issue 2528 canonical claims authority', [['canonical-claims', 'canonical-claims']]],
  ['phase7-ownership.yml', 'Phase 7 ownership', [['ownership', 'ownership']]],
  ['phase8-ownership.yml', 'Phase 8 ownership', [['ownership', 'ownership']]],
  ['phase4-release-validation.yml', 'Phase 4 exact-SHA release validation', [['exact-sha-proof', 'phase4-exact-sha-proof']]],
  ['phase6-release-validation.yml', 'Phase 6 release validation', [['verify', 'verify']]],
  ['phase7-release-validation.yml', 'Phase 7 release validation', [['verify', 'verify']]],
  ['phase8-release-validation.yml', 'Phase 8 release validation', [['verify', 'verify']]],
  ['phase9-preflight.yml', 'Phase 9 preflight', [['preflight', 'preflight']]],
  ['phase10-release-validation.yml', 'Phase 10 release validation', [['verify', 'verify']]],
  ['phase11-release-validation.yml', 'Phase 11 release validation', [['verify', 'verify']]],
  ['phase12-release-validation.yml', 'Phase 12 release validation', [['verify', 'verify']]],
  ['stage1-release-validation.yml', 'Stage 1 analysis truth validation', [['exact-candidate', 'exact-candidate']]],
  ['stage2-release-validation.yml', 'Stage 2 authority runtime rebuild validation', [['final-exact-product', 'final-exact-product']]],
  ['stage2-nonphysical-closure.yml', 'Stage 2 non-physical closure proof', [['exact-nonphysical-closure', 'exact-nonphysical-closure']]],
  ['cross-binary-accuracy.yml', 'Cross-binary accuracy', [['accuracy', 'accuracy']]],
  ['ghidra-differential.yml', 'Ghidra decompiler differential', [['compiler-truth-vs-ghidra', 'compiler-truth-vs-ghidra']]],
  ['ui-regression.yml', 'UI regression', [['browser-matrix', 'browser-matrix']]],
  ['universal-platform.yml', 'Universal binary platform', [['verify', 'verify'], ['benchmark', 'benchmark']]],
  ['userscript-host.yml', 'ChatGPT userscript host', [['userscript', 'userscript'], ['embed-browser', 'embed-browser']]],
];

// Unknown/non-event-covered GitHub Actions checks remain outside controller
// authority. Every event-covered emitted job check is retained and its
// success/failure/pending state participates in both admission and evidence
// revision. This includes the R1 counterexample production shape `resilience`.
assert.deepEqual(admissionAuthorityCheckRuns([unlistedGhaFailure]), []);
assert.equal(evaluate([unlistedGhaFailure]).state, 'success');

const coveredCheckNames = new Set(
  workflowCheckContracts.flatMap(([, , jobs]) => jobs.map(([, checkName]) => checkName)),
);
for (const name of coveredCheckNames) {
  const success = check({ name, appSlug: 'github-actions' });
  const failure = check({ name, appSlug: 'github-actions', conclusion: 'failure' });
  const pending = check({
    name,
    appSlug: 'github-actions',
    conclusion: null,
    status: 'in_progress',
  });
  assert.deepEqual(admissionAuthorityCheckRuns([success]), [success], `${name}: success must be authority`);
  assert.equal(evaluate([success]).state, 'success', `${name}: completed success must admit`);
  assert.deepEqual(admissionAuthorityCheckRuns([failure]), [failure], `${name}: failure must be authority`);
  assert.equal(evaluate([failure]).state, 'failure', `${name}: failure must block`);
  assert.deepEqual(admissionAuthorityCheckRuns([pending]), [pending], `${name}: pending must be authority`);
  assert.equal(evaluate([pending]).state, 'pending', `${name}: pending must block`);
  assert.notEqual(
    admissionEvidenceRevision(evidence([success])),
    admissionEvidenceRevision(evidence([failure])),
    `${name}: failure must change evidence revision`,
  );
  assert.notEqual(
    admissionEvidenceRevision(evidence([success])),
    admissionEvidenceRevision(evidence([pending])),
    `${name}: pending must change evidence revision`,
  );
}

const resilienceFailure = check({
  name: 'resilience',
  appSlug: 'github-actions',
  conclusion: 'failure',
});
assert.deepEqual(admissionAuthorityCheckRuns([resilienceFailure]), [resilienceFailure]);
assert.equal(evaluate([resilienceFailure]).state, 'failure');

// A same-HEAD rerun must invalidate a previously green admission as soon as
// the authoritative workflow enters in_progress, before completion. GitHub
// Actions does not emit check_run workflow events for its own checks, so the
// workflow_run in_progress event is the scheduling edge that closes this gap.
const fastCompleted = check({ name: 'fast', appSlug: 'github-actions' });
const fastRerunInProgress = check({
  name: 'fast',
  appSlug: 'github-actions',
  conclusion: null,
  status: 'in_progress',
});
assert.equal(evaluate([fastCompleted]).state, 'success');
assert.equal(evaluate([fastRerunInProgress]).state, 'pending');
assert.notEqual(
  admissionEvidenceRevision(evidence([fastCompleted])),
  admissionEvidenceRevision(evidence([fastRerunInProgress])),
);

// Workflow display names are scheduling identities, not check-run identities;
// they must not accidentally remain in the authority-name denominator.
for (const [, workflowName, jobs] of workflowCheckContracts) {
  if (jobs.some(([, checkName]) => checkName === workflowName)) continue;
  const displayNameFailure = check({
    name: workflowName,
    appSlug: 'github-actions',
    conclusion: 'failure',
  });
  assert.deepEqual(
    admissionAuthorityCheckRuns([displayNameFailure]),
    [],
    `${workflowName}: workflow display name must not masquerade as a check-run name`,
  );
}

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
assert.match(workflowSource, /workflow_run:[\s\S]*?\n\s*types: \[in_progress, completed\]/);
assert.match(workflowSource, /context\.eventName === 'check_run'/);
assert.match(workflowSource, /github\.event\.check_run\.head_sha/);
assert.match(workflowSource, /required_review_thread_resolution/);
assert.doesNotMatch(workflowSource, /readUnresolvedReviewThreads/);
assert.doesNotMatch(workflowSource, /reviewThreads\(first:/);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [file, workflowName, jobs] of workflowCheckContracts) {
  const source = fs.readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
  assert.match(source, new RegExp(`^name: ${escapeRegex(workflowName)}$`, 'm'), `${file}: workflow name drift`);
  assert.match(
    workflowSource,
    new RegExp(`^\\s*- ${escapeRegex(workflowName)}$`, 'm'),
    `${file}: workflow must remain event-covered`,
  );
  for (const [jobKey, checkName] of jobs) {
    assert.match(source, new RegExp(`^  ${escapeRegex(jobKey)}:`, 'm'), `${file}: missing ${jobKey} job`);
    if (jobKey !== checkName) {
      assert.match(
        source,
        new RegExp(`^    name: ${escapeRegex(checkName)}$`, 'm'),
        `${file}: ${jobKey} must emit ${checkName}`,
      );
    }
  }
}
