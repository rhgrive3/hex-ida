import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');
const instrumented = `${source}\nexport { workerProgram as __workerProgramForTest, isSandboxChannelMessage as __isSandboxChannelMessageForTest, createSandboxOutputBudget as __createSandboxOutputBudgetForTest };`;
const mod = await import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`);

async function runWorker(user, mode = 'script', index = 0) {
  const messages = [];
  const context = vm.createContext({
    postMessage(message) { messages.push(message); },
    close() {},
  });
  context.self = context;
  vm.runInContext(mod.__workerProgramForTest(user, mode, index), context, { timeout: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  return messages;
}

test('user source cannot resolve worker-private transport or budget bindings', async () => {
  const messages = await runWorker(`
    print(
      typeof nativePostMessage,
      typeof send,
      typeof outputLimit,
      typeof waiting,
      typeof outputMessages,
      typeof argumentUnits
    );
  `);
  const printed = messages.find((message) => message?.t === 'print');
  assert.ok(printed, 'script should still be able to print');
  assert.deepEqual(Array.from(printed.args), Array(6).fill('undefined'));
  assert.equal(messages.at(-1)?.t, 'done');
});

test('direct postMessage cannot forge internal worker protocol envelopes', async () => {
  const forged = { t: 'rpc', id: 99, method: 'file', args: [] };
  const messages = await runWorker(`postMessage(${JSON.stringify(forged)});`);
  assert.equal(messages.some((message) => message?.t === 'rpc'), false);
  const printed = messages.find((message) => message?.t === 'print');
  assert.ok(printed, 'direct postMessage is reduced to budgeted output');
  assert.equal(printed.args?.[0]?.t, 'rpc');
  assert.equal(messages.at(-1)?.t, 'done');
});

test('plugin discovery still executes through the isolated public registrar', async () => {
  const messages = await runWorker(`
    hex.plugin({ name: 'A', description: 'ok', run() {} });
  `, 'discover', 0);
  const done = messages.find((message) => message?.t === 'done');
  assert.ok(done);
  assert.equal(done.value?.length, 1);
  assert.equal(done.value?.[0]?.name, 'A');
  assert.equal(done.value?.[0]?.description, 'ok');
});

test('host boundary accepts only the closed sandbox channel schema', () => {
  const valid = [
    { t: 'ready' },
    { t: 'print', args: ['ok'] },
    { t: 'rpc', id: 1, method: 'file', args: [] },
    { t: 'budgetExceeded', error: 'limit' },
    { t: 'done', value: null },
    { t: 'error', error: 'boom' },
  ];
  for (const message of valid) assert.equal(mod.__isSandboxChannelMessageForTest(message), true);

  const invalid = [
    null,
    [],
    { t: 'unknown' },
    { t: 'print', args: {}, extra: true },
    { t: 'rpc', id: '1', method: 'file', args: [] },
    { t: 'rpc', id: 1, method: 'file', args: [], extra: true },
    { t: 'done' },
    { t: 'error', error: 1 },
  ];
  for (const message of invalid) assert.equal(mod.__isSandboxChannelMessageForTest(message), false);
});

test('host independently enforces print byte, rate, and message budgets', () => {
  const oversized = mod.__createSandboxOutputBudgetForTest();
  assert.equal(oversized({ t: 'print', args: ['x'.repeat(200_000)] }), true);

  const rate = mod.__createSandboxOutputBudgetForTest();
  const now = Date.now();
  for (let i = 0; i < 96; i++) assert.equal(rate({ t: 'print', args: ['x'] }, now), false);
  assert.equal(rate({ t: 'print', args: ['x'] }, now), true);

  const total = mod.__createSandboxOutputBudgetForTest();
  const start = Date.now();
  for (let i = 0; i < 256; i++) assert.equal(total({ t: 'print', args: ['x'] }, start + i * 1000), false);
  assert.equal(total({ t: 'print', args: ['x'] }, start + 256 * 1000), true);
});
