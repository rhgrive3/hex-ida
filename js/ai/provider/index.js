import { AIError } from '../schema.js';
import { requestJSON } from '../transport.js';
import { validateModelDecision } from '../validation.js';
import { SAFE_PROVIDER_CAPABILITIES } from '../budget/wire.js';

export class AIProvider {
  constructor({ capabilities } = {}) { this.capabilities = { ...SAFE_PROVIDER_CAPABILITIES, ...(capabilities || {}) }; }
  getCapabilities() { return { ...this.capabilities }; }
  turnTimeoutMs(mode) { return mode === 'agent' ? 120000 : 30000; }
  async prepareCapabilities() { return this.getCapabilities(); }
  async nextTurn() { throw new AIError('provider_error', 'AIProvider.nextTurn is not implemented.'); }
  async streamTurn() { throw new AIError('provider_error', 'Streaming is not implemented by this provider.'); }
  cancel() {}
}

export class WorkerAIProvider extends AIProvider {
  constructor({ endpoint = '/api/ai/turn', capabilitiesEndpoint = null, fetchImpl = globalThis.fetch, timeoutMs = 110000, capabilities = {} } = {}) {
    // Before the first Worker response reveals the selected inference adapter,
    // use the conservative envelope-safe limit. A quota-free preflight normally
    // replaces this with the server-derived provider-aware limit before turn 1.
    super({ capabilities: { provider: 'worker', contextTokens: 32768, maxOutputTokens: 8192, maxTools: 10, maxRequestBytes: 64 * 1024, ...capabilities } });
    this.endpoint = endpoint;
    this.capabilitiesEndpoint = capabilitiesEndpoint || deriveCapabilitiesEndpoint(endpoint);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.controllers = new Set();
    this.capabilitiesPrepared = false;
    this.capabilitiesPromise = null;
    this.capabilitiesController = null;
    this.capabilitiesWaiters = 0;
    // Server capability truth: /api/ai/capabilities answers { configured, capabilities }.
    // null means the preflight has not succeeded yet; it must never be read as
    // "configured". (#5086)
    this.configured = null;
  }

  isConfigured() { return this.configured; }

