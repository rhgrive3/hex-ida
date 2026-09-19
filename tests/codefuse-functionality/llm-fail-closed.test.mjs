import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadLlmConfig,
  redactedLlmConfig,
  redactSecrets,
  createLlmClient,
  probeLlmEndpoint,
  LlmMalformedResponseError,
  LlmHttpError,
  LlmTimeoutError,
} from '../../reports/investigations/codefuse-functionality/harness/llm-client.mjs';
import { repairSource, applyPatch } from '../../reports/investigations/codefuse-functionality/harness/repair.mjs';
import { jsonResponse } from './helpers.mjs';

test('configuration is external: local endpoints work without a key, remote endpoints require one', () => {
  const local = loadLlmConfig({ env: { CODEFUSE_LLM_BASE_URL: 'http://127.0.0.1:11434/v1', CODEFUSE_LLM_MODEL: 'qwen2.5-coder:7b' } });
  assert.equal(local.enabled, true);
  assert.equal(local.apiKey, null);

  const remote = loadLlmConfig({ env: { CODEFUSE_LLM_BASE_URL: 'https://example.invalid/v1', CODEFUSE_LLM_MODEL: 'some-model' } });
  assert.equal(remote.enabled, false);
  assert.match(remote.disabledReason, /llm-api-key-env-unset:CODEFUSE_LLM_API_KEY/);

  const configured = loadLlmConfig({ env: {
    CODEFUSE_LLM_BASE_URL: 'https://example.invalid/v1',
    CODEFUSE_LLM_MODEL: 'some-model',
    CODEFUSE_LLM_API_KEY: 'sk-super-secret-value',
    CODEFUSE_LLM_MAX_ATTEMPTS: '3',
    CODEFUSE_LLM_TIMEOUT_MS: '5000',
  } });
  assert.equal(configured.enabled, true);
  assert.equal(configured.maxRepairAttempts, 3);
  assert.equal(configured.timeoutMs, 5000);
});

test('the API key value never enters the serializable configuration', () => {
  const config = loadLlmConfig({ env: {
    CODEFUSE_LLM_BASE_URL: 'https://example.invalid/v1',
    CODEFUSE_LLM_API_KEY: 'sk-super-secret-value',
  } });
  const redacted = redactedLlmConfig(config);
  const serialized = JSON.stringify(redacted);
  assert.equal(redacted.apiKeyPresent, true);
  assert.equal(redacted.apiKeyEnv, 'CODEFUSE_LLM_API_KEY');
  assert.ok(!('apiKey' in redacted));
  assert.doesNotMatch(serialized, /sk-super-secret-value/);
  assert.equal(redactSecrets('key=sk-super-secret-value', ['sk-super-secret-value']), 'key=[redacted]');
});

test('endpoint reachability is proven separately from configuration', async () => {
  const config = { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: null, model: 'm' };
  const unreachable = await probeLlmEndpoint(config, { fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); }, timeoutMs: 500 });
  assert.equal(unreachable.reachable, false);
  assert.match(unreachable.reason, /llm-endpoint-unreachable/);
  const reachable = await probeLlmEndpoint(config, { fetchImpl: async () => ({ ok: true, status: 200 }), timeoutMs: 500 });
  assert.equal(reachable.reachable, true);
  const disabled = await probeLlmEndpoint({ enabled: false, disabledReason: 'llm-disabled' }, { fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(disabled.reachable, false);
});

test('a malformed LLM response fails closed', async () => {
  const config = { provider: 'test', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: null, timeoutMs: 1000, temperature: 0 };
  const client = createLlmClient(config, { fetchImpl: async () => jsonResponse({}) });
  await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'x' }] }), (error) => {
    assert.ok(error instanceof LlmMalformedResponseError);
    assert.equal(error.code, 'llm-malformed-response');
    return true;
  });
});

test('malformed tool-call arguments fail closed', async () => {
  const config = { provider: 'test', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: null, timeoutMs: 1000, temperature: 0 };
  const client = createLlmClient(config, {
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '', tool_calls: [{ id: '1', function: { name: 'edit_code_block', arguments: '{not json' } }] } }] }),
  });
  await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'x' }] }), /llm-tool-arguments-invalid-json/);
});

test('an HTTP error is surfaced without the secret value', async () => {
  const config = { provider: 'test', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: 'sk-super-secret-value', timeoutMs: 1000, temperature: 0 };
  const client = createLlmClient(config, { fetchImpl: async () => jsonResponse({ error: 'nope' }, { status: 401 }) });
  await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'x' }] }), (error) => {
    assert.ok(error instanceof LlmHttpError);
    assert.doesNotMatch(String(error.message), /sk-super-secret-value/);
    return true;
  });
});

test('a request timeout fails closed', async () => {
  const config = { provider: 'test', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: null, timeoutMs: 20, temperature: 0 };
  const client = createLlmClient(config, {
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  await assert.rejects(() => client.chat({ messages: [{ role: 'user', content: 'x' }] }), (error) => error instanceof LlmTimeoutError);
});

test('patch application is strict and unambiguous', () => {
  assert.deepEqual(applyPatch('a b a', { name: 'edit_code_block', arguments: { search_block: 'a', replace_block: 'z' } }), { ok: false, reason: 'edit_code_block-search-not-unique' });
  assert.deepEqual(applyPatch('abc', { name: 'edit_code_block', arguments: { search_block: 'zzz', replace_block: 'z' } }), { ok: false, reason: 'edit_code_block-search-not-found' });
  assert.deepEqual(applyPatch('abc', { name: 'unknown_tool', arguments: {} }), { ok: false, reason: 'unsupported-tool:unknown_tool' });
  assert.deepEqual(applyPatch('abc', { name: 'replace_string', arguments: { old_str: 'b', new_str: 'X', replace_all: true } }).source, 'aXc');
});

test('repair loop fails closed on malformed responses and never drops the failure', async () => {
  const check = async () => ({ status: 'compile_failed', phase: 'compile', diagnostics: { errorCount: 1, warningCount: 0, firstError: { line: 1, message: 'x' }, firstErrorRaw: 'x.c:1:1: error: x' } });
  const malformed = { chat: async () => { throw new LlmMalformedResponseError('llm-choice-message-missing'); } };
  const result = await repairSource({ source: 'int a(void) {}', client: malformed, check, maxAttempts: 3 });
  assert.equal(result.status, 'malformed_response');
  assert.equal(result.attempts, 0);
  assert.ok(result.failureReason);
});

test('repair loop succeeds only after a verified compile/link, and never mutates the raw source', async () => {
  const raw = 'int a(void)\n{\n return 1;\n}\n';
  let compiles = 0;
  const check = async () => {
    compiles += 1;
    return compiles === 1
      ? { status: 'compile_failed', phase: 'compile', diagnostics: { errorCount: 1, warningCount: 0, firstError: { line: 1, message: 'undefined' }, firstErrorRaw: 'a.c:1:1: error: undefined' } }
      : { status: 'success', phase: 'linker', diagnostics: { errorCount: 0, warningCount: 0, firstError: null, firstErrorRaw: null } };
  };
  const client = {
    chat: async () => ({
      content: '',
      toolCalls: [{ id: '1', name: 'edit_code_block', arguments: { search_block: 'return 1;', replace_block: 'return 1; /* fixed */' } }],
      usage: {},
    }),
  };
  const result = await repairSource({ source: raw, client, check, maxAttempts: 4 });
  assert.equal(result.status, 'success');
  assert.notEqual(result.repairedSource, raw);
  assert.equal(raw, 'int a(void)\n{\n return 1;\n}\n');
});
