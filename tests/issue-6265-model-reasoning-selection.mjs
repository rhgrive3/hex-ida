import assert from 'node:assert/strict';
import { normalizeCapabilities, selectionForModel, selectionForProvider } from '../js/ai/ui/model-picker.js';

const capabilities = normalizeCapabilities({ providers: [
  {
    id: 'chatgpt-web',
    models: [
      { id: 'model-a', reasoning: ['high'] },
      { id: 'model-b', reasoning: ['low'] },
      { id: 'model-c', reasoning: ['high', 'low'] },
    ],
  },
  { id: 'gemini', models: [{ id: 'gemini-pro' }], reasoning: ['balanced'] },
] });

assert.deepEqual(
  selectionForModel(capabilities, 'chatgpt', 'model-b', { provider: 'chatgpt-web', model: 'model-a', reasoning: 'high' }),
  { provider: 'chatgpt-web', model: 'model-b', reasoning: null },
  'model-specific reasoning must be cleared when the new model does not advertise it',
);
assert.deepEqual(
  selectionForModel(capabilities, 'chatgpt-web', 'model-c', { provider: 'chatgpt-web', model: 'model-a', reasoning: 'high' }),
  { provider: 'chatgpt-web', model: 'model-c', reasoning: 'high' },
  'a reasoning level shared by both models may be preserved',
);
assert.deepEqual(
  selectionForModel(capabilities, 'gemini', 'gemini-pro', { provider: 'gemini', model: 'old', reasoning: 'balanced' }),
  { provider: 'gemini', model: 'gemini-pro', reasoning: 'balanced' },
  'provider-level reasoning remains valid for a model without a model-specific list',
);
assert.deepEqual(
  selectionForModel(capabilities, 'chatgpt-web', 'model-c', { provider: 'gemini', model: 'gemini-pro', reasoning: 'balanced' }),
  { provider: 'chatgpt-web', model: 'model-c', reasoning: null },
  'reasoning from another provider must not cross provider boundaries',
);
assert.deepEqual(
  selectionForProvider(capabilities, 'gemini', { provider: 'chatgpt-web', model: 'model-a', reasoning: 'high' }),
  { provider: 'gemini', model: null, reasoning: null },
  'provider changes continue to drop incompatible model metadata',
);

console.log('issue-6265-model-reasoning-selection: PASS');
