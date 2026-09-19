// LLM abstraction for the CodeFuse Step 2 repair lane.
//
// CodeFuse-DeBench talks to its models through the OpenAI Python client
// (`evaluator/syntactic/utils/llm_client.py`), so any OpenAI-compatible
// `/chat/completions` endpoint is a valid backend. No paid provider is
// hardcoded and the default target is a local Ollama server. The model itself
// is never a repository dependency.
//
// Safety properties required by this lane:
//   * base URL, model, API-key env name, timeout, attempts, and temperature are
//     all external configuration;
//   * every request has a finite timeout;
//   * a malformed response or malformed tool call fails closed;
//   * a secret value is never written into an artifact or an error message.

import fs from 'node:fs';

export class LlmMalformedResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmMalformedResponseError';
    this.code = 'llm-malformed-response';
  }
}

export class LlmTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmTimeoutError';
    this.code = 'llm-timeout';
  }
}

export class LlmHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'LlmHttpError';
    this.code = 'llm-http-error';
    this.status = status;
  }
}

const DEFAULTS = Object.freeze({
  provider: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5-coder:7b',
  apiKeyEnv: 'CODEFUSE_LLM_API_KEY',
  timeoutMs: 60_000,
  maxRepairAttempts: 8,
  temperature: 0,
});

function isLocalEndpoint(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function readConfigFile(file) {
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`codefuse-llm-config-invalid:${error?.message || error}`);
  }
}

// Build the effective configuration. Only the env-var *name* of the key is
// retained in the returned object graph that may be serialized.
export function loadLlmConfig({ file = null, env = process.env } = {}) {
  const stored = readConfigFile(file);
  const baseUrl = String(env.CODEFUSE_LLM_BASE_URL ?? stored.baseUrl ?? DEFAULTS.baseUrl).trim();
  const model = String(env.CODEFUSE_LLM_MODEL ?? stored.model ?? DEFAULTS.model).trim();
  const apiKeyEnv = String(env.CODEFUSE_LLM_API_KEY_ENV ?? stored.apiKeyEnv ?? DEFAULTS.apiKeyEnv).trim();
  const timeoutMs = Number(env.CODEFUSE_LLM_TIMEOUT_MS ?? stored.timeoutMs ?? DEFAULTS.timeoutMs);
  const maxRepairAttempts = Number(env.CODEFUSE_LLM_MAX_ATTEMPTS ?? stored.maxRepairAttempts ?? DEFAULTS.maxRepairAttempts);
  const temperature = Number(env.CODEFUSE_LLM_TEMPERATURE ?? stored.temperature ?? DEFAULTS.temperature);
  const apiKey = apiKeyEnv ? env[apiKeyEnv] ?? null : null;
  const enabled = Boolean(env.CODEFUSE_LLM_DISABLED !== '1' && baseUrl && model)
    && (Boolean(apiKey) || isLocalEndpoint(baseUrl));
  const disabledReason = enabled ? null
    : (!baseUrl ? 'llm-base-url-missing'
      : !model ? 'llm-model-missing'
        : !apiKey && !isLocalEndpoint(baseUrl) ? `llm-api-key-env-unset:${apiKeyEnv}` : 'llm-disabled');

  return Object.freeze({
    provider: String(stored.provider ?? DEFAULTS.provider),
    baseUrl,
    model,
    apiKeyEnv,
    apiKey,
    timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : DEFAULTS.timeoutMs,
    maxRepairAttempts: Number.isSafeInteger(maxRepairAttempts) && maxRepairAttempts >= 1 ? maxRepairAttempts : DEFAULTS.maxRepairAttempts,
    temperature: Number.isFinite(temperature) ? temperature : DEFAULTS.temperature,
    enabled,
    disabledReason,
  });
}

// Serializable view: never includes the secret value.
export function redactedLlmConfig(config) {
  return Object.freeze({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    apiKeyPresent: Boolean(config.apiKey),
    timeoutMs: config.timeoutMs,
    maxRepairAttempts: config.maxRepairAttempts,
    temperature: config.temperature,
    enabled: config.enabled,
    disabledReason: config.disabledReason,
  });
}

export function redactSecrets(text, secrets) {
  let output = String(text ?? '');
  for (const secret of secrets ?? []) {
    if (typeof secret !== 'string' || secret.length < 6) continue;
    output = output.split(secret).join('[redacted]');
  }
  return output;
}

function parseToolCalls(message) {
  const raw = message?.tool_calls;
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new LlmMalformedResponseError('llm-malformed-tool-calls');
  return raw.map((call, index) => {
    const name = call?.function?.name;
    const args = call?.function?.arguments;
    if (typeof name !== 'string' || !name) throw new LlmMalformedResponseError(`llm-tool-name-missing:${index}`);
    if (typeof args !== 'string') throw new LlmMalformedResponseError(`llm-tool-arguments-not-string:${index}`);
    let parsed;
    try {
      parsed = JSON.parse(args);
    } catch {
      throw new LlmMalformedResponseError(`llm-tool-arguments-invalid-json:${index}`);
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LlmMalformedResponseError(`llm-tool-arguments-not-object:${index}`);
    }
    return { id: call?.id ?? null, name, arguments: parsed };
  });
}

// Configuration being enabled (a key-free local endpoint counts as enabled) is
// not the same as the endpoint being reachable. The probe lane checks
// reachability with a finite timeout before claiming the repair lane is usable.
export async function probeLlmEndpoint(config, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!config?.enabled) return { reachable: false, reason: config?.disabledReason ?? 'llm-disabled', status: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(200, Number(timeoutMs) || 5000));
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      signal: controller.signal,
    });
    return { reachable: true, reason: null, status: response?.status ?? null };
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? 'llm-endpoint-timeout'
      : `llm-endpoint-unreachable:${redactSecrets(error?.message || error, config.apiKey ? [config.apiKey] : [])}`;
    return { reachable: false, reason, status: null };
  } finally {
    clearTimeout(timer);
  }
}

export function createLlmClient(config, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('codefuse-llm-fetch-unavailable');
  const secrets = config?.apiKey ? [config.apiKey] : [];

  async function chat({ messages, tools = null, toolChoice = 'auto' } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('codefuse-llm-messages-required');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: false,
          temperature: config.temperature,
          ...(tools ? { tools, tool_choice: toolChoice } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new LlmTimeoutError(`llm-timeout:${config.timeoutMs}`);
      throw new Error(redactSecrets(`llm-transport-error:${error?.message || error}`, secrets));
    } finally {
      clearTimeout(timer);
    }

    if (!response || typeof response.ok !== 'boolean') throw new LlmMalformedResponseError('llm-response-invalid');
    if (!response.ok) {
      throw new LlmHttpError(redactSecrets(`llm-http-error:${response.status}`, secrets), response.status);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new LlmMalformedResponseError('llm-response-not-json');
    }
    const message = payload?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') throw new LlmMalformedResponseError('llm-choice-message-missing');
    const content = typeof message.content === 'string' ? message.content : '';
    const toolCalls = parseToolCalls(message);
    if (!content && toolCalls.length === 0) throw new LlmMalformedResponseError('llm-empty-message');
    return {
      content,
      toolCalls,
      usage: {
        promptTokens: payload?.usage?.prompt_tokens ?? null,
        completionTokens: payload?.usage?.completion_tokens ?? null,
        totalTokens: payload?.usage?.total_tokens ?? null,
      },
    };
  }

  return Object.freeze({ chat, secrets });
}
