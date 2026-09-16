import { installChatGPTWebBridge } from './chatgpt-bridge.js';
import { createRpcServer } from './embed-protocol.js';

const BRIDGE_ERROR_CODE = 'CHATGPT_PARENT_RPC_ERROR';
const INVALID_PARAMS_CODE = 'RPC_INVALID_PARAMS';
const UNSAFE_RESULT_CODE = 'RPC_UNSAFE_RESULT';
const MAX_WIRE_DEPTH = 64;
const MAX_ARRAY_INDEX = 2 ** 32 - 2;
/*
 * #8773 — the parent→sandbox RPC must be an explicit bounded transport, not just
 * a depth guard. Page-derived bridge data (assistant text, DOM state, adapter
 * output) crosses into the protected Hex runtime and is structured-cloned through
 * a MessagePort, so a per-container node budget and an aggregate UTF-8 byte budget
 * stop oversized results *before* they are copied or cloned. These ceilings are far
 * above any realistic ChatGPT turn/response/status/capabilities payload; the
 * 32 MiB page-derived text from the reproduction is rejected at the boundary.
 */
const MAX_WIRE_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_WIRE_RESULT_NODES = 256 * 1024;
const MAX_WIRE_CHILDREN = 65536;
const SENSITIVE_ERROR_TEXT = /(?:\bcookie\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bGM\.|querySelector|querySelectorAll|\[data-|#prompt-textarea|\bdocument\.|\bwindow\.)/i;
const URL_TEXT = /https?:\/\/[^\s]+/gi;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function createChatGPTParentRpc({ port, bridge, onUiClose } = {}) {
  const authority = bridge ?? installChatGPTWebBridge();
  const methods = bindBridgeMethods(authority);
  if (onUiClose != null && typeof onUiClose !== 'function') {
    throw new TypeError('onUiClose must be a function when provided.');
  }

  const handlers = Object.create(null);

  handlers['chatgpt.request'] = (params, context) => invokeBridge('chatgpt.request', async () => {
    const request = normalizeRequestParams(params);
    return methods.request(request.prompt, {
      signal: context.signal,
      timeoutMs: request.timeoutMs,
      sessionKey: request.sessionKey,
      model: request.model,
      reasoning: request.reasoning,
    });
  });

  handlers['chatgpt.cancel'] = (_params, _context) => invokeBridge('chatgpt.cancel', async () => {
    await methods.cancel();
    return null;
  });

  handlers['chatgpt.capabilities'] = (_params, context) => invokeBridge('chatgpt.capabilities', () => (
    methods.capabilities({ signal: context.signal })
  ));

  handlers['chatgpt.getSelection'] = () => invokeBridge('chatgpt.getSelection', () => methods.getSelection());

  handlers['chatgpt.setSelection'] = (params, context) => invokeBridge('chatgpt.setSelection', () => {
    const selection = normalizeSelectionParams(params);
    return methods.setSelection(selection, { signal: context.signal });
  });

  handlers['chatgpt.status'] = () => invokeBridge('chatgpt.status', () => methods.status());

  handlers['chatgpt.conversationFor'] = (params) => invokeBridge('chatgpt.conversationFor', () => (
    methods.conversationFor(normalizeNullableStringField(params, 'sessionKey'))
  ));

  handlers['ui.close'] = () => invokeBridge('ui.close', async () => {
    await onUiClose?.();
    return null;
  });

  const server = createRpcServer(port, { handlers });
  return Object.freeze({
    close() { server.close('ChatGPT parent RPC closed.'); },
  });
}

async function invokeBridge(method, operation) {
  try {
    return sanitizeWireValue(await operation(), 0, new WeakSet(), { bytes: 0, nodes: 0 });
  } catch (error) {
    if (error instanceof ChatGPTParentRpcError) throw error;
    throw safeBridgeError(error, method);
  }
}

function bindBridgeMethods(bridge) {
  if (!bridge || (typeof bridge !== 'object' && typeof bridge !== 'function')) {
    throw new TypeError('A ChatGPT Web bridge is required.');
  }
  return Object.freeze({
    request: ownMethod(bridge, 'request'),
    cancel: ownMethod(bridge, 'cancel'),
    capabilities: ownMethod(bridge, 'capabilities'),
    getSelection: ownMethod(bridge, 'getSelection'),
    setSelection: ownMethod(bridge, 'setSelection'),
    status: ownMethod(bridge, 'status'),
    conversationFor: ownMethod(bridge, 'conversationFor'),
  });
}

function ownMethod(bridge, name) {
  const descriptor = Object.getOwnPropertyDescriptor(bridge, name);
  if (!descriptor || typeof descriptor.value !== 'function') {
    throw new TypeError(`ChatGPT Web bridge is missing method: ${name}`);
  }
  return descriptor.value.bind(bridge);
}

function normalizeRequestParams(params) {
  const record = normalizeParamsRecord(params);
  const timeoutMs = normalizeTimeoutMs(record.timeoutMs);
  return Object.freeze({
    prompt: normalizePrompt(record.prompt),
    timeoutMs,
    sessionKey: normalizeNullableString(record.sessionKey, 'sessionKey'),
    model: normalizeNullableString(record.model, 'model'),
    reasoning: normalizeNullableString(record.reasoning, 'reasoning'),
  });
}

function normalizeSelectionParams(params) {
  const record = normalizeParamsRecord(params);
  return Object.freeze({
    model: normalizeNullableString(record.model, 'model'),
    reasoning: normalizeNullableString(record.reasoning, 'reasoning'),
  });
}

function normalizeNullableStringField(params, field) {
  const record = normalizeParamsRecord(params);
  return normalizeNullableString(record[field], field);
}

function normalizeParamsRecord(params) {
  if (params == null) return Object.create(null);
  if (!isPlainRecord(params)) throw rpcError(INVALID_PARAMS_CODE, 'RPC params must be a plain object.');
  return params;
}

function normalizePrompt(value) {
  if (value == null) return '';
  const type = typeof value;
  if (type === 'string') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw rpcError(INVALID_PARAMS_CODE, 'prompt must be string-normalizable plain data.');
    return String(value);
  }
  if (type === 'boolean' || type === 'bigint') return String(value);
  throw rpcError(INVALID_PARAMS_CODE, 'prompt must be string-normalizable plain data.');
}

function normalizeTimeoutMs(value) {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw rpcError(INVALID_PARAMS_CODE, 'timeoutMs must be a finite positive number.');
  }
  return value;
}

