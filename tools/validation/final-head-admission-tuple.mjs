import { evaluateFinalHeadAdmission as evaluateLegacyFinalHeadAdmission } from './final-head-admission.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;

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
