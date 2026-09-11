import { createHash } from 'node:crypto';

import {
  FINAL_HEAD_ADMISSION_CHECK_NAME,
  FINAL_HEAD_ADMISSION_CONTEXT,
  evaluateFinalHeadAdmission as evaluateLegacyFinalHeadAdmission,
} from './final-head-admission.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;
const EVIDENCE_REVISION_RE = /^[0-9a-f]{64}$/i;

function text(value) {
  return typeof value === 'string' ? value : '';
}

function parseTupleAutoReviewMarker(review) {
  const body = text(review?.body);
  const autoTokens = body.match(/\[AUTO-REVIEW:/g) ?? [];
  const baseTokens = body.match(/\[BASE:/g) ?? [];
  if (autoTokens.length !== 1 || baseTokens.length !== 1) return null;

  const match = body.match(
    /^\[AUTO-REVIEW:([^\]\s]+)\]\[HEAD:([0-9a-f]{40})\]\[BASE:([0-9a-f]{40})\]\[VERDICT:(APPROVED|CHANGES_REQUESTED)\]/i,
  );
  if (!match) return null;

  return Object.freeze({
    reviewerId: match[1].trim().toUpperCase(),
    headSha: match[2].toLowerCase(),
    baseSha: match[3].toLowerCase(),
    verdict: match[4].toUpperCase(),
  });
}

function tupleBoundReviews(reviews, headSha, baseSha) {
  const normalizedHead = text(headSha).toLowerCase();
  const normalizedBase = text(baseSha).toLowerCase();

  return reviews.map((review) => {
    const body = text(review?.body);
    if (!body.includes('[AUTO-REVIEW:')) return review;

    const marker = parseTupleAutoReviewMarker(review);
    if (!marker || marker.headSha !== normalizedHead || marker.baseSha !== normalizedBase) {
      // Preserve GitHub's formal review state/timestamps/author while removing
      // non-current AUTO marker authority. The legacy evaluator still sees any
      // formal CHANGES_REQUESTED state and therefore remains fail-closed.
      return { ...review, body: '' };
    }
    return review;
  });
}

function isAdmissionStatus(status) {
  return text(status?.context) === FINAL_HEAD_ADMISSION_CONTEXT;
}

function isAdmissionCheck(check) {
  return text(check?.name) === FINAL_HEAD_ADMISSION_CHECK_NAME
    || /final[- ]head admission/i.test(text(check?.name));
}

function canonicalRows(values, project) {
  return values.map((value) => JSON.stringify(project(value))).sort();
}

// Bind publication to exactly the mutable GitHub evidence that can affect an
// admission decision. The controller's own status/check is excluded so its
// status write cannot change the revision it is validating.
export function admissionEvidenceRevision({
  draft = false,
  reviews = [],
  statuses = [],
  checkRuns = [],
  unresolvedReviewThreads = 0,
} = {}) {
  const reviewRows = canonicalRows(reviews, (review) => ({
    author: text(review?.author?.login || review?.user?.login).trim().toLowerCase(),
    state: text(review?.state).trim().toUpperCase(),
    commitId: text(review?.commit_id).toLowerCase(),
    body: text(review?.body),
    submittedAt: text(review?.submitted_at),
    createdAt: text(review?.created_at),
    updatedAt: text(review?.updated_at),
    dismissedAt: text(review?.dismissed_at),
  }));
  const statusRows = canonicalRows(
    statuses.filter((status) => !isAdmissionStatus(status)),
    (status) => ({
      context: text(status?.context),
      state: text(status?.state).toLowerCase(),
      updatedAt: text(status?.updated_at),
      submittedAt: text(status?.submitted_at),
      createdAt: text(status?.created_at),
    }),
  );
  const checkRows = canonicalRows(
    checkRuns.filter((check) => !isAdmissionCheck(check)),
    (check) => ({
      name: text(check?.name),
      status: text(check?.status),
      conclusion: text(check?.conclusion).toLowerCase(),
      appSlug: text(check?.app?.slug).trim().toLowerCase(),
    }),
  );
  const threadCount = Number(unresolvedReviewThreads);
  const payload = JSON.stringify({
    draft: draft === true,
    unresolvedReviewThreads: Number.isFinite(threadCount) ? threadCount : 0,
    reviews: reviewRows,
    statuses: statusRows,
    checkRuns: checkRows,
  });
  return createHash('sha256').update(payload).digest('hex');
}

function currentTupleMatches(tuple, headSha, baseSha) {
  return tuple?.open === true
    && text(tuple?.headSha).toLowerCase() === headSha
    && text(tuple?.baseSha).toLowerCase() === baseSha;
}

function currentEvidenceMatches(tuple, evidenceRevision) {
  return EVIDENCE_REVISION_RE.test(text(tuple?.evidenceRevision))
    && text(tuple?.evidenceRevision).toLowerCase() === evidenceRevision;
}

// Publish a status only for the tuple and mutable evidence revision that were
// evaluated, then verify both authorities again after the write. A later review,
// CI result, thread update, draft transition, or HEAD/BASE advance can otherwise
// let an older concurrent run overwrite a newer blocking result.
export async function publishTupleBoundAdmissionStatus({
  evaluatedHeadSha,
  evaluatedBaseSha,
  evaluatedEvidenceRevision,
  readCurrentTuple,
  publishEvaluatedStatus,
  publishPendingStatus,
} = {}) {
  if (!SHA_RE.test(text(evaluatedHeadSha)) || !SHA_RE.test(text(evaluatedBaseSha))) {
    throw new TypeError('final-head-admission-invalid-publication-tuple');
  }
  if (!EVIDENCE_REVISION_RE.test(text(evaluatedEvidenceRevision))) {
    throw new TypeError('final-head-admission-invalid-evidence-revision');
  }
  if (
    typeof readCurrentTuple !== 'function'
    || typeof publishEvaluatedStatus !== 'function'
    || typeof publishPendingStatus !== 'function'
  ) {
    throw new TypeError('final-head-admission-invalid-publication-callback');
  }

  const headSha = evaluatedHeadSha.toLowerCase();
  const baseSha = evaluatedBaseSha.toLowerCase();
  const evidenceRevision = evaluatedEvidenceRevision.toLowerCase();
  const before = await readCurrentTuple();
  if (!currentTupleMatches(before, headSha, baseSha)) {
    return Object.freeze({ published: false, corrected: false, reason: 'pre-publish-drift' });
  }
  if (!currentEvidenceMatches(before, evidenceRevision)) {
    return Object.freeze({ published: false, corrected: false, reason: 'pre-publish-evidence-drift' });
  }

  await publishEvaluatedStatus();

  const after = await readCurrentTuple();
  if (after?.open !== true) {
    return Object.freeze({ published: true, corrected: false, reason: 'post-publish-closed' });
  }
  if (!currentTupleMatches(after, headSha, baseSha)) {
    await publishPendingStatus();
    return Object.freeze({ published: true, corrected: true, reason: 'post-publish-drift' });
  }
  if (!currentEvidenceMatches(after, evidenceRevision)) {
    await publishPendingStatus();
    return Object.freeze({ published: true, corrected: true, reason: 'post-publish-evidence-drift' });
  }

  return Object.freeze({ published: true, corrected: false, reason: null });
}

export function evaluateFinalHeadAdmission({
  currentBaseSha,
  reviews = [],
  ...input
} = {}) {
  if (!SHA_RE.test(text(currentBaseSha))) {
    throw new TypeError('final-head-admission-invalid-base-sha');
  }

  const baseSha = currentBaseSha.toLowerCase();
  return evaluateLegacyFinalHeadAdmission({
    ...input,
    reviews: tupleBoundReviews(reviews, input.headSha, baseSha),
    currentBaseSha: baseSha,
  });
}

export {
  FINAL_HEAD_ADMISSION_CONTEXT,
  FINAL_HEAD_ADMISSION_CHECK_NAME,
  latestReviewsByAuthor,
  latestStatuses,
} from './final-head-admission.mjs';
