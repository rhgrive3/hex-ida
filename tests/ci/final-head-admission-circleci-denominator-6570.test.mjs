import assert from 'node:assert/strict';
import fs from 'node:fs';

import { evaluateFinalHeadAdmission } from '../../tools/validation/final-head-admission-tuple.mjs';

const HEAD = '11'.repeat(20);
const BASE = '22'.repeat(20);
const TRUSTED = 'rhgrive3';
const REQUIRED = [
  'ci/circleci: migration-guardrails',
  'ci/circleci: agent-loop-resilience',
  'ci/circleci: issue-2528-canonical-claims',
  'ci/circleci: ai-eval-contract',
  'ci/circleci: phase7-ownership',
  'ci/circleci: phase8-ownership',
  'ci/circleci: universal-platform-verify',
  'ci/circleci: universal-platform-benchmark',
];
const UNIVERSAL = REQUIRED.slice(-2);

const auto = () => ({
  state: 'COMMENTED',
  commit_id: HEAD,
  submitted_at: '2026-09-14T10:00:00Z',
  author: { login: TRUSTED },
  body: `[AUTO-REVIEW:R1][HEAD:${HEAD}][BASE:${BASE}][VERDICT:APPROVED]`,
});
const status = (context, state = 'success') => ({
  context,
  state,
  updated_at: '2026-09-14T10:00:00Z',
});
const check = () => ({
  name: 'fast',
  status: 'completed',
  conclusion: 'success',
  app: { slug: 'github-actions' },
});
const evaluate = (statuses) => evaluateFinalHeadAdmission({
  headSha: HEAD,
  currentBaseSha: BASE,
  reviews: [auto()],
  statuses,
  checkRuns: [check()],
  trustedAutoReviewers: [TRUSTED],
  requiredStatusContexts: REQUIRED,
});

const green = REQUIRED.map((context) => status(context));
assert.equal(evaluate(green).state, 'success');

for (const context of UNIVERSAL) {
  const missing = evaluate(green.filter((entry) => entry.context !== context));
  assert.equal(missing.state, 'pending', `${context}: missing required context must stay pending`);
  assert.equal(missing.evidence.missingRequiredStatusCount, 1);
  assert.ok(missing.pending.includes(`required CI status missing: ${context}`));

  const failed = evaluate(green.map((entry) => (
    entry.context === context ? status(context, 'failure') : entry
  )));
  assert.equal(failed.state, 'failure', `${context}: failure must block admission`);
  assert.ok(failed.blockers.includes(`CI status failed: ${context}`));
}

const workflowSource = fs.readFileSync(
  new URL('../../.github/workflows/final-head-admission.yml', import.meta.url),
  'utf8',
);
const circleciSource = fs.readFileSync(
  new URL('../../.circleci/config.yml', import.meta.url),
  'utf8',
);

for (const context of UNIVERSAL) {
  const job = context.slice('ci/circleci: '.length);
  assert.match(
    workflowSource,
    new RegExp(`'ci/circleci: ${job}'`),
    `${job}: final-head admission must require the always-scheduled CircleCI context`,
  );
  assert.match(circleciSource, new RegExp(`^  ${job}:`, 'm'), `${job}: CircleCI job must exist`);
  assert.match(
    circleciSource,
    new RegExp(`^      - ${job}(?::)?$`, 'm'),
    `${job}: CircleCI ci workflow must always schedule the job`,
  );
}
assert.match(
  circleciSource,
  /^      - universal-platform-benchmark:\s*\n\s*requires:\s*\n\s*- universal-platform-verify$/m,
  'universal benchmark must remain ordered after universal verify',
);
