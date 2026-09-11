// Regression for #6142: finiteConfidence() coerced the final result's
// confidence with `Number()`, so schema-invalid values (`['0.9']`, `'0.8'`,
// `true`) became canonical numbers after the fact and the original model
// schema violation became undetectable downstream. The tool schema declares
// `confidence` as a number; only a primitive finite number is valid.
import assert from 'node:assert/strict';
import { normalizeAIInteraction, finiteConfidence } from '../js/ai/provider/worker-protocol.js';

{
  const decision = normalizeAIInteraction({
    steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'done', confidence: ['0.9'] } }],
  }, []);
  assert.equal(decision.confidence, undefined, 'an array confidence must not become a canonical number');
}

{
  const decision = normalizeAIInteraction({
    steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'done', confidence: '0.8' } }],
  }, []);
  assert.equal(decision.confidence, undefined, 'a numeric-string confidence must not become a canonical number');
}

{
  const decision = normalizeAIInteraction({
    steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'done', confidence: true } }],
  }, []);
  assert.equal(decision.confidence, undefined, 'a boolean confidence must not become a canonical number');
}

{
  const decision = normalizeAIInteraction({
    steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'done', confidence: { value: 0.9 } } }],
  }, []);
  assert.equal(decision.confidence, undefined, 'an object confidence must not become a canonical number');
}

{
  // Primitive finite numbers keep working, including exact endpoints,
  // clamping, and omission.
  for (const confidence of [0, 0.5, 1]) {
    const decision = normalizeAIInteraction({
      steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'done', confidence } }],
    }, []);
    assert.equal(decision.confidence, confidence);
    assert.equal(decision.type, 'final');
    assert.equal(decision.answer, 'done');
  }
  const clamped = normalizeAIInteraction({
    steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'done', confidence: 2 } }],
  }, []);
  assert.equal(clamped.confidence, 1);
  const omitted = normalizeAIInteraction({
    steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'done' } }],
  }, []);
  assert.equal(omitted.confidence, undefined);
}

{
  // Direct contract: non-numbers are rejected, numbers clamp.
  assert.equal(finiteConfidence(['0.9']), undefined);
  assert.equal(finiteConfidence('0.8'), undefined);
  assert.equal(finiteConfidence(true), undefined);
  assert.equal(finiteConfidence({ value: 0.9 }), undefined);
  assert.equal(finiteConfidence(null), undefined);
  assert.equal(finiteConfidence(undefined), undefined);
  assert.equal(finiteConfidence(Number.NaN), undefined);
  assert.equal(finiteConfidence(Number.POSITIVE_INFINITY), undefined);
  assert.equal(finiteConfidence(0.9), 0.9);
  assert.equal(finiteConfidence(-1), 0);
  assert.equal(finiteConfidence(1.5), 1);
}

{
  const decision = normalizeAIInteraction({
    steps: [{
      type: 'function_call',
      name: 'submit_hex_result',
      arguments: { answer: 'done', confidence: 0.9, evidenceIds: ['ev1'], followups: ['next'] },
    }],
  }, []);
  assert.deepEqual(decision, {
    type: 'final', answer: 'done', confidence: 0.9, evidenceIds: ['ev1'],
    hypothesisIds: [], hypotheses: [], suggestedActions: [], followups: ['next'],
  }, 'normal final-result parsing must retain valid confidence and metadata');
}
