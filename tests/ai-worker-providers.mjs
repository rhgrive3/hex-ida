import assert from 'node:assert/strict';
import { resolveInferenceAdapter, WORKER_PROVIDER_IDS } from '../js/ai/provider/worker-adapters.js';

// b.ai / FHRouter gateway registration (OpenAI-compatible Chat Completions).
// Secrets must never appear here: only env-var plumbing is asserted.

assert.ok(WORKER_PROVIDER_IDS.includes('bai'), 'bai is a registered worker provider');
assert.ok(WORKER_PROVIDER_IDS.includes('fhrouter'), 'fhrouter is a registered worker provider');

// --- b.ai ---
{
  const adapter = resolveInferenceAdapter({ AI_PROVIDER: 'bai', BAI_API_KEY: 'test-bai-key' });
  assert.equal(adapter.id, 'bai');
  assert.equal(adapter.model, 'qwen3.8-flash', 'bai defaults to the verified free model');
  assert.equal(adapter.configured, true);
  assert.equal(adapter.endpoint, 'https://api.b.ai/v1/chat/completions');
  assert.equal(adapter.headers.authorization, 'Bearer test-bai-key');
  assert.equal(adapter.capabilities.provider, 'bai');
  const built = adapter.build({
    payload: { mode: 'chat', style: 'analyst', requestedScope: 'auto', effectiveScope: 'auto', intent: null, task: null, messages: [], context: {} },
    systemInstruction: 'sys',
    tools: [{ name: 'search_functions', description: 'search', inputSchema: { type: 'object' } }],
  });
  assert.equal(built.model, 'qwen3.8-flash');
  // 'required' is rejected by b.ai in thinking mode; the adapter uses 'auto'.
  assert.equal(built.tool_choice, 'auto');
  assert.equal(built.tools[0].function.name, 'search_functions');
  const normalized = adapter.normalize({ choices: [{ message: { tool_calls: [{ function: { name: 'submit_hex_result', arguments: '{"answer":"pong"}' } }] } }] });
  assert.deepEqual(normalized, { steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: '{"answer":"pong"}' }] });
  // Model override for future free-model selection.
  const custom = resolveInferenceAdapter({ AI_PROVIDER: 'bai', BAI_API_KEY: 'k', BAI_MODEL: 'deepseek-v4-pro' });
  assert.equal(custom.model, 'deepseek-v4-pro');
  assert.equal(resolveInferenceAdapter({ AI_PROVIDER: 'b.ai', BAI_API_KEY: 'k' }).id, 'bai', 'b.ai alias resolves');
}

// --- FHRouter ---
{
  const adapter = resolveInferenceAdapter({ AI_PROVIDER: 'fhrouter', FHROUTER_API_KEY: 'test-fh-key' });
  assert.equal(adapter.id, 'fhrouter');
  assert.equal(adapter.model, 'glm-5.3-flash', 'fhrouter defaults to the verified free tool-calling model');
  assert.equal(adapter.configured, true);
  assert.equal(adapter.endpoint, 'https://api.fhrouter.com/v1/chat/completions');
  assert.equal(adapter.headers.authorization, 'Bearer test-fh-key');
  assert.equal(adapter.capabilities.provider, 'fhrouter');
  const built = adapter.build({
    payload: { mode: 'agent', style: 'analyst', requestedScope: 'auto', effectiveScope: 'auto', intent: null, task: null, messages: [], context: {} },
    systemInstruction: 'sys',
    tools: [{ name: 'search_functions', description: 'search', inputSchema: { type: 'object' } }],
  });
  assert.equal(built.tool_choice, 'auto');
  assert.equal(built.max_tokens, 8192, 'agent mode keeps the shared 8192 cap');
  const chat = adapter.build({
    payload: { mode: 'chat', style: 'analyst', requestedScope: 'auto', effectiveScope: 'auto', intent: null, task: null, messages: [], context: {} },
    systemInstruction: 'sys',
    tools: [],
  });
  assert.equal(chat.max_tokens, 4096, 'chat mode keeps the shared 4096 cap');
  // Free-model selection: any id from GET /v1/models can be chosen.
  const picked = resolveInferenceAdapter({ AI_PROVIDER: 'fhrouter', FHROUTER_API_KEY: 'k', FHROUTER_MODEL: 'deepseek-v4-flash' });
  assert.equal(picked.model, 'deepseek-v4-flash');
  assert.equal(resolveInferenceAdapter({ AI_PROVIDER: 'fh-router', FHROUTER_API_KEY: 'k' }).id, 'fhrouter', 'fh-router alias resolves');
}

// --- Generic OpenAI-compatible escape hatch for future gateways ---
{
  const adapter = resolveInferenceAdapter({
    AI_PROVIDER: 'openai-compat',
    OPENAI_COMPAT_API_KEY: 'k',
    OPENAI_COMPAT_CHAT_URL: 'https://gateway.example/v1/chat/completions',
    OPENAI_COMPAT_MODEL: 'example-free',
  });
  assert.equal(adapter.id, 'openai-compat');
  assert.equal(adapter.endpoint, 'https://gateway.example/v1/chat/completions');
  assert.equal(adapter.model, 'example-free');
  assert.equal(adapter.configured, true);
}

// --- Selection priority (backward compatible) ---
{
  // Historical behavior: gemini wins when its key is present, groq otherwise.
  assert.equal(resolveInferenceAdapter({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' }).id, 'gemini');
  assert.equal(resolveInferenceAdapter({ GROQ_API_KEY: 'q' }).id, 'groq');
  // New gateways participate in the same single-key fallback.
  assert.equal(resolveInferenceAdapter({ BAI_API_KEY: 'b' }).id, 'bai');
  assert.equal(resolveInferenceAdapter({ FHROUTER_API_KEY: 'f' }).id, 'fhrouter');
  // Explicit selection wins over any key combination.
  assert.equal(resolveInferenceAdapter({ AI_PROVIDER: 'fhrouter', FHROUTER_API_KEY: 'f', GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', BAI_API_KEY: 'b' }).id, 'fhrouter');
  assert.equal(resolveInferenceAdapter({ AI_PROVIDER: 'bai', BAI_API_KEY: 'b', GEMINI_API_KEY: 'g' }).id, 'bai');
  // groq keeps its historical forced tool call.
  const groq = resolveInferenceAdapter({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'q' });
  const built = groq.build({
    payload: { mode: 'chat', style: 'analyst', requestedScope: 'auto', effectiveScope: 'auto', intent: null, task: null, messages: [], context: {} },
    systemInstruction: 'sys',
    tools: [],
  });
  assert.equal(built.tool_choice, 'required', 'groq behavior is unchanged');
  assert.equal(resolveInferenceAdapter({}).id, 'gemini', 'empty env still defaults to gemini');
  assert.equal(resolveInferenceAdapter({}).configured, false, 'no key means unconfigured');
}

console.log('ai-worker-providers: PASS');
