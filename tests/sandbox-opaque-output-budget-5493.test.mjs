import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const LIMIT = 256 * 1024;
const source = readFileSync(new URL('../js/sandbox.js', import.meta.url), 'utf8');
const transformed = source.replace('export function runInSandbox', 'function runInSandbox');
assert.notEqual(transformed, source, 'sandbox source export marker changed');
const sourceScope = vm.createContext({});
new vm.Script(`${transformed}\n;globalThis.__workerProgram = workerProgram; globalThis.__FRAME = FRAME; globalThis.__sandboxOutputSize = sandboxOutputSize;`).runInContext(sourceScope);

class FakeBlob {
  constructor(parts = []) {
    const text = parts.every((part) => typeof part === 'string') ? parts.join('') : '';
    let size = 0;
    for (const part of parts) {
      if (typeof part === 'string') size += part.length * 2;
      else if (ArrayBuffer.isView(part)) size += part.byteLength;
      else if (part instanceof ArrayBuffer) size += part.byteLength;
    }
    Object.defineProperties(this, {
      _text: { value: text },
      size: { value: size },
    });
  }
}

async function executeWorker(userSource) {
  const rawMessages = [];
  const controlMessages = [];
  const blobs = new Map();
  let blobSeq = 0;
  let closed = false;
  let context;
  const scope = {
    Blob: FakeBlob,
    URL: {
      createObjectURL(blob) {
        const id = `blob:test-${++blobSeq}`;
        blobs.set(id, blob);
        return id;
      },
      revokeObjectURL(id) { blobs.delete(id); },
    },
    postMessage(message) { rawMessages.push(message); },
    importScripts(url) {
      const blob = blobs.get(url);
      if (!blob) throw new Error(`missing blob ${url}`);
      new vm.Script(blob._text).runInContext(context);
    },
    close() { closed = true; },
  };
  context = vm.createContext(scope);
  context.self = context;
  const program = sourceScope.__workerProgram(userSource, 'script', 0);
  new vm.Script(program).runInContext(context);
  const controlPort = {
    postMessage(message) { controlMessages.push(message); },
    start() {},
    onmessage: null,
  };
  context.self.onmessage({ data: { t: 'start' }, ports: [controlPort] });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { rawMessages, controlMessages, closed };
}

function frameMeter() {
  const frame = sourceScope.__FRAME;
  const start = frame.indexOf('<script>') + '<script>'.length;
  const end = frame.lastIndexOf('</script>');
  let script = frame.slice(start, end);
  const close = script.lastIndexOf('})();');
  assert.ok(close >= 0, 'frame closure not found');
  script = `${script.slice(0, close)}globalThis.__publicOutputSize = publicOutputSize;\n${script.slice(close)}`;
  const scope = vm.createContext({
    Blob: FakeBlob,
    addEventListener() {},
    parent: { postMessage() {} },
  });
  new vm.Script(script).runInContext(scope);
  return scope;
}

test('worker output meter rejects >256 KiB opaque cloneables on direct and print paths', async () => {
  const direct = await executeWorker('postMessage(new Blob([new Uint8Array(400_000)]));');
  assert.equal(direct.rawMessages.length, 0);
  assert.ok(direct.controlMessages.some((m) => m?.t === 'outputLimit'));
  assert.equal(direct.closed, true);

  const printed = await executeWorker('print(new Blob([new Uint8Array(400_000)]));');
  assert.equal(printed.rawMessages.length, 0);
  assert.ok(printed.controlMessages.some((m) => m?.t === 'outputLimit'));
  assert.equal(printed.closed, true);
});

test('worker output meter keeps authority after user mutates candidate intrinsics', async () => {
  const result = await executeWorker(`
    Set.prototype.has = () => true;
    Set.prototype.add = () => null;
    Array.prototype.pop = () => null;
    Array.prototype.push = () => 0;
    Object.defineProperty(ArrayBuffer, Symbol.hasInstance, { value: () => true });
    postMessage(new Blob([new Uint8Array(400_000)]));
  `);
  assert.equal(result.rawMessages.length, 0);
  assert.ok(result.controlMessages.some((m) => m?.t === 'outputLimit'));
  assert.equal(result.closed, true);

  const view = await executeWorker('postMessage(new Uint8Array(16));');
  assert.equal(view.rawMessages.length, 1, 'measurable typed-array output remains allowed');
  assert.equal(view.controlMessages.some((m) => m?.t === 'outputLimit'), false);
});

test('frame meter rejects opaque public traffic that bypasses worker wrapper', () => {
  const scope = frameMeter();
  vm.runInContext(`
    globalThis.__opaque = __publicOutputSize({ t: 'userOutput', value: new Blob([new Uint8Array(400_000)]) });
    globalThis.__plain = __publicOutputSize({ t: 'userOutput', value: { ok: 'small' } });
  `, scope);
  assert.ok(scope.__opaque > LIMIT);
  assert.ok(scope.__plain <= LIMIT);
});

test('host output meter fails closed for opaque cloneables', () => {
  sourceScope.Blob = FakeBlob;
  vm.runInContext(`
    globalThis.__hostOpaque = __sandboxOutputSize(new Blob([new Uint8Array(400_000)]));
    globalThis.__hostPlain = __sandboxOutputSize({ t: 'print', args: [{ ok: true }] });
  `, sourceScope);
  assert.ok(sourceScope.__hostOpaque > LIMIT);
  assert.ok(sourceScope.__hostPlain <= LIMIT);
});
