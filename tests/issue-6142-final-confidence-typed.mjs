import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAIInteraction, finiteConfidence } from '../js/ai/provider/worker-protocol.js';

function finalCall(args) {
  return { steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: args }] };
}

test('issue #6142 - finiteConfidence accepts only primitive finite numbers', () => {
  assert.equal(finiteConfidence(0), 0);
  assert.equal(finiteConfidence(0.5), 0.5);
  assert.equal(finiteConfidence(1), 1);
  assert.equal(finiteConfidence(undefined), undefined);
  assert.equal(finiteConfidence(null), undefined);
});

test('issue #6142 - canonical number confidence keeps clamp semantics', () => {
  assert.equal(normalizeAIInteraction(finalCall({ answer: 'a', confidence: -0.2 }), []).confidence, 0);
  assert.equal(normalizeAIInteraction(finalCall({ answer: 'a', confidence: 1.4 }), []).confidence, 1);
  assert.equal(normalizeAIInteraction(finalCall({ answer: 'a', confidence: 0.7 }), []).confidence, 0.7);
});

test('issue #6142 - structured/non-number confidence is not promoted to canonical number', () => {
  for (const invalid of ['0.9', ['0.9'], ['1'], true, false, { value: 0.9 }, '1', []]) {
    const decision = normalizeAIInteraction(finalCall({ answer: 'a', confidence: invalid }), []);
    assert.equal(decision.type, 'final');
    assert.equal(decision.confidence, undefined, `confidence ${JSON.stringify(invalid)} must not become canonical number`);
  }
});

test('issue #6142 - malformed confidence does not reach browser validation as schema-conformant', () => {
  const decision = normalizeAIInteraction(finalCall({ answer: 'a', confidence: ['0.9'] }), []);
  assert.ok(!('confidence' in decision) || decision.confidence === undefined, 'laundered confidence must not look schema-conformant');
});

test('issue #6142 - normal submit_hex_result parsing is preserved', () => {
  const decision = normalizeAIInteraction(finalCall({
    answer: 'done', confidence: 0.9, evidenceIds: ['ev1'], followups: ['next'],
  }), []);
  assert.deepEqual(decision, {
    type: 'final', answer: 'done', confidence: 0.9, evidenceIds: ['ev1'],
    hypothesisIds: [], hypotheses: [], suggestedActions: [], followups: ['next'],
  });
});
