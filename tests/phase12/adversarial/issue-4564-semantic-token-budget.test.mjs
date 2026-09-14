import assert from 'node:assert/strict';

import { ContextBroker } from '../../../js/ai/context/broker.js';
import {
  assertWireBudget,
  semanticBudgetFor,
  serializedByteLength,
} from '../../../js/ai/budget/wire.js';

const HEADROOM = 2048;

function payloadOverhead(messages, tools, meta) {
  return serializedByteLength({ ...meta, messages, context: {}, tools });
}

{
  const messages = [];
  const tools = [];
  const meta = {};
  const capabilities = {
    maxRequestBytes: 1024 * 1024,
    contextTokens: 4096,
    maxOutputTokens: 2048,
  };
  const overhead = payloadOverhead(messages, tools, meta);
  const tokenWireCeiling = (capabilities.contextTokens - capabilities.maxOutputTokens) * 4;
  const expected = tokenWireCeiling - overhead - HEADROOM;
  const budget = semanticBudgetFor({
    messages,
    tools,
    meta,
    capabilities,
    configuredBytes: 128 * 1024,
  });

  assert.equal(budget, expected,
    'semantic allocation must reserve the same token-derived input ceiling enforced by assertWireBudget');
  assert.ok(budget < 128 * 1024, 'the provider token window, not the roomy byte limit, must be authoritative');

  const broker = new ContextBroker({}, { maxBytes: 128 * 1024 });
  const built = broker.buildModelContext({
    request: { mode: 'chat', style: 'analyst', scope: 'auto', task: 'x'.repeat(4000) },
    session: { messages: [] },
    budgetBytes: budget,
    includeHistory: false,
  });
  assert.doesNotThrow(() => assertWireBudget({ messages, context: built.context, tools, meta }, capabilities),
    'context built to the semantic budget must remain sendable under the same provider token window');
}

{
  const messages = [{ role: 'user', content: 'hello' }];
  const tools = [];
  const meta = { mode: 'chat' };
  const capabilities = {
    maxRequestBytes: 16 * 1024,
    contextTokens: 100_000,
    maxOutputTokens: 0,
  };
  const overhead = payloadOverhead(messages, tools, meta);
  assert.equal(semanticBudgetFor({
    messages,
    tools,
    meta,
    capabilities,
    configuredBytes: 128 * 1024,
  }), capabilities.maxRequestBytes - overhead - HEADROOM,
  'the existing byte-derived ceiling must remain authoritative when it is tighter');
}

{
  const capabilities = {
    maxRequestBytes: 1024 * 1024,
    contextTokens: 2048,
    maxOutputTokens: 2048,
  };
  assert.throws(
    () => semanticBudgetFor({ capabilities, configuredBytes: 128 * 1024 }),
    (error) => error?.type === 'context_too_large',
    'a provider with no input-token capacity must fail before ContextBroker work begins',
  );
}

{
  const capabilities = {
    maxRequestBytes: 1024 * 1024,
    contextTokens: 32768,
    maxOutputTokens: 4096,
  };
  assert.equal(semanticBudgetFor({ capabilities, configuredBytes: 1 }), 1,
    'an explicit small semantic budget must remain a hard caller ceiling (#5103)');
}

{
  // Fractional capability metadata is accepted by the existing downstream
  // meter.  Its integer token estimate means only floor(maxTokens) full tokens
  // are actually usable; the allocator must not reserve fractional-token bytes
  // that assertWireBudget will reject.
  const messages = [];
  const tools = [];
  const meta = {};
  const capabilities = {
    maxRequestBytes: 1024 * 1024,
    contextTokens: 4097.5,
    maxOutputTokens: 2048,
  };
  const overhead = payloadOverhead(messages, tools, meta);
  const expected = Math.floor(capabilities.contextTokens - capabilities.maxOutputTokens) * 4 - overhead - HEADROOM;
  assert.equal(semanticBudgetFor({ messages, tools, meta, capabilities, configuredBytes: 128 * 1024 }), expected,
    'token-derived byte ceiling must match ceil(wireBytes/4) integer semantics');
}

console.log('issue-4564 semantic token budget regression: PASS');
