import assert from 'node:assert/strict';
import { createAiEngine } from '../js/ai/ui/bridge.js';

const calls = [];
const app = {
  store: { get(key) { if (key === 'fileInfo') return { name: 'fixture' }; if (key === 'sliceIndex') return 0; if (key === 'regions') return []; return null; } },
  notes: { structs: [] }, symbols: null, recognition: { records: [] }, stringIndex: [],
};
const core = {
  provider: {
    capabilities: async () => ({ providers: [{ id: 'chatgpt-web' }] }), status: () => ({ ready: true }),
    getSelection: () => ({ model: 'chatgpt-web/sol', reasoning: 'high' }), setSelection: async (value) => value,
  },
  async turn(input) {
    calls.push({ ...input });
    const id = input.sessionId || (input.conversationId === 'A' ? 'session-A' : input.conversationId === 'B' ? 'session-B' : 'session-default');
    return { sessionId: id, answer: 'ok' };
  },
};
const engine = createAiEngine(app, { loadCore: async () => core });
const base = { question: 'test', mode: 'chat', style: 'analyst', scope: 'auto', provider: 'chatgpt-web', model: 'chatgpt-web/sol', reasoning: 'high' };
await engine.run({ ...base, conversationId: 'A' });
await engine.run({ ...base, conversationId: 'B' });
await engine.run({ ...base, conversationId: 'A' });
assert.deepEqual(calls.map((item) => [item.conversationId, item.sessionId]), [['A', null], ['B', null], ['A', 'session-A']]);
assert.equal(calls[0].provider, 'chatgpt-web'); assert.equal(calls[0].model, 'chatgpt-web/sol'); assert.equal(calls[0].reasoning, 'high');

// A new chat with an explicit conversationId must not adopt the only persisted
// session of a different conversation; the exact match is authoritative (#6011).
{
  const persisted = [{
    id: 'session-A', conversationId: 'conv-A', binaryId: 'fixture:0', projectId: null,
    investigationMemory: { goal: 'A only', confirmedFacts: [], activeHypotheses: [] },
    messages: [{ role: 'user', content: 'A question' }],
  }];
  const persistenceCalls = [];
  const persistedApp = {
    store: { get(key) { if (key === 'fileInfo') return { name: 'fixture' }; if (key === 'sliceIndex') return 0; if (key === 'regions') return []; return null; } },
    notes: { structs: [] }, symbols: null, recognition: { records: [] }, stringIndex: [],
    workspace: {
      project: { id: 'project-1', findings: { investigationSessions: persisted } },
      autosave: () => persistenceCalls.push('autosave'),
    },
  };
  const persistedCalls = [];
  const persistedCore = {
    async turn(input) { persistedCalls.push({ ...input }); return { sessionId: input.sessionId || 'session-new', answer: 'ok' }; },
  };
  const persistedEngine = createAiEngine(persistedApp, { loadCore: async () => persistedCore });
  await persistedEngine.run({ ...base, conversationId: 'conv-B' });
  assert.equal(persistedCalls[0].sessionId, null, 'conv-B must start a new investigation, not adopt session-A');
  await persistedEngine.run({ ...base, conversationId: 'conv-A' });
  assert.equal(persistedCalls[1].sessionId, 'session-A', 'the exact conversation match still reuses its own session');
}
assert.deepEqual((await engine.aiCapabilities()).providers, [{ id: 'chatgpt-web' }]);
assert.equal((await engine.aiStatus()).ready, true);
assert.deepEqual(engine.getAISelection(), { model: 'chatgpt-web/sol', reasoning: 'high' });
assert.deepEqual(await engine.setAISelection({ model: 'chatgpt-web/terra' }), { model: 'chatgpt-web/terra' });

console.log('ai-conversation-routing: ok');
