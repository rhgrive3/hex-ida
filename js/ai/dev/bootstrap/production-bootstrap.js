import { DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY } from './dev-bootstrap-gate.js';
import { publishBootstrapDiagnostic } from './bootstrap-diagnostic.js';
import { readDevBootstrapRequested, readEmbedGeneration } from '../../../userscript/embed-bootstrap.js';
import { runtimeHostSnapshotFromGlobals, runtimeLocationFromSnapshot } from '../../../userscript/runtime-host-location.js';

const HOST_PROTOCOL = 'hex.dev.bootstrap-host-v1';
const PARENT_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
const HANDOFF_TIMEOUT_MS = 2500;
const PREFLIGHT_PROMPT = `HEX DEV SUPERVISOR PROTOCOL hex-dev-supervisor-v1\n\nRound 4 production bootstrap checkpoint preflight.\nDo not use any tool. Return exactly this single JSON object and nothing else:\n{"type":"final","answer":"bootstrap checkpoint ready","completedTasks":["checkpoint-preflight"],"remaining":["reload-and-proof"]}`;

export async function runProductionDevBootstrap({
  engine,
  session,
  bridge = globalThis.__HEX_CHATGPT_BRIDGE__,
  globalObject = globalThis,
  parentOrigin = null,
} = {}) {
  if (!engine?.devBootstrap || !session?.current || !bridge?.request) return status(globalObject, 'skipped', { reason: 'bootstrap-runtime-unavailable' });
  if (!isSandboxChild(globalObject)) return status(globalObject, 'skipped', { reason: 'not-sandbox-child' });
  const runtimeLocation = productionRuntimeLocation(globalObject);
  if (!readDevBootstrapRequested(runtimeLocation)) return status(globalObject, 'skipped', { reason: 'production-bootstrap-disabled' });

  status(globalObject, 'running', { phase: 'bootstrap' });
  try {
    const parentState = await requestParentState(globalObject, { parentOrigin });
    const verifiedParentOrigin = parentState.__parentOrigin || parentOrigin;
    const identity = normalizeIdentity(parentState.runtimeIdentity);
    await engine.devBootstrap.prepare();

    if (parentState.handoff) {
      const restored = engine.devBootstrap.restore(parentState.handoff);
      const activated = engine.devBootstrap.activateAtSafeBoundary({
        checkpoint: restored.checkpoint,
        activeIdentity: identity,
        reinitialized: true,
      });
      if (activated.status !== 'active') throw new Error(`Unexpected bootstrap activation status: ${activated.status}`);
      const proof = await engine.devBootstrap.runProof({
        handoff: restored,
        model: session.current.model || null,
        reasoning: session.current.reasoning || null,
      });
      return status(globalObject, 'complete', {
        identity,
        extensionVersion: activated.extensionVersion,
        integrity: activated.integrity,
        capability: DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY,
        proofAnswer: String(proof?.answer || ''),
      });
    }

    const hexConversationId = requirePrimitiveText(session.current.id, 'Bootstrap Hex conversation identity');
    const checkpointSession = engine.devBootstrap.sessionFor(hexConversationId);
    const conversation = await establishSupervisorConversation(bridge, checkpointSession.supervisorSessionKey, session.current);
    const checkpoint = engine.devBootstrap.createCheckpoint({
      conversationId: hexConversationId,
      chatgptConversationId: conversation.id,
      activeIdentity: identity,
      pendingTask: { type: 'round4-bootstrap', step: 'resume-proof', hexConversationId },
    });
    const reload = engine.devBootstrap.activateAtSafeBoundary({ checkpoint, activeIdentity: identity, reinitialized: false });
    if (reload.status !== 'reload-required') throw new Error(`Unexpected bootstrap staging status: ${reload.status}`);
    await requestParentReload(globalObject, reload.handoff, { parentOrigin: verifiedParentOrigin });
    return status(globalObject, 'reload-requested', { identity, checkpoint: reload.handoff.checkpoint });
  } catch (error) {
    return status(globalObject, 'failed', { error: String(error?.message || error || 'bootstrap failed').slice(0, 512) });
  }
}

async function establishSupervisorConversation(bridge, sessionKey, selection) {
  let response = await bridge.request(PREFLIGHT_PROMPT, {
    sessionKey,
    model: selection?.model || null,
    reasoning: selection?.reasoning || null,
  });
  let conversation = normalizeConversation(response?.conversation || bridge.conversationFor?.(sessionKey));
  if (conversation) return conversation;

  response = await bridge.request(PREFLIGHT_PROMPT, {
    sessionKey,
    model: selection?.model || null,
    reasoning: selection?.reasoning || null,
  });
  conversation = normalizeConversation(response?.conversation || bridge.conversationFor?.(sessionKey));
  if (!conversation) throw new Error('Bootstrap Supervisor conversation did not acquire a concrete ChatGPT identity.');
  return conversation;
}

const DEFAULT_PARENT_ORIGIN = 'https://chatgpt.com';

