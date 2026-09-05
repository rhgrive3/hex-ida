import assert from 'node:assert/strict';
import { ContextBroker } from '../js/ai/context/broker.js';
import { aiBudget } from '../js/ai/schema.js';
import { semanticBudgetFor } from '../js/ai/budget/wire.js';

// Public contract: contextBytes can be reduced to 1.
const budget = aiBudget('chat', { contextBytes: 1 });
assert.equal(budget.contextBytes, 1);

const semantic = semanticBudgetFor({
  messages: [],
  tools: [],
  meta: {},
  capabilities: { maxRequestBytes: 64 * 1024, contextTokens: 32768, maxOutputTokens: 4096 },
  configuredBytes: budget.contextBytes,
});
assert.equal(semantic, 1, 'the wire budget layer must accept a 1-byte semantic budget');

const broker = new ContextBroker({}, { maxBytes: 128 * 1024 });

// A 1-byte caller budget must not be silently re-expanded to 4096 downstream.
// The broker must either honor it or fail closed, never widen it.
let widened = false;
let failedClosed = false;
try {
  const built = broker.buildModelContext({
    request: { mode: 'chat', style: 'analyst', scope: 'binary' },
    session: {},
    budgetBytes: semantic,
  });
  widened = built.bytes > semantic;
} catch (error) {
  failedClosed = error?.type === 'context_too_large';
  assert.ok(failedClosed, `a tiny budget must fail closed as context_too_large, got ${error?.type}: ${error?.message}`);
}
assert.equal(widened, false, 'the broker must not widen a caller-reduced budget');
assert.ok(failedClosed || widened === false, 'tiny budget is honored or fail-closed');

// Sanity: a normal budget still builds a usable context.
const normal = broker.buildModelContext({
  request: { mode: 'chat', style: 'analyst', scope: 'binary' },
  session: {},
  budgetBytes: 64 * 1024,
});
assert.ok(normal.bytes <= 64 * 1024);

console.log('issue-5103-context-budget-floor: ok');
