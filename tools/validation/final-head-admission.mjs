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
      // Equal-newest AUTO records remain visible together; a conflicting
      // APPROVED/CHANGES_REQUESTED pair must block rather than depend on
      // stable input ordering.
      current.items.push(review);
    }
  }
  return [...result.values()].flatMap((entry) => entry.items);
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

function parseAutoReviewMarker(review) {
  const body = string(review?.body);
  const autoTokens = body.match(/\[AUTO-REVIEW:/g) ?? [];
  if (autoTokens.length !== 1) return null;
  // The AUTO reviewer may interleave a [BASE:<sha>] segment between HEAD and
  // VERDICT (current-base review evidence). It is preserved so the evaluator
  // can bind approvals to the authoritative current base.
  const match = body.match(
    /^\[AUTO-REVIEW:([^\]\s]+)\]\[HEAD:([0-9a-f]{40})\](?:\[BASE:([0-9a-f]{40})\])?\[VERDICT:(APPROVED|CHANGES_REQUESTED)\]/,
  );
  if (!match) return null;
  return Object.freeze({
    reviewerId: string(match[1]).trim().toUpperCase(),
    headSha: match[2].toLowerCase(),
    baseSha: match[3] ? match[3].toLowerCase() : null,
    verdict: match[4],
  });
}

function autoReviewerId(review) {
  return parseAutoReviewMarker(review)?.reviewerId ?? '';
}

function isExactHeadAutoReview(review, headSha, trustedReviewers) {
  const marker = parseAutoReviewMarker(review);
  if (!marker || marker.headSha !== string(headSha).toLowerCase()) return false;
  const commitId = string(review?.commit_id);
  if (!commitId || commitId.toLowerCase() !== string(headSha).toLowerCase()) return false;
  return trustedReviewers.has(reviewAuthor(review));
}

function autoVerdict(review) {
  return parseAutoReviewMarker(review)?.verdict ?? null;
}

function latestExactAutoReviews(reviews, headSha, trustedReviewers) {
  const result = new Map();
  const exactReviews = reviews.filter((review) => isExactHeadAutoReview(review, headSha, trustedReviewers));
  for (const review of [...exactReviews].sort(newestFirst)) {
    const reviewerId = autoReviewerId(review);
    const timestamp = evidenceTime(review);
    const current = result.get(reviewerId);
    if (!current || timestamp > current.timestamp) {
      result.set(reviewerId, { timestamp, items: [review] });
    } else if (timestamp === current.timestamp) {
      // Logical AUTO reviewers (R0/R1/...) share the trusted GitHub author in
      // this repository. Preserve equal-newest conflicts within one reviewer,
      // but never let another reviewer overwrite its state.
      current.items.push(review);
    }
  }
  return [...result.values()].flatMap((entry) => entry.items);
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
  draft = false,
  reviews = [],
  statuses = [],
  checkRuns = [],
  unresolvedReviewThreads = 0,
  trustedAutoReviewers = [],
  requiredStatusContexts = [],
  currentBaseSha = null,
} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(string(headSha))) {
    throw new TypeError('final-head-admission-invalid-head-sha');
  }

  const blockers = [];
  const pending = [];
  const latest = latestStatuses(statuses);
  const latestStatusByContext = new Map(latest.map((status) => [string(status?.context), status]));
  const trustedReviewers = trustedReviewerSet(trustedAutoReviewers);
  // External review providers are advisory and must never become required CI
  // contexts through caller configuration. Independent exact-head AUTO
  // approval remains the only review authority here.
  const requiredContexts = normalizedContextList(requiredStatusContexts)
    .filter((context) => !isCodeRabbitStatus({ context }));
  const exactAutoReviews = latestExactAutoReviews(reviews, headSha, trustedReviewers);
  // Current-base review identity: when the caller provides an authoritative
  // current base, an approval only counts when its marker is bound to that
  // exact base (tuple match). Legacy BASE-less markers stay parseable for
  // diagnostics but never admit under the current-base contract. Callers that
  // do not pass currentBaseSha keep the exact-head-only contract.
  const hasBaseAuthority = string(currentBaseSha).length === 40;
  const baseBinding = (review) => {
    const marker = parseAutoReviewMarker(review);
    return marker?.baseSha ?? null;
  };
  const baseMatches = (review) => {
    if (!hasBaseAuthority) return true;
    const markerBase = baseBinding(review);
    return markerBase != null && markerBase === string(currentBaseSha).toLowerCase();
  };
  const exactAutoApprovals = exactAutoReviews.filter((review) => autoVerdict(review) === 'APPROVED' && baseMatches(review));
  const exactAutoChanges = exactAutoReviews.filter((review) => autoVerdict(review) === 'CHANGES_REQUESTED'
    && (!hasBaseAuthority || baseMatches(review) || baseBinding(review) == null));

  if (draft) pending.push('pull request is draft');
  if (trustedReviewers.size === 0) pending.push('no trusted AUTO reviewer configured');
  if (exactAutoApprovals.length === 0) pending.push('missing exact-head AUTO approval');
  if (exactAutoChanges.length > 0) blockers.push('exact-head AUTO review requests changes');
  if (activeFormalChangesRequested(reviews)) blockers.push('active GitHub changes-requested review');
  if (Number(unresolvedReviewThreads) > 0) blockers.push(`${Number(unresolvedReviewThreads)} unresolved review thread(s)`);

  // Keep provider evidence visible for diagnostics, but never let its absence,
  // pending state, skipped/rate-limited result, or failure affect admission.
  const advisoryReviewEvidence = [
    ...latest.filter(isCodeRabbitStatus).map((item) => ({ kind: 'status', item })),
    ...checkRuns.filter(isCodeRabbitCheck).map((item) => ({ kind: 'check', item })),
  ];

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
      codeRabbitEvidenceCount: advisoryReviewEvidence.length,
      ciStatusCount: ciStatuses.length,
      ciCheckCount: ciChecks.length,
    }),
  });
}
