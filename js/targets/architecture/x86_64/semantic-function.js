import {
  analyzeDecodedSemanticFunction as analyzeSharedSemanticFunction,
  partitionDecodedFunction,
  semanticAbiAdapter,
} from '../../../analysis/semantic-function.js';
import { X86_SEMANTIC_FUNCTION_ANALYSIS_VERSION } from './semantic-function-contract.js';
import { hasReceiverRevalidatedX86Row } from './runtime-provenance.js';

let decoderRevalidationWorker = null;
let decoderRevalidationSequence = 1;
const decoderRevalidationPending = new Map();

function isDedicatedWorkerRealm() {
  return typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;
}

export function x86SemanticFunctionRequiresDecoderRevalidation(input = {}) {
  if (String(input.architecture ?? 'x86_64') !== 'x86_64') return false;
  const rows = input.instructions;
  if (!Array.isArray(rows) || rows.length === 0) return true;
  return !rows.every((row) => hasReceiverRevalidatedX86Row(row));
}

function revalidationAbortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error('x86-semantic-function-decoder-revalidation-cancelled');
  error.name = 'AbortError';
  return error;
}

function rejectDecoderRevalidation(error) {
  for (const pending of decoderRevalidationPending.values()) pending.reject(error);
  decoderRevalidationPending.clear();
  try { decoderRevalidationWorker?.terminate?.(); } catch { /* best effort */ }
  decoderRevalidationWorker = null;
}

function decoderWorker() {
  if (decoderRevalidationWorker) return decoderRevalidationWorker;
  if (typeof Worker !== 'function') throw new Error('x86-semantic-function-decoder-revalidation-unavailable');
  const configured = globalThis.__HEX_X86_SEMANTIC_REVALIDATION_WORKER_URL__;
  const workerURL = typeof configured === 'string' && configured
    ? configured
    : new URL('./semantic-revalidation-worker.js', import.meta.url);
  const worker = new Worker(workerURL);
  worker.onmessage = (event) => {
    const message = event.data;
    const pending = decoderRevalidationPending.get(message?.id);
    if (!pending) return;
    decoderRevalidationPending.delete(message.id);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(new Error(message?.error || 'x86-semantic-function-decoder-revalidation-failed'));
  };
  const failed = (event) => rejectDecoderRevalidation(
    event?.error instanceof Error ? event.error : new Error(event?.message || 'x86-semantic-function-decoder-revalidation-worker-failed'),
  );
  worker.onerror = failed;
  worker.onmessageerror = failed;
  decoderRevalidationWorker = worker;
  return worker;
}

function analyzeViaDecoderRevalidation(input, options = {}) {
  const signal = options.signal ?? null;
  if (signal?.aborted) return Promise.reject(revalidationAbortError(signal.reason));
  const worker = decoderWorker();
  const id = decoderRevalidationSequence++;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener?.('abort', abort);
    const settle = (fn) => (value) => { cleanup(); fn(value); };
    const abort = () => {
      if (!decoderRevalidationPending.delete(id)) return;
      try { worker.postMessage({ t:'cancel', id }); } catch { /* local rejection is authoritative */ }
      cleanup();
      reject(revalidationAbortError(signal?.reason));
    };
    decoderRevalidationPending.set(id, { resolve:settle(resolve), reject:settle(reject) });
    signal?.addEventListener?.('abort', abort, { once:true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      worker.postMessage({ t:'semanticFunction', id, input, priority:'current' });
    } catch (error) {
      decoderRevalidationPending.delete(id);
      cleanup();
      reject(error);
    }
  });
}

/**
 * x86-64 entry point for the shared semantic-function route.
 *
 * Phase 5 introduced this module as the only caller of the shared pipeline.
 * Phase 6 moved the driver itself to js/analysis/semantic-function.js so that
 * RISC-V64 travels the identical code, and this file remains the stable x86
 * seam: it supplies x86 defaults and, in the platform Worker realm, restores
 * decoder authority by independently re-decoding transported rows before the
 * shared pipeline can mint exact MachineEffects.
 */
export { X86_SEMANTIC_FUNCTION_ANALYSIS_VERSION as SEMANTIC_FUNCTION_ANALYSIS_VERSION };
export { partitionDecodedFunction, semanticAbiAdapter };

export function analyzeDecodedSemanticFunction(input = {}, options = {}) {
  const normalized = {
    ...input,
    architecture: input.architecture ?? 'x86_64',
    analysisVersion: input.analysisVersion ?? X86_SEMANTIC_FUNCTION_ANALYSIS_VERSION,
  };
  if (String(normalized.architecture) === 'x86_64'
      && isDedicatedWorkerRealm()
      && x86SemanticFunctionRequiresDecoderRevalidation(normalized)) {
    return analyzeViaDecoderRevalidation(normalized, options);
  }
  return analyzeSharedSemanticFunction(normalized, options);
}
