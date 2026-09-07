import { composePrompt } from '../prompts/compose.js';
import { clientSafeCapabilities, resolveInferenceAdapter } from './worker-adapters.js';
import { finalResultTool, normalizeAIInteraction, normalizeAITurnRequest, promptWorkbench } from './worker-protocol.js';
import {
  acquireDistributedQuota, byteLength, HttpError, isJsonRequest, isRetryableUpstreamFailure,
  jsonError, jsonResponse, MAX_CONTEXT_CHARS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_UPSTREAM_ATTEMPTS,
  readLimitedText, readUpstreamFailure, releaseDistributedQuota, REQUEST_TIMEOUT_MS,
  upstreamError, waitForRetry,
} from './worker-transport.js';

export function handleAICapabilities(request, env) {
  if (request.method !== 'GET') return jsonError(405, 'method_not_allowed', 'Only GET is allowed.', { Allow: 'GET' });
  const adapter = resolveInferenceAdapter(env);
  return jsonResponse({ configured: adapter.configured, capabilities: clientSafeCapabilities(adapter.capabilities) });
}

export async function handleAITurn(request, env) {
  if (request.method !== 'POST') return jsonError(405, 'method_not_allowed', 'Only POST is allowed.', { Allow: 'POST' });
  if (!isJsonRequest(request)) return jsonError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
  const adapter = resolveInferenceAdapter(env);
  if (!adapter.configured) return jsonError(503, 'service_not_configured', `The ${adapter.id} analysis service is not configured.`);

  let incoming;
  try { incoming = JSON.parse(await readLimitedText(request, MAX_REQUEST_BYTES)); }
  catch (error) { return error instanceof HttpError ? jsonError(error.status, error.code, error.message) : jsonError(400, 'invalid_json', 'The request body must contain valid JSON.'); }
  let payload;
  try { payload = normalizeAITurnRequest(incoming); }
  catch (error) { return error instanceof HttpError ? jsonError(error.status, error.code, error.message) : jsonError(400, 'invalid_request', 'The AI turn request is invalid.'); }

  const quota = await acquireDistributedQuota(request, env, payload.sessionId);
  if (quota.response) return quota.response;
  let quotaReleased = false;
  const releaseQuota = async () => { if (quotaReleased) return; quotaReleased = true; await releaseDistributedQuota(quota.lease); };
  const upstreamAbort = new AbortController();
  const timeout = setTimeout(() => upstreamAbort.abort(new Error('AI turn timed out.')), REQUEST_TIMEOUT_MS);
  const abortOnDisconnect = () => upstreamAbort.abort(new Error('Client disconnected.'));
  request.signal.addEventListener('abort', abortOnDisconnect, { once: true });
  if (request.signal.aborted) abortOnDisconnect();
  const cleanup = async () => { clearTimeout(timeout); request.signal.removeEventListener('abort', abortOnDisconnect); await releaseQuota(); };
  if (upstreamAbort.signal.aborted) {
    await cleanup();
    return jsonError(499, 'client_cancelled', 'The client disconnected before the provider request started.');
  }

  const prompt = composePrompt({
    mode: payload.mode, style: payload.style, scope: payload.effectiveScope,
    question: payload.goal, task: payload.task, intent: payload.intent,
    context: promptWorkbench(payload.context),
  });
  const tools = [...payload.tools, finalResultTool()];
  const upstreamRequest = adapter.build({ payload, systemInstruction: prompt.system, tools });
  const upstreamBody = JSON.stringify(upstreamRequest);
  const upstreamLimit = positiveLimit(adapter.capabilities.maxRequestBytes, MAX_CONTEXT_CHARS);
  if (byteLength(upstreamBody) > upstreamLimit) {
    await cleanup();
    return jsonError(413, 'request_too_large', 'The provider request exceeds its configured transport limit.');
  }

  let upstream = null;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt++) {
    try {
      upstream = await fetch(adapter.endpoint, { method: 'POST', headers: adapter.headers, body: upstreamBody, signal: upstreamAbort.signal });
    } catch {
      if (upstreamAbort.signal.aborted) { await cleanup(); return jsonError(504, 'upstream_timeout', 'The analysis service did not respond in time.'); }
      if (attempt === MAX_UPSTREAM_ATTEMPTS) { await cleanup(); return jsonError(502, 'upstream_unavailable', 'The analysis service could not be reached after retrying.'); }
      if (!await waitForRetry(attempt, null, upstreamAbort.signal)) { await cleanup(); return jsonError(504, 'upstream_timeout', 'The analysis service did not respond in time.'); }
      continue;
    }
    if (upstream.ok) break;
    const failure = await readUpstreamFailure(upstream, responseByteLimit(adapter));
    if (!isRetryableUpstreamFailure(upstream.status, failure.code) || attempt === MAX_UPSTREAM_ATTEMPTS) { await cleanup(); return upstreamError(upstream.status, failure.code, upstream.headers.get('retry-after')); }
    if (!await waitForRetry(attempt, upstream.headers.get('retry-after'), upstreamAbort.signal)) { await cleanup(); return jsonError(504, 'upstream_timeout', 'The analysis service did not respond in time.'); }
  }
  if (!upstream?.ok) { await cleanup(); return jsonError(502, 'upstream_error', 'The analysis service returned an unexpected error.'); }
  let interaction;
  // The provider response is untrusted transport input: materialize it under
  // the same class of byte ceiling the request path enforces (#6144).
  try { interaction = adapter.normalize(JSON.parse(await readLimitedText(upstream, responseByteLimit(adapter)))); }
  catch {
    // readLimitedText can reject on Content-Length before it acquires a reader.
    // Close that still-unconsumed upstream body before releasing the request
    // quota so an oversized response cannot keep its transport alive (#6144).
    try { await upstream.body?.cancel(); } catch {}
    await cleanup();
    return jsonError(502, 'invalid_model_output', 'The model returned malformed JSON.');
  }
  await cleanup();
  try {
    const decision = normalizeAIInteraction(interaction, payload.tools.map((tool) => tool.name));
    return jsonResponse({ decision, capabilities: clientSafeCapabilities(adapter.capabilities) });
  } catch (error) {
    return jsonError(502, 'invalid_model_output', error?.message || 'The model response did not follow the Hex turn protocol.');
  }
}

function positiveLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Worker-owned transport ceiling for a single upstream response body. It is
// deliberately independent of provider generation limits: HTTP errors, proxies,
// and malformed providers never renegotiate this boundary (#6144).
function responseByteLimit(adapter) {
  const maxOutputTokens = Number(adapter?.capabilities?.maxOutputTokens);
  const tokenEnvelope = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens * 16 : 0;
  return Math.max(tokenEnvelope, MAX_RESPONSE_BYTES);
}
