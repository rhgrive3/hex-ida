const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1/interactions';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const BAI_URL = 'https://api.b.ai/v1/chat/completions';
const FHROUTER_URL = 'https://api.fhrouter.com/v1/chat/completions';

// Worker-side inference providers. `gemini` is native; every other entry is
// an OpenAI-compatible Chat Completions endpoint behind the same tool-call
// protocol. A new gateway is registered by adding one small adapter below
// (see baiAdapter/fhrouterAdapter) plus its AI_PROVIDER alias in
// resolveInferenceAdapter — no protocol or transport change needed.
export const WORKER_PROVIDER_IDS = Object.freeze(['gemini', 'groq', 'bai', 'fhrouter', 'openai-compat']);

// Browser/runtime payloads are re-wrapped by the Worker (canonical system
// prompt, final-result tool and provider-specific JSON). A conservative 2x
// expansion bound plus fixed reserve prevents a browser-approved request from
// becoming an oversized provider request after that transformation.
export const PROVIDER_ENVELOPE_RESERVE_BYTES = 24 * 1024;
export const PROVIDER_WIRE_EXPANSION_FACTOR = 2;

export const TURN_PROTOCOL_INSTRUCTION = `Return exactly one tool call per turn. Call one supplied Hex read tool when more evidence is required, or call submit_hex_result when the answer is ready. Never invent a tool, address, evidence ID, symbol, or runtime fact.`;

export function resolveInferenceAdapter(env = {}) {
  const requested = String(env.AI_PROVIDER || '').trim().toLowerCase();
  if (requested === 'groq') return groqAdapter(env);
  if (requested === 'bai' || requested === 'b.ai') return baiAdapter(env);
  if (requested === 'fhrouter' || requested === 'fh-router' || requested === 'fh_router') return fhrouterAdapter(env);
  if (requested === 'gemini') return geminiAdapter(env);
  if (requested === 'openai-compat' || requested === 'openai_compat' || requested === 'custom') return customOpenAIAdapter(env);
  if (requested) return geminiAdapter(env);
  // No explicit AI_PROVIDER: keep the historical gemini-first default, then
  // fall back to whichever single gateway key is configured.
  if (env.GEMINI_API_KEY) return geminiAdapter(env);
  if (env.GROQ_API_KEY) return groqAdapter(env);
  if (env.BAI_API_KEY) return baiAdapter(env);
  if (env.FHROUTER_API_KEY) return fhrouterAdapter(env);
  if (env.OPENAI_COMPAT_API_KEY) return customOpenAIAdapter(env);
  return geminiAdapter(env);
}

export function clientSafeCapabilities(capabilities = {}) {
  const upstreamMax = positiveNumber(capabilities.maxRequestBytes, 160000);
  const reservedBudget = upstreamMax - PROVIDER_ENVELOPE_RESERVE_BYTES;
  const derived = reservedBudget > 0
    ? Math.floor(reservedBudget / PROVIDER_WIRE_EXPANSION_FACTOR)
    : Math.floor(upstreamMax / PROVIDER_WIRE_EXPANSION_FACTOR);
  const safeClientMax = Math.max(1, Math.min(upstreamMax, derived));
  return {
    ...capabilities,
    maxRequestBytes: safeClientMax,
    upstreamMaxRequestBytes: upstreamMax,
    requestEnvelopeReserveBytes: PROVIDER_ENVELOPE_RESERVE_BYTES,
    requestWireExpansionFactor: PROVIDER_WIRE_EXPANSION_FACTOR,
  };
}

function geminiAdapter(env) {
  const model = env.GEMINI_MODEL || 'gemini-3.7-flash';
  return {
    id: 'gemini', model, configured: !!env.GEMINI_API_KEY,
    capabilities: { provider: 'gemini', contextTokens: numberOr(env.GEMINI_CONTEXT_TOKENS, 1_000_000), maxOutputTokens: numberOr(env.GEMINI_MAX_OUTPUT_TOKENS, 8192), maxTools: numberOr(env.GEMINI_TOOL_LIMIT, 32), maxRequestBytes: numberOr(env.AI_REQUEST_LIMIT_BYTES, 160000), tpm: nullableNumber(env.GEMINI_TPM) },
    endpoint: env.GEMINI_INTERACTIONS_URL || GEMINI_URL,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY || '' },
    build({ payload, systemInstruction, tools }) {
      return {
        model,
        input: JSON.stringify(modelInput(payload)),
        system_instruction: `${systemInstruction}\n\n${TURN_PROTOCOL_INSTRUCTION}`,
        tools: tools.map(toGeminiTool), stream: false, store: false,
        generation_config: { thinking_level: payload.mode === 'agent' ? (env.GEMINI_AGENT_THINKING || 'high') : (env.GEMINI_CHAT_THINKING || 'medium'), thinking_summaries: 'none', max_output_tokens: Math.min(numberOr(env.GEMINI_MAX_OUTPUT_TOKENS, 8192), payload.mode === 'agent' ? 8192 : 4096), tool_choice: 'any' },
      };
    },
    normalize(value) { return value; },
  };
}

function groqAdapter(env) {
  return openaiChatAdapter({
    id: 'groq',
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
    endpoint: env.GROQ_CHAT_URL || GROQ_URL,
    contextTokens: numberOr(env.GROQ_CONTEXT_TOKENS, 131072),
    maxOutputTokens: numberOr(env.GROQ_MAX_OUTPUT_TOKENS, 8192),
    toolLimit: numberOr(env.GROQ_TOOL_LIMIT, 32),
    tpm: nullableNumber(env.GROQ_TPM),
    requestLimitBytes: numberOr(env.AI_REQUEST_LIMIT_BYTES, 160000),
    // gpt-oss supports a forced tool call; keep the historical behavior.
    toolChoice: 'required',
  });
}