function parseConcreteHttpOrigin(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed.startsWith('file:')) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function resolveParentTargetOrigin(globalObject, options = {}) {
  const explicit = options?.parentOrigin ?? safeRead(globalObject, '__HEX_EMBED_PARENT_ORIGIN__');
  if (explicit != null && String(explicit).trim() !== '') {
    const origin = parseConcreteHttpOrigin(String(explicit));
    if (!origin || !PARENT_ORIGINS.has(origin)) {
      throw new Error('Bootstrap parent origin is untrusted.');
    }
    return origin;
  }

  const candidates = [
    safeRead(safeRead(globalObject, 'document'), 'referrer'),
    safeRead(safeRead(safeRead(globalObject, 'location'), 'ancestorOrigins'), 0),
    safeRead(safeRead(globalObject, 'location'), 'origin'),
  ];
  for (const candidate of candidates) {
    const origin = parseConcreteHttpOrigin(candidate);
    if (!origin) continue;
    if (!PARENT_ORIGINS.has(origin)) {
      throw new Error('Bootstrap parent origin is untrusted.');
    }
    return origin;
  }

  return DEFAULT_PARENT_ORIGIN;
}

function requestParentState(globalObject, options = {}) {
  return exchangeWithParent(globalObject, 'hex.dev.bootstrap.handoff-request', 'hex.dev.bootstrap.handoff-response', {}, options);
}

function requestParentReload(globalObject, handoff, options = {}) {
  return exchangeWithParent(globalObject, 'hex.dev.bootstrap.reload-request', 'hex.dev.bootstrap.reload-accepted', { handoff }, options);
}

function exchangeWithParent(globalObject, requestType, responseType, payload, options = {}) {
  const generation = String(readEmbedGeneration(productionRuntimeLocation(globalObject)) || '').trim();
  const sandboxToken = String(globalObject.__HEX_EMBED_SANDBOX_TOKEN__ || '').trim().toLowerCase();
  if (!generation || !sandboxToken) return Promise.reject(new Error('Bootstrap sandbox identity is unavailable.'));
  const parent = globalObject.parent;
  if (!parent || parent === globalObject) return Promise.reject(new Error('Bootstrap parent realm is unavailable.'));

  let targetOrigin;
  try {
    targetOrigin = resolveParentTargetOrigin(globalObject, options);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      globalObject.removeEventListener('message', onMessage);
      if (timer !== null) clearTimeout(timer);
    };
    const finish = (error, value) => {
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    function onMessage(event) {
      if (event?.source !== parent || !PARENT_ORIGINS.has(event?.origin)) return;
      const data = event?.data;
      if (!data || typeof data !== 'object' || data.protocol !== HOST_PROTOCOL || data.type !== responseType) return;
      if (String(data.generation || '') !== generation) return;
      if (String(data.sandboxToken || '').toLowerCase() !== sandboxToken) return;
      finish(null, { ...data, __parentOrigin: event.origin });
    }
    globalObject.addEventListener('message', onMessage);
    timer = setTimeout(() => finish(new Error(`Bootstrap parent response timeout: ${responseType}`)), HANDOFF_TIMEOUT_MS);
    try {
      parent.postMessage({ protocol: HOST_PROTOCOL, type: requestType, generation, sandboxToken, ...payload }, targetOrigin);
    } catch (error) {
      finish(error);
    }
  });
}

function normalizeConversation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string') return null;
  const id = value.id.trim();
  if (!id) return null;
  return Object.freeze({ id });
}

function normalizeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Production runtime identity is unavailable.');
  const commit = requirePrimitiveText(value.commit, 'Production deployment commit identity').toLowerCase();
  const buildId = requirePrimitiveText(value.buildId, 'Production runtime build identity').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Production deployment commit identity is unavailable.');
  if (!/^[0-9a-f]{24}$/.test(buildId)) throw new Error('Production runtime build identity is unavailable.');
  return Object.freeze({ commit, buildId });
}

function requirePrimitiveText(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  const text = value.trim();
  if (!text) throw new TypeError(`${label} is unavailable.`);
  return text;
}

function isSandboxChild(globalObject) {
  try { return !!globalObject.parent && globalObject.parent !== globalObject && String(globalObject.location?.origin || '') === 'null'; }
  catch { return false; }
}

function productionRuntimeLocation(globalObject) {
  return runtimeLocationFromSnapshot(
    runtimeHostSnapshotFromGlobals(globalObject),
    safeRead(globalObject, 'location'),
    safeRead(globalObject, 'document'),
  );
}

function safeRead(value, key) {
  try { return value?.[key]; } catch { return null; }
}

function status(globalObject, state, details = {}) {
  const value = Object.freeze({ state, at: new Date().toISOString(), ...details });
  try { globalObject.__HEX_DEV_BOOTSTRAP_STATUS__ = value; } catch {}
  try { publishBootstrapDiagnostic(globalObject, value); } catch {}
  return value;
}
