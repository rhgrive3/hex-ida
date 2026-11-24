import { isX87Instruction, isX87RflagsInstruction } from './effects/extended-state-helpers.js';
import {
  hasReceiverRevalidatedX86Row,
  registerReceiverRevalidatedX86Row,
} from './receiver-provenance.js';

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

function lockProtectedWorkerLogicalPath() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__HEX_PROTECTED_WORKER_LOGICAL_PATH__');
  if (descriptor && !descriptor.configurable) return;
  try {
    Object.defineProperty(globalThis, '__HEX_PROTECTED_WORKER_LOGICAL_PATH__', {
      value: descriptor ? descriptor.value : undefined,
      writable: false,
      enumerable: Boolean(descriptor?.enumerable),
      configurable: false,
    });
  } catch {
    // globalThis may already be non-extensible or frozen.
  }
}

const RECEIVER_REVALIDATION_REALM = isReceiverRevalidationRealm();
lockProtectedWorkerLogicalPath();

/**
 * Attach Capstone's union-domain discriminator after receiver-side byte
 * revalidation. This is evidence normalization only: it never mints runtime
 * provenance, and an existing decoder-supplied discriminator is preserved so
 * a disagreement remains fail-closed in the trusted terminalizer.
 */
export function withReceiverX86FlagDomainEvidence(row) {
  const detail = row?.detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return row;
  if (Object.hasOwn(detail, 'flagsKind')) return row;
  const isX87 = isX87Instruction(row);
  const flagsKind = isX87 && !isX87RflagsInstruction(row) ? 'fpu-flags' : 'eflags';
  return Object.freeze({ ...row, detail:Object.freeze({ ...detail, flagsKind }) });
}

/**
 * Mint receiver-side decoder authority only inside the dedicated revalidation
 * worker. The public structured parser intentionally cannot mint this brand:
 * callers may supply arbitrary parser-like objects to it in tests/tools.
 */
export function markReceiverRevalidatedX86Row(row) {
  if (!RECEIVER_REVALIDATION_REALM || !isReceiverRevalidationRealm()) {
    throw new TypeError('x86-decoder-runtime-provenance-mint-outside-revalidation-worker');
  }
  if (row == null || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('x86-decoder-runtime-provenance-row-required');
  }
  const receiverRow = withReceiverX86FlagDomainEvidence(row);
  return registerReceiverRevalidatedX86Row(receiverRow);
}

export { hasReceiverRevalidatedX86Row };
