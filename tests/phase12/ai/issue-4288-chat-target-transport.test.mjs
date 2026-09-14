import assert from 'node:assert/strict';
import worker, { __test as workerProtocol } from '../../../worker.js';
import { instructionAiItems } from '../../../js/ai/interaction/contextual.js';
import { createLocalEngine } from '../../../js/ai/ui/local-engine-base.js';

// Identical instruction text makes the selected address essential, even though
// both requests include exactly the same complete function assembly.
const rows = [0x1000n, 0x1004n].map((address) => ({ address, mnemonic: 'add', operands: 'x0, x0, #1' }));
const engine = createLocalEngine({ analysisQueries: {
  async snapshot() { return {}; },
  async function() { return { completeness: 'complete', value: { model: { instructions: rows, blocks: [] } } }; },
} }, {});
const browserRequests = [], providerRequests = [];
let quotaSerial = 0;
const env = { GEMINI_API_KEY: 'fixture-only', AI_QUOTA: {
  getByName() { return {
    async acquire() { return { allowed: true, token: `target-transport-${++quotaSerial}` }; },
    async release() { return { released: true }; },
  }; },
} };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (url === '/api/gemini') {
    browserRequests.push(JSON.parse(options.body));
    return worker.fetch(new Request('https://example.test/api/gemini', options), env);
  }
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1/interactions');
  providerRequests.push(JSON.parse(options.body));
  return new Response(
    'event: step.delta\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"fixture answer"}}\n\n'
    + 'event: interaction.completed\ndata: {"event_type":"interaction.completed"}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
};

async function chat(question, options) {
  const before = providerRequests.length;
  const result = await engine.run({
    ...options, question, mode: 'chat', style: 'analyst', onActivity() {},
    context: {
      function: { addressValue: 0x1000n, address: '0x00001000', name: 'fixture' },
      untrustedTarget: options.untrustedTarget,
    },
  });
  assert.equal(result.answer, 'fixture answer', 'the provider request must complete without falling back to local facts');
  assert.equal(providerRequests.length, before + 1);
  return { browser: browserRequests.at(-1), provider: providerRequests.at(-1), model: JSON.parse(providerRequests.at(-1).input) };
}

try {
  for (const actionIndex of [1, 2]) {
    const requests = [];
    for (const row of rows) {
      let call;
      instructionAiItems({ open() {}, ask(question, options) { call = { question, options }; } }, {
        address: row.address, text: `${row.mnemonic} ${row.operands}`,
      })[actionIndex].action();
      const request = await chat(call.question, call.options);
      assert.deepEqual(request.browser.untrustedTarget, call.options.untrustedTarget, 'the selected target must reach the browser transport');
      assert.deepEqual(request.model.untrustedTarget, call.options.untrustedTarget, 'server normalization must preserve the selected target as model data');
      assert.equal(request.model.untrustedTarget.trust, 'untrusted-data');
      for (const text of [call.options.untrustedTarget.address, call.options.untrustedTarget.text]) {
        assert.equal(request.browser.question.includes(text), false, 'binary data must stay out of trusted goal text');
        assert.equal(request.provider.system_instruction.includes(text), false, 'binary data must stay out of system instructions');
      }
      assert.match(request.provider.system_instruction, /untrustedTarget/);
      requests.push(request);
    }
    assert.equal(requests[0].browser.question, requests[1].browser.question, 'selecting another instruction must not rewrite the fixed goal');
    assert.deepEqual(requests[0].model.currentFunction, requests[1].model.currentFunction);
    assert.notDeepEqual(requests[0].browser, requests[1].browser, 'two selections in one function must produce distinguishable browser requests');
    assert.notEqual(requests[0].provider.input, requests[1].provider.input, 'the actual Gemini model input must distinguish the selections');
  }

  const question = 'Explain the selected instruction.';
  const currentFunction = { address: '0x00001000', assembly: 'add x0, x0, #1' };
  async function checkTarget(target, expected) {
    const request = await chat(question, { scope: 'function', untrustedTarget: target });
    assert.deepEqual(request.browser.untrustedTarget, expected);
    assert.deepEqual(request.model.untrustedTarget, expected);
    assert.deepEqual(workerProtocol.normalizeRequest({ question, currentFunction, untrustedTarget: target }).context.untrustedTarget, expected,
      'the server boundary must independently normalize direct callers');
  }

  const data = { kind: 'instruction', address: '0x00001004', text: 'add x0, x0, #1', name: 'fixture', label: 'selection' };
  for (const key of Object.keys(data)) {
    for (const throws of [false, true]) {
      let calls = 0;
      const target = { ...data };
      Object.defineProperty(target, key, { enumerable: true, get() {
        calls++;
        if (throws) throw new Error('target getter must not run');
        return data[key];
      } });
      const expected = { ...data, trust: 'untrusted-data' };
      delete expected[key];
      await checkTarget(target, key === 'kind' ? undefined : expected);
      assert.equal(calls, 0, `${key}: both transport boundaries must use own data properties only`);
    }
  }
  await checkTarget(Object.create(data), undefined);
  await checkTarget(Object.assign(Object.create(data), { kind: 'instruction' }), { kind: 'instruction', trust: 'untrusted-data' });
  const hostile = { toString() { throw new Error('target coercion must not run'); } };
  await checkTarget({ kind: 'instruction', address: hostile, text: hostile, name: hostile, label: hostile }, { kind: 'instruction', trust: 'untrusted-data' });
  await checkTarget(Object.freeze({
    kind: ' instruction ', address: ` ${'a'.repeat(256)} `,
    text: 'x'.repeat(4096), name: 'n'.repeat(2048), label: 'l'.repeat(2048), trust: 'trusted-instructions',
    toJSON() { throw new Error('target serialization hook must not run'); },
  }), { kind: 'instruction', trust: 'untrusted-data', address: 'a'.repeat(128), text: 'x'.repeat(2048), name: 'n'.repeat(1024), label: 'l'.repeat(1024) });
} finally {
  globalThis.fetch = originalFetch;
}

console.log('issue-4288 chat target transport regression: PASS');
