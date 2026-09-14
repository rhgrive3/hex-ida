const CANONICAL_REQUEST_ID = /^(?:0|[1-9][0-9]*)$/;

export function isCanonicalRequestId(value) {
  return typeof value === 'string' && CANONICAL_REQUEST_ID.test(value);
}
