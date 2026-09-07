// Regression for #6149: normalizeRequest() coerced `thinkingLevel` with
// `String()` before the enum check, so `['minimal']` laundered into the real
// 'minimal' reasoning level that is then sent to the provider's generation
// config. Only a primitive string may match the enum.
import assert from 'node:assert/strict';
import { normalizeRequest } from '../js/ai/provider/worker-protocol.js';

const base = {
  question: 'what does this function do?',
  currentFunction: { address: '0x1000', assembly: 'ret' },
};

{
  assert.throws(
    () => normalizeRequest({ ...base, thinkingLevel: ['minimal'] }),
    (error) => error?.code === 'invalid_thinking_level' || /minimal, low, medium, or high/.test(error?.message || ''),
    'a structured thinkingLevel must not launder into a real reasoning level',
  );
}

{
  // Unspecified keeps the documented default and primitive strings keep working.
  assert.equal(normalizeRequest(base).thinkingLevel, 'high');
  assert.equal(normalizeRequest({ ...base, thinkingLevel: 'low' }).thinkingLevel, 'low');
}