// b.ai gateway (OpenAI-compatible). Verified against the live catalog: the
// zero-balance key can call `qwen3.8-flash`, which returns proper tool_calls
// with tool_choice 'auto' ('required' is rejected in thinking mode).
function baiAdapter(env) {
  return openaiChatAdapter({
    id: 'bai',
    apiKey: env.BAI_API_KEY,
    model: env.BAI_MODEL || 'qwen3.8-flash',
    endpoint: env.BAI_CHAT_URL || BAI_URL,
    contextTokens: numberOr(env.BAI_CONTEXT_TOKENS, 131072),
    maxOutputTokens: numberOr(env.BAI_MAX_OUTPUT_TOKENS, 8192),
    toolLimit: numberOr(env.BAI_TOOL_LIMIT, 32),
    tpm: nullableNumber(env.BAI_TPM),
    requestLimitBytes: numberOr(env.AI_REQUEST_LIMIT_BYTES, 160000),
    toolChoice: env.BAI_TOOL_CHOICE || 'auto',
  });
}

// FHRouter gateway (OpenAI-compatible). Verified against the live catalog on
// a $0-balance key: `glm-5.3-flash` answers with cost 0 and returns proper
// tool_calls with tool_choice 'auto'. Any other id from GET /v1/models can be
// selected via FHROUTER_MODEL (free candidates observed: glm-5.3-flash,
// deepseek-v4-flash, grok-4.6 — only glm-5.3-flash verified for tool calls).
function fhrouterAdapter(env) {
  return openaiChatAdapter({
    id: 'fhrouter',
    apiKey: env.FHROUTER_API_KEY,
    model: env.FHROUTER_MODEL || 'glm-5.3-flash',
    endpoint: env.FHROUTER_CHAT_URL || FHROUTER_URL,
    contextTokens: numberOr(env.FHROUTER_CONTEXT_TOKENS, 131072),
    maxOutputTokens: numberOr(env.FHROUTER_MAX_OUTPUT_TOKENS, 8192),
    toolLimit: numberOr(env.FHROUTER_TOOL_LIMIT, 32),
    tpm: nullableNumber(env.FHROUTER_TPM),
    requestLimitBytes: numberOr(env.AI_REQUEST_LIMIT_BYTES, 160000),
    toolChoice: env.FHROUTER_TOOL_CHOICE || 'auto',
  });
}

// Generic escape hatch for the next gateway: point these four env vars at any
// OpenAI-compatible Chat Completions endpoint and select it with
// AI_PROVIDER=openai-compat. This is how future providers are registered
// without code changes; promoting one to a first-class adapter later only
// means adding a named function above.
function customOpenAIAdapter(env) {
  return openaiChatAdapter({
    id: String(env.OPENAI_COMPAT_ID || 'openai-compat').trim().toLowerCase() || 'openai-compat',
    apiKey: env.OPENAI_COMPAT_API_KEY,
    model: env.OPENAI_COMPAT_MODEL || 'gpt-4o-mini',
    endpoint: env.OPENAI_COMPAT_CHAT_URL || '',
    contextTokens: numberOr(env.OPENAI_COMPAT_CONTEXT_TOKENS, 131072),
    maxOutputTokens: numberOr(env.OPENAI_COMPAT_MAX_OUTPUT_TOKENS, 8192),
    toolLimit: numberOr(env.OPENAI_COMPAT_TOOL_LIMIT, 32),
    tpm: nullableNumber(env.OPENAI_COMPAT_TPM),
    requestLimitBytes: numberOr(env.AI_REQUEST_LIMIT_BYTES, 160000),
    toolChoice: env.OPENAI_COMPAT_TOOL_CHOICE || 'auto',
  });
}

function openaiChatAdapter({ id, apiKey, model, endpoint, contextTokens, maxOutputTokens, toolLimit, tpm, requestLimitBytes, toolChoice }) {
  return {
    id, model, configured: !!apiKey,
    capabilities: { provider: id, contextTokens, maxOutputTokens, maxTools: toolLimit, maxRequestBytes: requestLimitBytes, tpm },
    endpoint,
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${apiKey || ''}` },
    build({ payload, systemInstruction, tools }) {
      return {
        model,
        messages: [
          { role: 'system', content: `${systemInstruction}\n\n${TURN_PROTOCOL_INSTRUCTION}` },
          { role: 'user', content: JSON.stringify(modelInput(payload)) },
        ],
        tools: tools.map(toOpenAITool), tool_choice: toolChoice || 'auto', stream: false,
        max_tokens: Math.min(maxOutputTokens, payload.mode === 'agent' ? 8192 : 4096),
      };
    },
    normalize(value) {
      const call = value?.choices?.[0]?.message?.tool_calls?.[0];
      if (!call) return value;
      return { steps: [{ type: 'function_call', name: call.function?.name, arguments: call.function?.arguments || '{}' }] };
    },
  };
}

function modelInput(payload) {
  return {
    protocol: 'hex-ai-turn-v2', mode: payload.mode, style: payload.style,
    requestedScope: payload.requestedScope, effectiveScope: payload.effectiveScope,
    intent: payload.intent || null, task: payload.task || null,
    messages: payload.messages, context: payload.context,
  };
}
function toGeminiTool(tool) { return { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema }; }
function toOpenAITool(tool) { return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }; }
function positiveNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function numberOr(value, fallback) { return positiveNumber(value, fallback); }
function nullableNumber(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }
