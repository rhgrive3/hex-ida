export const FINAL_HEAD_ADMISSION_CONTEXT = 'hex/final-head-admission';
export const FINAL_HEAD_ADMISSION_CHECK_NAME = 'exact-head-admission-controller';

const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const FAILING_CHECK_CONCLUSIONS = new Set([
  'failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure',
]);
const CODERABBIT_STATUS_CONTEXT = 'coderabbit';
const CODERABBIT_CHECK_APP_SLUG = 'coderabbitai';

function string(value) {
  return typeof value === 'string' ? value : '';
}

function evidenceTime(value) {
  const parsed = Date.parse(value?.updated_at || value?.submitted_at || value?.created_at || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestFirst(left, right) {
  return evidenceTime(right) - evidenceTime(left);
}

export function latestStatuses(statuses = []) {
  const result = new Map();
  for (const status of [...statuses].sort(newestFirst)) {
    const context = string(status?.context);
    if (!context) continue;
    const timestamp = evidenceTime(status);
    const current = result.get(context);
    if (!current || timestamp > current.timestamp) {
      result.set(context, { timestamp, items: [status] });
    } else if (timestamp === current.timestamp) {
      // Preserve every equally-new record so conflicting status states are
      // aggregated fail-closed instead of being selected by input order.
      current.items.push(status);
    }
  }
  return [...result.values()].flatMap((entry) => entry.items);
}

function reviewAuthor(review) {
  return string(review?.author?.login || review?.user?.login).trim().toLowerCase();
}

export function latestReviewsByAuthor(reviews = []) {
  const result = new Map();
  let anonymous = 0;
  for (const review of [...reviews].sort(newestFirst)) {
    const author = reviewAuthor(review) || `__anonymous_${anonymous++}`;
    const timestamp = evidenceTime(review);
    const current = result.get(author);
    if (!current || timestamp > current.timestamp) {
      result.set(author, { timestamp, items: [review] });
    } else if (timestamp === current.timestamp) {
      current.items.push(review);
    }
  }
  return [...result.values()].flatMap((entry) => entry.items);
}

function normalizedContextList(values = []) {
  return [...new Set(values.map((value) => string(value).trim()).filter(Boolean))];
}

function isAdmissionStatus(status) {
  return string(status?.context) === FINAL_HEAD_ADMISSION_CONTEXT;
}

function isCodeRabbitStatus(status) {
  return string(status?.context).trim().toLowerCase() === CODERABBIT_STATUS_CONTEXT;
}

function isAdmissionCheck(check) {
  return string(check?.name) === FINAL_HEAD_ADMISSION_CHECK_NAME
    || /final[- ]head admission/i.test(string(check?.name));
}

function isCodeRabbitCheck(check) {
  return string(check?.name).trim().toLowerCase() === CODERABBIT_STATUS_CONTEXT
    || string(check?.app?.slug).trim().toLowerCase() === CODERABBIT_CHECK_APP_SLUG;
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

const FORMAL_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const NON_FORMAL_REVIEW_STATES = new Set(['COMMENTED', 'PENDING']);

function formalReviewTime(review, state) {
  const raw = state === 'DISMISSED'
    ? review?.dismissed_at || review?.updated_at || review?.submitted_at || review?.created_at
    : review?.submitted_at || review?.created_at;
  const timestamp = Date.parse(string(raw));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function activeFormalChangesRequested(reviews = []) {
  const decisionsByAuthor = new Map();
  let anonymous = 0;

  for (const review of reviews) {
    const state = string(review?.state).trim().toUpperCase();
    if (NON_FORMAL_REVIEW_STATES.has(state)) continue;
    if (!FORMAL_REVIEW_STATES.has(state)) return true;

    const author = reviewAuthor(review);
    const key = author || `__anonymous_formal_${anonymous++}`;
    const decisions = decisionsByAuthor.get(key) ?? [];
    decisions.push({ state, timestamp: formalReviewTime(review, state) });
    decisionsByAuthor.set(key, decisions);
  }

  for (const decisions of decisionsByAuthor.values()) {
    if (!decisions.some((decision) => decision.state === 'CHANGES_REQUESTED')) continue;
    if (decisions.some((decision) => decision.timestamp == null)) return true;
    const newest = Math.max(...decisions.map((decision) => decision.timestamp));
    if (decisions.some((decision) => (
      decision.timestamp === newest && decision.state === 'CHANGES_REQUESTED'
    ))) return true;
  }
  return false;
}

function reasonList(values) {
  return [...new Set(values.filter(Boolean))];
}

export function evaluateFinalHeadAdmission({
  headSha,
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

  // Campaign-only Draft and exact-head AUTO-approval requirements were
  // intentionally removed. Admission now follows ordinary PR safety signals:
  // real GitHub review blockers plus exact-head CI evidence.
  if (activeFormalChangesRequested(reviews)) blockers.push('active GitHub changes-requested review');
  if (Number(unresolvedReviewThreads) > 0) blockers.push(`${Number(unresolvedReviewThreads)} unresolved review thread(s)`);

  // External review providers remain advisory. Their absence, pending state,
  // skipped/rate-limited result, or failure does not affect admission.
  const advisoryReviewEvidence = [
    ...latest.filter(isCodeRabbitStatus).map((item) => ({ kind: 'status', item })),
    ...checkRuns.filter(isCodeRabbitCheck).map((item) => ({ kind: 'check', item })),
  ];

  const requiredContexts = normalizedContextList(requiredStatusContexts)
    .filter((context) => !isCodeRabbitStatus({ context }));
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

  // Required contexts prevent early success while slower CI contexts have not
  // appeared. Once present, every additional observed CI failure still blocks.
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
    ? 'Required CI and review gates are clear'
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
      // Kept for workflow-summary compatibility while AUTO review authority is
      // retired. These fields are diagnostic only and never gate admission.
      exactAutoApprovalCount: 0,
      exactAutoChangesRequestedCount: 0,
      trustedAutoReviewerCount: normalizedContextList(trustedAutoReviewers).length,
      requiredStatusContextCount: requiredContexts.length,
      missingRequiredStatusCount,
      unresolvedReviewThreads: Number(unresolvedReviewThreads) || 0,
      codeRabbitEvidenceCount: advisoryReviewEvidence.length,
      ciStatusCount: ciStatuses.length,
      ciCheckCount: ciChecks.length,
    }),
  });
}
