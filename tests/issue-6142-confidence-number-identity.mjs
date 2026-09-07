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
  // Primitive finite numbers keep working, including clamping and omission.
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
  assert.equal(finiteConfidence(0.9), 0.9);
  assert.equal(finiteConfidence(-1), 0);
  assert.equal(finiteConfidence(1.5), 1);
}
