const RECEIVER_REVALIDATED_ROWS = new WeakSet();
const REVALIDATION_WORKER_PATH = '/js/targets/architecture/x86_64/semantic-revalidation-worker.js';
const PROTECTED_LOGICAL_PATH = 'js/targets/architecture/x86_64/semantic-revalidation-worker.js';

function isReceiverRevalidationRealm() {
  if (typeof WorkerGlobalScope === 'undefined' || !(globalThis instanceof WorkerGlobalScope)) return false;
  if (globalThis.__HEX_PROTECTED_WORKER_LOGICAL_PATH__ === PROTECTED_LOGICAL_PATH) return true;
  try {
    const href = globalThis.location?.href;
    if (typeof href !== 'string') return false;
    return new URL(href).pathname.endsWith(REVALIDATION_WORKER_PATH);
  } catch {
    return false;
  }
}

/**
 * Mint receiver-side decoder authority only inside the dedicated revalidation
 * worker. The public structured parser intentionally cannot mint this brand:
 * callers may supply arbitrary parser-like objects to it in tests/tools.
 */
export function markReceiverRevalidatedX86Row(row) {
  if (!isReceiverRevalidationRealm()) {
    throw new TypeError('x86-decoder-runtime-provenance-mint-outside-revalidation-worker');
  }
  if (row == null || (typeof row !== 'object' && typeof row !== 'function')) {
    throw new TypeError('x86-decoder-runtime-provenance-row-required');
  }
  RECEIVER_REVALIDATED_ROWS.add(row);
  return row;
}

export function hasReceiverRevalidatedX86Row(row) {
  return row != null
    && (typeof row === 'object' || typeof row === 'function')
    && RECEIVER_REVALIDATED_ROWS.has(row);
}
