export const FINAL_HEAD_ADMISSION_CONTEXT = 'hex/final-head-admission';
export const FINAL_HEAD_ADMISSION_CHECK_NAME = 'exact-head-admission-controller';

const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const FAILING_CHECK_CONCLUSIONS = new Set([
  'failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure',
]);

function string(value) {
  return typeof value === 'string' ? value : '';
}

function newestFirst(left, right) {
  const l = Date.parse(left?.updated_at || left?.created_at || '') || 0;
  const r = Date.parse(right?.updated_at || right?.created_at || '') || 0;
  return r - l;
}

export function latestStatuses(statuses = []) {
  const result = new Map();
  for (const status of [...statuses].sort(newestFirst)) {
    const context = string(status?.context);
    if (!context || result.has(context)) continue;
    result.set(context, status);
  }
  return [...result.values()];
}

function isAdmissionStatus(status) {
  return string(status?.context) === FINAL_HEAD_ADMISSION_CONTEXT;
}

function isCodeRabbitStatus(status) {
  return /coderabbit/i.test(string(status?.context));
}

function isAdmissionCheck(check) {
  return string(check?.name) === FINAL_HEAD_ADMISSION_CHECK_NAME
    || /final[- ]head admission/i.test(string(check?.name));
}

function isCodeRabbitCheck(check) {
  return /coderabbit/i.test(`${string(check?.name)} ${string(check?.app?.slug)} ${string(check?.app?.name)}`);
}

function checkState(check) {
  if (string(check?.status) !== 'completed') return 'pending';
  const conclusion = string(check?.conclusion).toLowerCase();
  if (PASSING_CHECK_CONCLUSIONS.has(conclusion)) return 'success';
  if (FAILING_CHECK_CONCLUSIONS.has(conclusion) || conclusion) return 'failure';
  return 'pending';
}

function statusState(status) {
  const state = string(status?.state).toLowerCase();
  if (state === 'success') return 'success';
  if (state === 'failure' || state === 'error') return 'failure';
  return 'pending';
}

function exactHeadMarker(body, headSha) {
  return string(body).includes(`[HEAD:${headSha}]`);
}

function exactHeadAutoVerdict(review, headSha, verdict) {
  const body = string(review?.body);
  if (!/\[AUTO-REVIEW:[^\]]+\]/.test(body)) return false;
  if (!exactHeadMarker(body, headSha)) return false;
  if (!body.includes(`[VERDICT:${verdict}]`)) return false;
  const commitId = string(review?.commit_id);
  return !commitId || commitId === headSha;
}

function activeFormalChangesRequested(reviews = []) {
  return reviews.some((review) => string(review?.state).toUpperCase() === 'CHANGES_REQUESTED');
}

function reasonList(values) {
  return [...new Set(values.filter(Boolean))];
}

export function evaluateFinalHeadAdmission({
  headSha,
  draft = false,
  reviews = [],
  statuses = [],
  checkRuns = [],
  unresolvedReviewThreads = 0,
} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(string(headSha))) {
    throw new TypeError('final-head-admission-invalid-head-sha');
  }

  const blockers = [];
  const pending = [];
  const latest = latestStatuses(statuses);

  const exactAutoApprovals = reviews.filter((review) => exactHeadAutoVerdict(review, headSha, 'APPROVED'));
  const exactAutoChanges = reviews.filter((review) => exactHeadAutoVerdict(review, headSha, 'CHANGES_REQUESTED'));
  if (draft) pending.push('pull request is draft');
  if (exactAutoApprovals.length === 0) pending.push('missing exact-head AUTO approval');
  if (exactAutoChanges.length > 0) blockers.push('exact-head AUTO review requests changes');
  if (activeFormalChangesRequested(reviews)) blockers.push('active GitHub changes-requested review');
  if (Number(unresolvedReviewThreads) > 0) blockers.push(`${Number(unresolvedReviewThreads)} unresolved review thread(s)`);

  const reviewStatuses = latest.filter(isCodeRabbitStatus);
  const reviewChecks = checkRuns.filter(isCodeRabbitCheck);
  const reviewEvidence = [...reviewStatuses.map((item) => ({ kind: 'status', item })), ...reviewChecks.map((item) => ({ kind: 'check', item }))];
  if (reviewEvidence.length === 0) {
    pending.push('missing CodeRabbit exact-head result');
  } else {
    for (const evidence of reviewEvidence) {
      const state = evidence.kind === 'status' ? statusState(evidence.item) : checkState(evidence.item);
      if (state === 'failure') blockers.push('CodeRabbit exact-head result is not green');
      else if (state === 'pending') pending.push('CodeRabbit exact-head result is pending');
    }
  }

  const ciStatuses = latest.filter((status) => !isAdmissionStatus(status) && !isCodeRabbitStatus(status));
  const ciChecks = checkRuns.filter((check) => !isAdmissionCheck(check) && !isCodeRabbitCheck(check));
  if (ciStatuses.length + ciChecks.length === 0) {
    pending.push('missing exact-head CI evidence');
  }

  for (const status of ciStatuses) {
    const state = statusState(status);
    const context = string(status?.context) || 'unnamed-status';
    if (state === 'failure') blockers.push(`CI status failed: ${context}`);
    else if (state === 'pending') pending.push(`CI status pending: ${context}`);
  }
  for (const check of ciChecks) {
    const state = checkState(check);
    const name = string(check?.name) || 'unnamed-check';
    if (state === 'failure') blockers.push(`CI check failed: ${name}`);
    else if (state === 'pending') pending.push(`CI check pending: ${name}`);
  }

  const uniqueBlockers = reasonList(blockers);
  const uniquePending = reasonList(pending);
  const state = uniqueBlockers.length > 0 ? 'failure' : uniquePending.length > 0 ? 'pending' : 'success';
  const description = state === 'success'
    ? 'Exact-head AUTO review and CI evidence are green'
    : state === 'failure'
      ? uniqueBlockers[0]
      : uniquePending[0];

  return Object.freeze({
    state,
    description,
    headSha,
    blockers: Object.freeze(uniqueBlockers),
    pending: Object.freeze(uniquePending),
    evidence: Object.freeze({
      exactAutoApprovalCount: exactAutoApprovals.length,
      exactAutoChangesRequestedCount: exactAutoChanges.length,
      unresolvedReviewThreads: Number(unresolvedReviewThreads) || 0,
      codeRabbitEvidenceCount: reviewEvidence.length,
      ciStatusCount: ciStatuses.length,
      ciCheckCount: ciChecks.length,
    }),
  });
}
