import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX_SOURCE = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');

function loadWorkerProgram() {
  const start = SANDBOX_SOURCE.indexOf('const WORKER_PRELUDE = String.raw`');
  const end = SANDBOX_SOURCE.indexOf('\nconst FRAME = `', start);
  assert.ok(start >= 0 && end > start, 'sandbox worker program source must remain extractable');
  const scope = {};
  vm.runInNewContext(
    `${SANDBOX_SOURCE.slice(start, end)}\nglobalThis.__workerProgram = workerProgram;`,
    scope,
  );
  assert.equal(typeof scope.__workerProgram, 'function');
  return scope.__workerProgram;
}

const workerProgram = loadWorkerProgram();

async function executeWorker(source, mode = 'script', index = 0) {
  const rawMessages = [];
  const controlMessages = [];
  const blobs = new Map();
  let nextBlob = 1;
  let closed = false;

  class FakeBlob {
    constructor(parts) {
      this.text = parts.join('');
    }
  }

  const sandbox = {
    Blob: FakeBlob,
    URL: {
      createObjectURL(blob) {
        const url = `blob:test-${nextBlob++}`;
        blobs.set(url, blob.text);
        return url;
      },
      revokeObjectURL() {},
    },
    close() {
      closed = true;
    },
    postMessage(message) {
      rawMessages.push(message);
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext('globalThis.self = globalThis;', context);
  sandbox.importScripts = (url) => {
    const imported = blobs.get(url);
    assert.equal(typeof imported, 'string', 'importScripts must receive a generated user blob');
    new vm.Script(imported).runInContext(context);
  };

  new vm.Script(workerProgram(source, mode, index)).runInContext(context);
  assert.equal(typeof sandbox.onmessage, 'function', 'worker must wait for a private control port');
  const control = {
    onmessage: null,
    postMessage(message) {
      controlMessages.push(message);
    },
    start() {},
  };
  sandbox.onmessage({ data: { t: 'start' }, ports: [control] });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { rawMessages, controlMessages, closed, control };
}

test('user script cannot capture worker-private lexical capabilities', async () => {
  const result = await executeWorker(`
    print(typeof nativePostMessage, typeof send, typeof waiting, typeof outputMessages);
    postMessage({ t: 'done', value: 'forged' });
  `);

  const print = result.controlMessages.find((m) => m.t === 'print');
  assert.deepEqual(Array.from(print.args), ['undefined', 'undefined', 'undefined', 'undefined']);
  assert.equal(
    result.controlMessages.some((m) => m.t === 'done' && m.value === 'forged'),
    false,
    'public postMessage must not be able to forge privileged done authority',
  );
  assert.equal(result.rawMessages.length, 1);
  assert.equal(result.rawMessages[0].t, 'userOutput');
  assert.equal(result.rawMessages[0].value.t, 'done');
});

test('oversized public postMessage is budgeted before crossing the raw worker boundary', async () => {
  const result = await executeWorker(`
    postMessage({ t: 'print', args: ['x'.repeat(200_000)] });
  `);

  assert.equal(result.rawMessages.length, 0, 'oversized payload must never reach the raw worker channel');
  assert.ok(result.controlMessages.some((m) => m.t === 'outputLimit'));
  assert.equal(result.closed, true);
});

test('plugin factory is isolated too and normal plugin execution still completes', async () => {
  const result = await executeWorker(`
    hex.plugin({
      name: 'scope probe',
      run() { return typeof nativePostMessage + ':' + typeof waiting + ':' + typeof send; },
    });
  `, 'plugin', 0);

  const print = result.controlMessages.find((m) => m.t === 'print');
  assert.deepEqual(Array.from(print.args), ['undefined:undefined:undefined']);
  assert.ok(result.controlMessages.some((m) => m.t === 'done'));
});

test('frame uses a private MessagePort and rejects raw control envelopes', () => {
  assert.match(SANDBOX_SOURCE, /const control = new MessageChannel\(\);/);
  assert.match(SANDBOX_SOURCE, /worker\.postMessage\(\{ t: 'start' \}, \[control\.port2\]\);/);
  assert.match(SANDBOX_SOURCE, /data\.t !== 'userOutput'/);
  assert.doesNotMatch(
    SANDBOX_SOURCE,
    /worker\.onmessage\s*=\s*\(e\)[\s\S]{0,300}port\.postMessage\(data\)/,
    'raw worker messages must not be forwarded into the privileged host protocol',
  );
});
