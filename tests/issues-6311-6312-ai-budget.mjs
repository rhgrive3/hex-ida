import assert from 'node:assert/strict';
import { ContextBroker } from '../js/ai/context/broker.js';
import { assertWireBudget, serializedByteLength } from '../js/ai/budget/wire.js';

function exactBytes(value) {
  const text = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `0x${item.toString(16)}` : item);
  return new TextEncoder().encode(text ?? 'null').byteLength;
}

const request = { mode: 'chat', style: 'analyst', scope: 'function' };
const session = {};

function hypothesisWith(field, ids) {
  return {
    id: `h-${field}`,
    claim: 'budget regression',
    confidence: 0.5,
    status: 'open',
    supportEvidenceIds: [],
    contradictionEvidenceIds: [],
    missingEvidence: [],
    [field]: ids,
  };
}

for (const field of ['supportEvidenceIds', 'contradictionEvidenceIds', 'missingEvidence']) {
  const ids = [
    ...Array.from({ length: 1000 }, (_, index) => `e${index}`),
    'X'.repeat(200_000),
  ];

  const roomy = new ContextBroker({}, { maxBytes: 320 * 1024 }).buildModelContext({
    request,
    session,
    hypotheses: [hypothesisWith(field, ids)],
    observations: [],
    budgetBytes: 320 * 1024,
  });
  assert.equal(roomy.context.activeHypotheses[0][field].length, 1001, `${field} should be retained when it fits`);
  assert.equal(serializedByteLength(roomy.context), exactBytes(roomy.context), `${field} shared meter must match independent JSON serialization`);
  assert.equal(roomy.bytes, exactBytes(roomy.context), `${field} metadata must equal the actual returned serialization`);
  assert.ok(roomy.bytes > 200_000, `${field} measurement must include the 1001st element`);

  const bounded = new ContextBroker({}, { maxBytes: 128 * 1024 }).buildModelContext({
    request,
    session,
    hypotheses: [hypothesisWith(field, ids)],
    observations: [],
    budgetBytes: 128 * 1024,
  });
  assert.equal(bounded.bytes, exactBytes(bounded.context), `${field} trimmed metadata must equal the returned serialization`);
  assert.ok(bounded.bytes <= 128 * 1024, `${field} must be removed or bounded before return`);
  assert.equal(bounded.context.activeHypotheses.length, 0, `${field} oversized hypothesis should be trimmed as one queue item`);
}

const tokenPayload = { messages: [{ role: 'user', content: 'x'.repeat(200) }] };
const zeroReserveUsage = assertWireBudget(tokenPayload, {
  contextTokens: 100,
  maxOutputTokens: 0,
  maxRequestBytes: 1024 * 1024,
});
assert.ok(zeroReserveUsage.estimatedInputTokens > 1 && zeroReserveUsage.estimatedInputTokens < 100, 'fixture must distinguish zero reserve from the safe fallback');

for (const invalid of [-1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NaN, '-1', [], false]) {
  assert.throws(
    () => assertWireBudget(tokenPayload, {
      contextTokens: 8192,
      maxOutputTokens: invalid,
      maxRequestBytes: 1,
    }),
    (error) => error?.type === 'context_too_large' && error?.details?.maxTokens === 4096,
    `invalid maxOutputTokens ${String(invalid)} must use the safe 4096-token fallback`,
  );
}

assert.doesNotThrow(() => assertWireBudget({ messages: [{ role: 'user', content: 'ok' }] }, {
  contextTokens: 8192,
  maxOutputTokens: 4096,
  maxRequestBytes: 1024 * 1024,
}));

console.log('issues #6311/#6312 AI budget regressions: PASS');
