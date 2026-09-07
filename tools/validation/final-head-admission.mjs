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
  const l = Date.parse(left?.updated_at || left?.submitted_at || left?.created_at || '') || 0;
  const r = Date.parse(right?.updated_at || right?.submitted_at || right?.created_at || '') || 0;
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

function reviewAuthor(review) {
  return string(review?.author?.login || review?.user?.login).trim().toLowerCase();
}

export function latestReviewsByAuthor(reviews = []) {
  const result = new Map();
  let anonymous = 0;
  for (const review of [...reviews].sort(newestFirst)) {
    const author = reviewAuthor(review) || `__anonymous_${anonymous++}`;
    if (result.has(author)) continue;
    result.set(author, review);
  }
  return [...result.values()];
}

function trustedReviewerSet(values = []) {
  return new Set(values.map((value) => string(value).trim().toLowerCase()).filter(Boolean));
}

function normalizedContextList(values = []) {
  return [...new Set(values.map((value) => string(value).trim()).filter(Boolean))];
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

function isExactHeadAutoReview(review, headSha, trustedReviewers) {
  const body = string(review?.body);
  if (!/\[AUTO-REVIEW:[^\]]+\]/.test(body)) return false;
  if (!exactHeadMarker(body, headSha)) return false;
  const commitId = string(review?.commit_id);
  if (commitId && commitId !== headSha) return false;
  return trustedReviewers.has(reviewAuthor(review));
}

function autoVerdict(review) {
  const match = string(review?.body).match(/\[VERDICT:(APPROVED|CHANGES_REQUESTED)\]/);
  return match?.[1] ?? null;
}

function latestExactAutoReviews(reviews, headSha, trustedReviewers) {
  return latestReviewsByAuthor(
    reviews.filter((review) => isExactHeadAutoReview(review, headSha, trustedReviewers)),
  );
}

function activeFormalChangesRequested(reviews = []) {
  return latestReviewsByAuthor(reviews)
    .some((review) => string(review?.state).toUpperCase() === 'CHANGES_REQUESTED');
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
  trustedAutoReviewers = [],
  requiredStatusContexts = [],
} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(string(headSha))) {
    throw new TypeError('final-head-admission-invalid-head-sha');
  }

  const blockers = [];
  const pending = [];
  const latest = latestStatuses(statuses);
  const latestStatusByContext = new Map(latest.map((status) => [string(status?.context), status]));
  const trustedReviewers = trustedReviewerSet(trustedAutoReviewers);
  const requiredContexts = normalizedContextList(requiredStatusContexts);
  const exactAutoReviews = latestExactAutoReviews(reviews, headSha, trustedReviewers);
  const exactAutoApprovals = exactAutoReviews.filter((review) => autoVerdict(review) === 'APPROVED');
  const exactAutoChanges = exactAutoReviews.filter((review) => autoVerdict(review) === 'CHANGES_REQUESTED');

  if (draft) pending.push('pull request is draft');
  if (trustedReviewers.size === 0) pending.push('no trusted AUTO reviewer configured');
  if (exactAutoApprovals.length === 0) pending.push('missing exact-head AUTO approval');
  if (exactAutoChanges.length > 0) blockers.push('exact-head AUTO review requests changes');
  if (activeFormalChangesRequested(reviews)) blockers.push('active GitHub changes-requested review');
  if (Number(unresolvedReviewThreads) > 0) blockers.push(`${Number(unresolvedReviewThreads)} unresolved review thread(s)`);

  const reviewStatuses = latest.filter(isCodeRabbitStatus);
  const reviewChecks = checkRuns.filter(isCodeRabbitCheck);
  const reviewEvidence = [
    ...reviewStatuses.map((item) => ({ kind: 'status', item })),
    ...reviewChecks.map((item) => ({ kind: 'check', item })),
  ];
  if (reviewEvidence.length === 0) {
    pending.push('missing CodeRabbit exact-head result');
  } else {
    for (const evidence of reviewEvidence) {
      const state = evidence.kind === 'status' ? statusState(evidence.item) : checkState(evidence.item);
      if (state === 'failure') blockers.push('CodeRabbit exact-head result is not green');
      else if (state === 'pending') pending.push('CodeRabbit exact-head result is pending');
    }
  }

  if (requiredContexts.length === 0) {
    pending.push('no required CI status contexts configured');
  }
  let missingRequiredStatusCount = 0;
  for (const context of requiredContexts) {
    const required = latestStatusByContext.get(context);
    if (!required) {
      missingRequiredStatusCount += 1;
      pending.push(`required CI status missing: ${context}`);
      continue;
    }
    const state = statusState(required);
    if (state === 'failure') blockers.push(`CI status failed: ${context}`);
    else if (state === 'pending') pending.push(`CI status pending: ${context}`);
  }

  const ciStatuses = latest.filter((status) => !isAdmissionStatus(status) && !isCodeRabbitStatus(status));
  const ciChecks = checkRuns.filter((check) => !isAdmissionCheck(check) && !isCodeRabbitCheck(check));
  if (ciStatuses.length + ciChecks.length === 0) {
    pending.push('missing exact-head CI evidence');
  }

  // Required contexts prevent early success while late CI contexts have not
  // appeared yet. Once present, any additional observed CI failure also blocks.
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
      trustedAutoReviewerCount: trustedReviewers.size,
      requiredStatusContextCount: requiredContexts.length,
      missingRequiredStatusCount,
      unresolvedReviewThreads: Number(unresolvedReviewThreads) || 0,
      codeRabbitEvidenceCount: reviewEvidence.length,
      ciStatusCount: ciStatuses.length,
      ciCheckCount: ciChecks.length,
    }),
  });
}
