/* Browser-side adapter for the purpose-built semantic-boundary endpoint.
 *
 * This module has no model name, upstream URL, prompt, or API key.  Those are
 * deliberately fixed in the Cloudflare Worker.  It is kept separate from the
 * pinpoint core so the core remains a deterministic, dependency-injected
 * verifier when this optional transport is absent.
 */
import { requestJSON } from './ai/transport.js';
import { getAuthContext } from './auth/runtime-context.js';

const ENDPOINT = '/api/semantic-rank';
const TIMEOUT_MS = 2500;
const RESPONSE_BYTES = 24 * 1024;
const METHODS = new Set(['choice', 'noul']);
const FACT_KEYS = Object.freeze([
  'id', 'size', 'decreases', 'increases', 'clamped', 'crossObject', 'scaled',
  'usedAsAmount', 'usedCross', 'usedScaled', 'functionCount', 'loadCount',
  'storeCount', 'identityKnown', 'completeness',
]);

function validCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  return FACT_KEYS.every((key) => Object.hasOwn(candidate, key));
}

/** Exported for focused transport tests; copies only the endpoint's allow-list. */
export function semanticBoundaryWireRequest({ goal, candidates, method } = {}) {
  if (!METHODS.has(method) || !goal || typeof goal.id !== 'string' || typeof goal.label !== 'string'
    || !Array.isArray(candidates) || candidates.length < 2 || candidates.length > 5
    || candidates.some((candidate) => !validCandidate(candidate))) return null;
  return {
    goal: { id: goal.id, label: goal.label },
    candidates: candidates.map((candidate) => Object.fromEntries(FACT_KEYS.map((key) => [key, candidate[key]]))),
    method,
  };
}

async function capabilityHeader() {
  try {
    const grant = await getAuthContext()?.auth?.aiCapability?.();
    return typeof grant?.capability === 'string' ? grant.capability : null;
  } catch {
    return null;
  }
}

/**
 * Return the small injected callback expected by pinpointLocation.  The mode
 * is chosen by repository code, never by a UI setting or an untrusted request.
 */
export function createSemanticBoundaryReferee({ method = 'choice', fetchImpl = globalThis.fetch, signal = null } = {}) {
  if (!METHODS.has(method)) return null;
  return async ({ goal, candidates } = {}) => {
    const body = semanticBoundaryWireRequest({ goal, candidates, method });
    if (!body) throw new Error('semantic-boundary-request-invalid');
    const capability = await capabilityHeader();
    if (!capability) throw new Error('semantic-boundary-capability-unavailable');
    return requestJSON(ENDPOINT, body, {
      signal,
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: RESPONSE_BYTES,
      fetchImpl,
      headers: { 'x-hex-ai-capability': capability },
    });
  };
}

export const __semanticBoundaryClientTest = { ENDPOINT, TIMEOUT_MS, RESPONSE_BYTES };