  async prepareCapabilities(options = {}) {
    if (this.capabilitiesPrepared) return this.getCapabilities();
    if (options.signal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
    // A malformed truthy signal must fail fast here, before the shared fetch
    // starts and before any waiter is counted. Otherwise one bad caller leaks
    // a ghost waiter that permanently breaks single-flight cancellation. (#5144)
    assertAbortSignal(options.signal);
    if (!this.capabilitiesPromise) {
      const controller = new AbortController();
      this.capabilitiesController = controller;
      const promise = this.#loadCapabilities({ timeoutMs: options.timeoutMs, signal: controller.signal })
        .finally(() => {
          if (this.capabilitiesPromise === promise) this.capabilitiesPromise = null;
          if (this.capabilitiesController === controller) this.capabilitiesController = null;
        });
      this.capabilitiesPromise = promise;
    }
    return this.#waitForCapabilities(this.capabilitiesPromise, options.signal);
  }

  #waitForCapabilities(promise, signal) {
    // Defense in depth: the waiter count is the cancellation accounting, so no
    // waiter may be added for a signal that cannot participate in it. (#5144)
    assertAbortSignal(signal);
    this.capabilitiesWaiters += 1;
    let released = false;
    const release = (cancelled = false) => {
      if (released) return;
      released = true;
      this.capabilitiesWaiters = Math.max(0, this.capabilitiesWaiters - 1);
      if (cancelled && this.capabilitiesWaiters === 0 && this.capabilitiesPromise === promise) {
        this.capabilitiesController?.abort(signal?.reason ?? 'cancelled');
      }
    };
    if (!signal) return promise.finally(() => release(false));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        release(true);
        reject(new AIError('cancelled', 'AI investigation was cancelled.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          release(false);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          release(false);
          reject(error);
        },
      );
    });
  }

  async #loadCapabilities(options = {}) {
    if (options.signal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
    if (typeof this.fetchImpl !== 'function') { this.capabilitiesPrepared = true; return this.getCapabilities(); }
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason ?? 'cancelled');
    const timeout = setTimeout(() => controller.abort('timeout'), Math.max(1, Math.min(Number(options.timeoutMs) || 5000, 5000)));
    if (options.signal) { options.signal.addEventListener('abort', onAbort, { once: true }); if (options.signal.aborted) onAbort(); }
    this.controllers.add(controller);
    try {
      const response = await this.fetchImpl(this.capabilitiesEndpoint, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
      if (!response?.ok) { this.capabilitiesPrepared = true; return this.getCapabilities(); }
      // The 64 KiB envelope is a hard read cap, not a post-hoc adoption check:
      // stop (and cancel) at the limit instead of materializing the whole body
      // and re-encoding it afterwards. (#5089)
      const text = await readBoundedCapabilityText(response, MAX_CAPABILITY_BYTES);
      if (text == null) { this.capabilitiesPrepared = true; return this.getCapabilities(); }
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* conservative fallback below */ }
      // The top-level configured flag is server capability truth. Merge the
      // budget envelope as before, but also retain configured so availability
      // reporting stays consistent with the next-turn 503 contract. (#5086)
      if (typeof payload?.configured === 'boolean') this.configured = payload.configured;
      if (payload?.capabilities && typeof payload.capabilities === 'object') this.capabilities = { ...this.capabilities, ...payload.capabilities };
      this.capabilitiesPrepared = true;
      return this.getCapabilities();
    } catch (error) {
      if (options.signal?.aborted || (controller.signal.aborted && controller.signal.reason !== 'timeout')) throw new AIError('cancelled', 'AI investigation was cancelled.');
      // Capability discovery must not make the provider unavailable. A failed or
      // timed-out preflight falls back to the conservative built-in budget.
      this.capabilitiesPrepared = true;
      return this.getCapabilities();
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }

  async nextTurn(request, options = {}) {
    if (options.signal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason ?? 'cancelled');
    if (options.signal) { options.signal.addEventListener('abort', onAbort, { once: true }); if (options.signal.aborted) onAbort(); }
    this.controllers.add(controller);
    try {
      if (controller.signal.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');
      const response = await requestJSON(this.endpoint, {
        sessionId: request.sessionId || null,
        mode: request.mode,
        style: request.style,
        scope: request.effectiveScope || request.scope,
        requestedScope: request.requestedScope || request.scope,
        effectiveScope: request.effectiveScope || request.scope,
        intent: request.intent || null,
        task: request.task || null,
        messages: request.messages || [],
        context: request.context || {},
        tools: request.tools || [],
        responseSchema: request.responseSchema || null,
      }, { signal: controller.signal, timeoutMs: options.timeoutMs || this.timeoutMs, fetchImpl: this.fetchImpl });
      if (response.capabilities && typeof response.capabilities === 'object') this.capabilities = { ...this.capabilities, ...response.capabilities };
      return validateModelDecision(response.decision, (request.tools || []).map((tool) => tool.name));
    } finally {
      this.controllers.delete(controller);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }

  cancel() { for (const controller of this.controllers) controller.abort('cancelled'); this.controllers.clear(); }
}

function deriveCapabilitiesEndpoint(endpoint) {
  const value = String(endpoint || '/api/ai/turn');
  return value.endsWith('/turn') ? `${value.slice(0, -5)}/capabilities` : '/api/ai/capabilities';
}

const MAX_CAPABILITY_BYTES = 64 * 1024;

function assertAbortSignal(signal) {
  if (signal == null) return;
  if (
    typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function'
  ) {
    throw new AIError('invalid_tool_call', 'The capability preflight signal is not an AbortSignal.');
  }
}

/*
 * Bounded capability-body reader shared in spirit with transport.js
 * readBoundedText: Content-Length short-circuits before any read, streaming
 * bodies are byte-counted and cancelled at the limit, and only non-streaming
 * (test/polyfill) responses fall back to materialize-then-measure. Returns the
 * decoded text, or null when the body exceeds maxBytes. (#5089)
 */
async function readBoundedCapabilityText(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { await response.body?.cancel?.('response-too-large'); } catch { /* best effort */ }
    return null;
  }
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          try { await reader.cancel('response-too-large'); } catch { /* best effort */ }
          return null;
        }
        parts.push(decoder.decode(chunk, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join('');
    } finally {
      try { reader.releaseLock(); } catch { /* already cancelled */ }
    }
  }
  const text = typeof response.text === 'function' ? await response.text() : '';
  return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
}
