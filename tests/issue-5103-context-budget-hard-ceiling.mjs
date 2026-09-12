import assert from 'node:assert/strict';

import { ContextBroker } from '../js/ai/context/broker.js';
import { semanticBudgetFor, SAFE_PROVIDER_CAPABILITIES } from '../js/ai/budget/wire.js';
import { aiBudget } from '../js/ai/schema.js';

function build(budgetBytes, task = null) {
  const broker = new ContextBroker({}, { maxBytes: 128 * 1024 });
  return broker.buildModelContext({
    request: {
      mode: 'chat',
      style: 'analyst',
      scope: 'auto',
      ...(task == null ? {} : { task }),
    },
    session: { messages: [] },
    budgetBytes,
    includeHistory: false,
  });
}

function expectContextTooLarge(fn, maxBytes) {
  assert.throws(fn, (error) => {
    assert.equal(error?.type, 'context_too_large');
    assert.equal(error?.details?.maxBytes, maxBytes);
    assert.ok(error?.details?.bytes > maxBytes);
    return true;
  });
}

// The public and wire-allocation layers both accept explicit budgets below
// 4096. ContextBroker must treat that reviewed value as a hard ceiling rather
// than silently raising it again.
assert.equal(aiBudget('chat', { contextBytes: 1 }).contextBytes, 1);
assert.equal(aiBudget('chat', { contextBytes: 4095 }).contextBytes, 4095);
assert.equal(semanticBudgetFor({
  messages: [],
  tools: [],
  meta: {},
  capabilities: SAFE_PROVIDER_CAPABILITIES,
  configuredBytes: 1,
}), 1);

// Even the irreducible protocol/trust/request envelope is larger than one
// byte, so an explicit one-byte budget must fail closed at exactly that limit.
expectContextTooLarge(() => build(1), 1);

// This fixture serializes to exactly 4096 bytes under the neighboring 4096
// budget. A 4095-byte request must not inherit the old 4096-byte floor and
// return a payload one byte over the caller's explicit ceiling.
const neighboring = build(4096, 'x'.repeat(3491));
assert.equal(neighboring.bytes, 4096);
expectContextTooLarge(() => build(4095, 'x'.repeat(3491)), 4095);

// The supported 4096-byte boundary and ordinary default behavior remain
// usable; this fix only removes lower-layer budget expansion.
assert.ok(build(4096).bytes <= 4096);
assert.ok(build(undefined).bytes <= 128 * 1024);

console.log('issue-5103 context budget hard-ceiling regression: PASS');
