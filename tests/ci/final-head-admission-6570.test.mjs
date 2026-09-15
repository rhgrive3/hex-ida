import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FINAL_HEAD_ADMISSION_CONTEXT,
  FINAL_HEAD_ADMISSION_CHECK_NAME,
  evaluateFinalHeadAdmission,
  latestStatuses,
} from '../../tools/validation/final-head-admission.mjs';

const HEAD = '1340a18dd3f13b9a54f3e75b763cfbd8743202e7';
const REQUIRED = [
  'ci/circleci: phase7-ownership',
  'ci/circleci: migration-guardrails',
];
const status = (context, state, at = '2026-09-07T00:00:00Z') => ({ context, state, updated_at: at });
const check = (name, conclusion = 'success', checkStatus = 'completed', app = 'github-actions') => ({
  name,
  status: checkStatus,
  conclusion,
  app: { slug: app },
});
const formal = (state, author = 'reviewer-a', at = '2026-09-07T00:00:00Z') => ({
  state,
  submitted_at: at,
  author: { login: author },
  body: `formal ${state}`,
});
const greenStatuses = () => REQUIRED.map((context) => status(context, 'success'));
const evaluate = (input = {}) => evaluateFinalHeadAdmission({
  headSha: HEAD,
  reviews: [],
  statuses: greenStatuses(),
  checkRuns: [check('PR fast gate')],
  unresolvedReviewThreads: 0,
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
assert.ok(
  workflowSource.includes('ref: ${{ github.event.repository.default_branch }}'),
  'the privileged controller must load evaluator code from the default branch',
);
assert.ok(
  workflowSource.includes('persist-credentials: false'),
  'the privileged controller checkout must remain credential-free',
);

// Current policy: campaign-only draft/AUTO approval authority is retired.
// A head with required CI present, all observed CI green and no real review
// blockers is admissible even when no AUTO marker exists.
{
  const result = evaluate();
  assert.equal(result.state, 'success');
  assert.equal(result.evidence.exactAutoApprovalCount, 0);
  assert.equal(result.evidence.exactAutoChangesRequestedCount, 0);
  assert.equal(result.evidence.missingRequiredStatusCount, 0);
}

// Required contexts prevent transient success before the full status surface
// exists, and failures remain blocking.
{
  const missing = evaluate({
    statuses: [status(REQUIRED[0], 'success')],
  });
  assert.equal(missing.state, 'pending');
  assert.equal(missing.evidence.missingRequiredStatusCount, 1);
  assert.ok(missing.pending.includes(`required CI status missing: ${REQUIRED[1]}`));

  const failed = evaluate({
    statuses: [status(REQUIRED[0], 'success'), status(REQUIRED[1], 'failure')],
  });
  assert.equal(failed.state, 'failure');
  assert.ok(failed.blockers.includes(`CI status failed: ${REQUIRED[1]}`));
}

// Every additional observed CI result is still fail-closed. Pending generic
// checks keep admission pending and failed generic checks block it.
{
  const pending = evaluate({
    checkRuns: [check('PR fast gate'), check('extra-verifier', null, 'in_progress')],
  });
  assert.equal(pending.state, 'pending');
  assert.ok(pending.pending.includes('CI check pending: extra-verifier'));

  const failed = evaluate({
    checkRuns: [check('PR fast gate'), check('extra-verifier', 'failure')],
  });
  assert.equal(failed.state, 'failure');
  assert.ok(failed.blockers.includes('CI check failed: extra-verifier'));
}

// The controller's own status/check is excluded to avoid self-recursion, and
// CodeRabbit remains advisory rather than becoming merge authority.
{
  const result = evaluate({
    statuses: [
      ...greenStatuses(),
      status(FINAL_HEAD_ADMISSION_CONTEXT, 'failure'),
      { ...status('CodeRabbit', 'failure'), creator: { login: 'coderabbitai[bot]' } },
    ],
    checkRuns: [
      check('PR fast gate'),
      check(FINAL_HEAD_ADMISSION_CHECK_NAME, 'failure'),
      check('CodeRabbit', 'failure', 'completed', 'coderabbitai'),
    ],
  });
  assert.equal(result.state, 'success');
  assert.equal(result.blockers.some((reason) => /CodeRabbit|final-head/i.test(reason)), false);
}

// Review-thread and formal GitHub review blockers remain authoritative.
{
  const threaded = evaluate({ unresolvedReviewThreads: 1 });
  assert.equal(threaded.state, 'failure');
  assert.ok(threaded.blockers.includes('1 unresolved review thread(s)'));

  const blocked = evaluate({ reviews: [formal('CHANGES_REQUESTED')] });
  assert.equal(blocked.state, 'failure');
  assert.ok(blocked.blockers.includes('active GitHub changes-requested review'));

  const cleared = evaluate({
    reviews: [
      formal('CHANGES_REQUESTED', 'reviewer-a', '2026-09-07T00:00:00Z'),
      formal('APPROVED', 'reviewer-a', '2026-09-07T00:01:00Z'),
    ],
  });
  assert.equal(cleared.state, 'success');
}

// A COMMENTED review never clears an active formal request for changes.
{
  const result = evaluate({
    reviews: [
      formal('CHANGES_REQUESTED', 'reviewer-a', '2026-09-07T00:00:00Z'),
      formal('COMMENTED', 'reviewer-a', '2026-09-07T00:01:00Z'),
    ],
  });
  assert.equal(result.state, 'failure');
  assert.ok(result.blockers.includes('active GitHub changes-requested review'));
}

// A later dismissal clears the same reviewer's formal blocker. Unknown formal
// states fail closed instead of being silently ignored.
{
  const dismissed = formal('DISMISSED', 'reviewer-a', '2026-09-07T00:02:00Z');
  dismissed.dismissed_at = '2026-09-07T00:02:00Z';
  const cleared = evaluate({
    reviews: [formal('CHANGES_REQUESTED', 'reviewer-a', '2026-09-07T00:00:00Z'), dismissed],
  });
  assert.equal(cleared.state, 'success');

  const unknown = evaluate({ reviews: [formal('SOMETHING_NEW')] });
  assert.equal(unknown.state, 'failure');
  assert.ok(unknown.blockers.includes('active GitHub changes-requested review'));
}

// Equally-new conflicting statuses are preserved and therefore fail closed.
{
  const at = '2026-09-07T00:05:00Z';
  const statuses = [
    status(REQUIRED[0], 'success', at),
    status(REQUIRED[0], 'failure', at),
    status(REQUIRED[1], 'success', at),
  ];
  assert.equal(latestStatuses(statuses).filter((item) => item.context === REQUIRED[0]).length, 2);
  const result = evaluate({ statuses });
  assert.equal(result.state, 'failure');
  assert.ok(result.blockers.includes(`CI status failed: ${REQUIRED[0]}`));
}

assert.throws(
  () => evaluateFinalHeadAdmission({ headSha: 'not-a-sha' }),
  /final-head-admission-invalid-head-sha/,
);

console.log('final-head admission regression: PASS');
