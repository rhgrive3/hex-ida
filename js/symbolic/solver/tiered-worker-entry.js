/**
 * Module Worker entrypoint for the browser-safe tiered exact solver.
 * No binary/project data leaves this worker; only a serialized Hex query and
 * a normalized SolverResult cross the message boundary.
 */

import { TieredBvBackend } from './tiered-backend.js';
import { TIERED_WORKER_BACKEND_ID, TIERED_WORKER_BACKEND_VERSION } from './tiered-worker-backend.js';
import { solverResultToTransport } from './result.js';

const backend = new TieredBvBackend({
  id: TIERED_WORKER_BACKEND_ID,
  version: TIERED_WORKER_BACKEND_VERSION,
});
const session = backend.createSession({ timeoutMs: 0 });

self.onmessage = async (event) => {
  const message = event?.data || {};
  if (message.type === 'solver-cancel') {
    await session.cancel();
    return;
  }
  if (message.type !== 'solver-check') return;
  const result = await session.check(message.query, { ...(message.options || {}), timeoutMs: 0 });
  self.postMessage({ type: 'solver-result', requestId: String(message.requestId), token: message.token, result: solverResultToTransport(result) });
};
