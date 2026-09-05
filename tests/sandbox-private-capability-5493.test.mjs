import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');
const instrumented = `${source}\nexport { workerProgram as __workerProgramForTest };`;
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