function normalizeNullableString(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string') throw rpcError(INVALID_PARAMS_CODE, `${field} must be a string or null.`);
  return value;
}

function sanitizeWireValue(value, depth = 0, stack = new WeakSet(), budget = { bytes: 0, nodes: 0 }) {
  const type = typeof value;
  if (value === null || type === 'boolean') return value;
  if (type === 'string') { chargeWireString(budget, value); return value; }
  if (type === 'number') {
    if (!Number.isFinite(value)) throw unsafeResult();
    return value;
  }
  if (type !== 'object') throw unsafeResult();
  if (depth >= MAX_WIRE_DEPTH) throw unsafeResult();
  if (stack.has(value)) throw unsafeResult();

  if (Array.isArray(value)) return sanitizeWireArray(value, depth, stack, budget);

  if (!isPlainRecord(value)) throw unsafeResult();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (isDomLikeRecord(descriptors)) throw unsafeResult();
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > MAX_WIRE_CHILDREN) throw unsafeResult();
  // #8773 — account the container and every field slot before copying anything.
  chargeWireNodes(budget, 1 + keys.length);

  stack.add(value);
  try {
    const out = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) throw unsafeResult();
      const descriptor = descriptors[key];
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw unsafeResult();
      chargeWireString(budget, key);
      out[key] = sanitizeWireValue(descriptor.value, depth + 1, stack, budget);
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

function sanitizeWireArray(value, depth, stack, budget) {
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_WIRE_CHILDREN) throw unsafeResult();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  // Charge the container plus every element up front, so a wide array cannot
  // allocate or copy its complete graph before the aggregate budget rejects it.
  chargeWireNodes(budget, 1 + length);
  const out = new Array(length);
  stack.add(value);
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) throw unsafeResult();
      if (Number(key) > MAX_ARRAY_INDEX) throw unsafeResult();
      const descriptor = descriptors[key];
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw unsafeResult();
      out[Number(key)] = sanitizeWireValue(descriptor.value, depth + 1, stack, budget);
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

function chargeWireString(budget, value) {
  if (typeof value !== 'string' || value.length === 0) return;
  const remaining = MAX_WIRE_RESULT_BYTES - budget.bytes;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; index += 1;
    } else bytes += 3;
    // Stop scanning as soon as the aggregate UTF-8 budget is exceeded so the
    // preflight never performs work proportional to the full oversized string.
    if (bytes > remaining) { budget.bytes = MAX_WIRE_RESULT_BYTES + 1; throw unsafeResult(); }
  }
  budget.bytes += bytes;
}

function chargeWireNodes(budget, count) {
  budget.nodes += count;
  if (budget.nodes > MAX_WIRE_RESULT_NODES) throw unsafeResult();
}

function isDomLikeRecord(descriptors) {
  const nodeType = descriptors.nodeType?.value;
  const nodeName = descriptors.nodeName?.value;
  if (typeof nodeType === 'number' && typeof nodeName === 'string') return true;
  return false;
}

function safeBridgeError(error, method) {
  const code = safeErrorCode(error?.code);
  let message = safeErrorMessage(error?.message);
  if (!message) message = `ChatGPT parent RPC failed: ${method}`;
  /*
   * Arbitrary bridge details never cross this boundary: they can carry DOM,
   * prompt or storage text. `stage` is a closed token vocabulary naming the
   * bridge component that refused the turn, so Hex can report which guard fired
   * instead of collapsing every failure into an opaque provider error.
   */
  return rpcError(code, message, safeErrorStage(error?.stage));
}

function safeErrorCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : BRIDGE_ERROR_CODE;
}

function safeErrorStage(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : null;
}

function safeErrorMessage(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  const candidate = value.slice(0, 512);
  if (SENSITIVE_ERROR_TEXT.test(candidate)) return 'ChatGPT parent bridge call failed.';
  return candidate.replace(URL_TEXT, '[redacted-url]');
}

function unsafeResult() {
  return rpcError(UNSAFE_RESULT_CODE, 'ChatGPT parent bridge returned unsafe RPC data.');
}

function rpcError(code, message, stage = null) {
  return new ChatGPTParentRpcError(code, message, stage);
}

class ChatGPTParentRpcError extends Error {
  constructor(code, message, stage = null) {
    super(message);
    this.name = 'ChatGPTParentRpcError';
    this.code = code;
    if (stage) this.details = { stage };
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export default createChatGPTParentRpc;
