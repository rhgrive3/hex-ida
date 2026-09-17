// Shared wire identity: worker entrypoints must not import their host transport.
export const WORKER_BACKEND_ID = 'hex-exhaustive-bv-worker';
export const WORKER_BACKEND_VERSION = '1.0.0';
export const TIERED_WORKER_BACKEND_ID = 'hex-tiered-qfbv-worker';
export const TIERED_WORKER_BACKEND_VERSION = '1.0.0';

const CANONICAL_REQUEST_ID = /^(?:0|[1-9][0-9]*)$/;

export function isCanonicalRequestId(value) {
  return typeof value === 'string' && CANONICAL_REQUEST_ID.test(value);
}
