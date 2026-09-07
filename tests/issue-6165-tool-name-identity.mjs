// Regression for #6165: normalizeAIInteraction() coerced the model's
// function/tool call name with `String()`, so a schema-invalid structured name
// (`['submit_hex_result']`) laundered into that exact string and claimed the
// final-result submission authority (or an allowed tool identity). A tool
// name is string identity: only a primitive non-empty string is valid.
import assert from 'node:assert/strict';
import { normalizeAIInteraction } from '../js/ai/provider/worker-protocol.js';

{
  // A structured name must not reach the final-result submission authority.
  assert.throws(
    () => normalizeAIInteraction({
      steps: [{ type: 'function_call', name: ['submit_hex_result'], arguments: { answer: 'done' } }],
    }, []),
    /invalid function name/,
  );
}

{
  // A structured name must not become an allowed tool identity either.
  assert.throws(
    () => normalizeAIInteraction({
      steps: [{ type: 'function_call', name: ['get_function'], arguments: { functionAddress: '0x1000' } }],
    }, ['get_function']),
    /invalid function name/,
  );
}

{
  // Primitive string names keep working on both paths.
  const tool = normalizeAIInteraction({
    steps: [{ type: 'function_call', name: 'get_function', arguments: { functionAddress: '0x1000' } }],
  }, ['get_function']);
  assert.equal(tool.type, 'tool');
  assert.equal(tool.tool, 'get_function');

  const final = normalizeAIInteraction({
    steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'done' } }],
  }, []);
  assert.equal(final.type, 'final');
  assert.equal(final.answer, 'done');
}
