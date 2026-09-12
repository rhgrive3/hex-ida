import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  admissionEvidenceRevision,
  evaluateFinalHeadAdmission,
  publishTupleBoundAdmissionStatus,
} from '../../tools/validation/final-head-admission-tuple.mjs';

const HEAD = '11'.repeat(20);
const BASE_OLD = '22'.repeat(20);
const BASE_NEW = '33'.repeat(20);
const TRUSTED = 'rhgrive3';
const REQUIRED = ['ci/circleci: migration-guardrails'];

const status = (context, state = 'success', updatedAt = '2026-09-10T00:00:00Z') => ({
  context,
  state,
  updated_at: updatedAt,
});
const check = () => ({
  name: 'PR fast gate',
  status: 'completed',
  conclusion: 'success',
  app: { slug: 'github-actions' },
});
const auto = ({
  base = BASE_OLD,
  verdict = 'APPROVED',
  body = null,
  submittedAt = '2026-09-10T00:01:00Z',
} = {}) => ({
  state: 'COMMENTED',
  commit_id: HEAD,
  submitted_at: submittedAt,
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
const greenEvidence = () => ({
  draft: false,
  reviews: [auto()],
  statuses: REQUIRED.map((context) => status(context)),
  checkRuns: [check()],
  unresolvedReviewThreads: 0,
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
  const stale = auto({ base: BASE_OLD, verdict: 'CHANGES_REQUESTED', submittedAt: '2026-09-10T00:02:00Z' });
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

const GREEN_REVISION = admissionEvidenceRevision(greenEvidence());

// #6570 delayed-writer regression: reproduce the unsafe ordering directly.
// The old run passes its pre-write tuple/evidence check; then B advances and its
// invalidator writes pending; only after that does the delayed old run publish
// success. The post-write tuple check must correct that stale success to pending.
{
  let currentBase = BASE_OLD;
  const writes = [];
  let reads = 0;
  const publication = await publishTupleBoundAdmissionStatus({
    evaluatedHeadSha: HEAD,
    evaluatedBaseSha: BASE_OLD,
    evaluatedEvidenceRevision: GREEN_REVISION,
    readCurrentTuple: async () => {
      reads += 1;
      return {
        open: true,
        headSha: HEAD,
        baseSha: currentBase,
        evidenceRevision: GREEN_REVISION,
      };
    },
    publishEvaluatedStatus: async () => {
      currentBase = BASE_NEW;
      writes.push('pending:new-base-invalidator');
      writes.push('success:delayed-old-base-run');
    },
    publishPendingStatus: async () => {
      writes.push('pending:post-write-correction');
    },
  });
  assert.equal(reads, 2);
  assert.deepEqual(writes, [
    'pending:new-base-invalidator',
    'success:delayed-old-base-run',
    'pending:post-write-correction',
  ]);
  assert.deepEqual(publication, {
    published: true,
    corrected: true,
    reason: 'post-publish-drift',
  });
}

// Stable tuple and evidence: one status write, no spurious correction.
{
  const writes = [];
  const publication = await publishTupleBoundAdmissionStatus({
    evaluatedHeadSha: HEAD,
    evaluatedBaseSha: BASE_OLD,
    evaluatedEvidenceRevision: GREEN_REVISION,
    readCurrentTuple: async () => ({
      open: true,
      headSha: HEAD,
      baseSha: BASE_OLD,
      evidenceRevision: GREEN_REVISION,
    }),
    publishEvaluatedStatus: async () => writes.push('success'),
    publishPendingStatus: async () => writes.push('pending'),
  });
  assert.deepEqual(writes, ['success']);
  assert.equal(publication.corrected, false);
  assert.equal(publication.reason, null);
}

// Drift already visible before publication: never write the evaluated result.
{
  const writes = [];
  const publication = await publishTupleBoundAdmissionStatus({
    evaluatedHeadSha: HEAD,
    evaluatedBaseSha: BASE_OLD,
    evaluatedEvidenceRevision: GREEN_REVISION,
    readCurrentTuple: async () => ({
      open: true,
      headSha: HEAD,
      baseSha: BASE_NEW,
      evidenceRevision: GREEN_REVISION,
    }),
    publishEvaluatedStatus: async () => writes.push('success'),
    publishPendingStatus: async () => writes.push('pending'),
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(publication, {
    published: false,
    corrected: false,
    reason: 'pre-publish-drift',
  });
}

// Same-tuple mutable-evidence race: A reads green, B observes a later R1
// CHANGES_REQUESTED and publishes blocking, then A writes its delayed success.
// The post-write evidence revision must make pending the final authority.
{
  const blockedEvidence = greenEvidence();
  blockedEvidence.reviews.push(auto({
    verdict: 'CHANGES_REQUESTED',
    submittedAt: '2026-09-10T00:03:00Z',
  }));
  const blocked = evaluate(BASE_OLD, blockedEvidence.reviews);
  assert.equal(blocked.state, 'failure');
  const BLOCKED_REVISION = admissionEvidenceRevision(blockedEvidence);
  assert.notEqual(BLOCKED_REVISION, GREEN_REVISION);

  let currentEvidenceRevision = GREEN_REVISION;
  const writes = [];
  const publication = await publishTupleBoundAdmissionStatus({
    evaluatedHeadSha: HEAD,
    evaluatedBaseSha: BASE_OLD,
    evaluatedEvidenceRevision: GREEN_REVISION,
    readCurrentTuple: async () => ({
      open: true,
      headSha: HEAD,
      baseSha: BASE_OLD,
      evidenceRevision: currentEvidenceRevision,
    }),
    publishEvaluatedStatus: async () => {
      currentEvidenceRevision = BLOCKED_REVISION;
      writes.push('failure:newer-changes-requested-run');
      writes.push('success:delayed-old-green-run');
    },
    publishPendingStatus: async () => writes.push('pending:post-write-evidence-correction'),
  });
  assert.deepEqual(writes, [
    'failure:newer-changes-requested-run',
    'success:delayed-old-green-run',
    'pending:post-write-evidence-correction',
  ]);
  assert.deepEqual(publication, {
    published: true,
    corrected: true,
    reason: 'post-publish-evidence-drift',
  });
}

// A CI state transition is also admission evidence even when HEAD/BASE are fixed.
{
  const failed = greenEvidence();
  failed.statuses = [status(REQUIRED[0], 'failure', '2026-09-10T00:04:00Z')];
  assert.notEqual(admissionEvidenceRevision(failed), GREEN_REVISION);
}

// The controller's own status/check must not perturb its evidence revision;
// otherwise every successful publication would self-invalidate on the post-read.
{
  const selfObserved = greenEvidence();
  selfObserved.statuses.push(status('hex/final-head-admission', 'success', '2026-09-10T00:05:00Z'));
  selfObserved.checkRuns.push({
    name: 'exact-head-admission-controller',
    status: 'completed',
    conclusion: 'success',
    app: { slug: 'github-actions' },
  });
  assert.equal(admissionEvidenceRevision(selfObserved), GREEN_REVISION);
}

// GitHub pagination/input ordering must not create a false revision drift.
{
  const ordered = greenEvidence();
  ordered.statuses.push(status('ci/circleci: phase7-ownership', 'success'));
  const reversed = {
    ...ordered,
    reviews: [...ordered.reviews].reverse(),
    statuses: [...ordered.statuses].reverse(),
    checkRuns: [...ordered.checkRuns].reverse(),
  };
  assert.equal(admissionEvidenceRevision(ordered), admissionEvidenceRevision(reversed));
}

assert.match(workflowSource, /publishTupleBoundAdmissionStatus/);
assert.match(workflowSource, /admissionEvidenceRevision/);
assert.match(workflowSource, /evaluatedEvidenceRevision/);
assert.match(workflowSource, /Admission authority changed during status publication; fresh evaluation required/);
assert.match(workflowSource, /if \(publication\.corrected\)[\s\S]*?return;/);
