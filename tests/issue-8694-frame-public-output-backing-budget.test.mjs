/*
 * #8694 — the iframe public-output budget must charge structured-clone backing stores.
 *
 * Untrusted Worker code can recover the native prototype sender and bypass the
 * Worker-local output meter, so the sandbox iframe is the independent byte
 * boundary. A 1-byte view over an oversized ArrayBuffer must cost the whole
 * store there, exactly as the Worker and host estimators do.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');
const LIMIT = 256 * 1024;
const OVERSIZED = 'new ArrayBuffer(8 * 1024 * 1024)';

function frameScript() {
  const start = SOURCE.indexOf('const MAX_RPC_TOTAL =');
  const end = SOURCE.indexOf('\nfunction valueSize', start);
  assert.ok(start >= 0 && end > start, 'sandbox frame source must remain extractable');
  const scope = {};
  vm.runInNewContext(`${SOURCE.slice(start, end)}\nglobalThis.__frame = FRAME;`, scope);
  const match = scope.__frame.match(/<script>\n([\s\S]*)\n<\/script>/);
  assert.ok(match, 'sandbox frame script must remain extractable');
  const script = match[1];
  const close = script.lastIndexOf('})();');
  assert.ok(close >= 0, 'frame closure must remain findable');
  return `${script.slice(0, close)}globalThis.__meter = publicOutputSize;\n${script.slice(close)}`;
}

const SCRIPT = frameScript();

function openFrame() {
  const hostMessages = [];
  const listeners = new Map();
  const workers = [];
  let now = 0;

  class FakeBlob {
    constructor(parts) { this.text = parts.join(''); }
  }
  class FakePort {
    constructor() { this.onmessage = null; this.closed = false; }
    postMessage(message) { hostMessages.push(message); }
    start() {}
    close() { this.closed = true; }
  }
  class FakeMessageChannel {
    constructor() { this.port1 = new FakePort(); this.port2 = new FakePort(); }
  }
  class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; this.terminated = false; workers.push(this); }
    postMessage() {}
    terminate() { this.terminated = true; }
  }

  const context = vm.createContext({
    Blob: FakeBlob,
    Worker: FakeWorker,
    MessageChannel: FakeMessageChannel,
    URL: { createObjectURL() { return 'blob:frame-worker'; }, revokeObjectURL() {} },
    Date: { now() { return now; } },
    parent: { postMessage() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
  });
  vm.runInContext(SCRIPT, context);
  const hostPort = new FakePort();
  listeners.get('message')({ ports: [hostPort] });
  hostPort.onmessage({ data: { t: 'start', source: '', mode: 'script', index: 0 } });
  const worker = workers.at(-1);
  assert.ok(worker, 'frame must create a Worker');
  const handshake = hostMessages.length;

  return {
    // Payloads are evaluated inside the frame realm because a real
    // Worker→iframe postMessage delivers a clone made by the receiving realm.
    deliver(expression) {
      worker.onmessage({ data: vm.runInContext(expression, context) });
      return { terminated: worker.terminated, hostMessages: hostMessages.slice(handshake) };
    },
    meter(expression) {
      return vm.runInContext(`__meter(${expression})`, context);
    },
  };
}

const oversizedView = (constructor) => openFrame().deliver(
  `({ t: 'userOutput', value: new ${constructor}(${OVERSIZED}, 0, 1) })`,
);

test('frame script carries the shared binary transport contract', () => {
  assert.ok(SCRIPT.includes('function binaryTransportBytes(value, buffers, N)'),
    'the iframe must measure with the same contract as the Worker and host');
  assert.ok(SCRIPT.includes('BINARY_TRANSPORT_NATIVES_FOR_FRAME'),
    'the iframe must bind the contract to its own realm');
  assert.ok(SCRIPT.includes('BINARY_TRANSPORT_NATIVES_FOR_WORKER'),
    'the Worker program embedded in the frame must keep the same contract');
});

test('a 1-byte Uint8Array over an oversized backing store terminates the Worker', () => {
  const result = oversizedView('Uint8Array');
  assert.equal(result.terminated, true);
  assert.ok(result.hostMessages.some((m) => m.t === 'error' && /安全上限/.test(m.error)));
});

test('a 1-byte DataView over an oversized backing store terminates the Worker', () => {
  const result = oversizedView('DataView');
  assert.equal(result.terminated, true);
  assert.ok(result.hostMessages.some((m) => m.t === 'error' && /安全上限/.test(m.error)));
});

test('non-byte typed views are charged by backing storage, not visible length', () => {
  assert.equal(oversizedView('Uint32Array').terminated, true);
  assert.equal(oversizedView('Float64Array').terminated, true);
});

test('views and buffers nested inside plain objects and arrays are rejected too', () => {
  const view = openFrame().deliver(
    `({ t: 'userOutput', value: { rows: [[{ payload: new DataView(${OVERSIZED}, 0, 1) }]] } })`,
  );
  assert.equal(view.terminated, true);

  const buffer = openFrame().deliver(
    `({ t: 'userOutput', value: [${OVERSIZED}] })`,
  );
  assert.equal(buffer.terminated, true);
});

test('a direct ArrayBuffer above the budget is still rejected', () => {
  assert.equal(openFrame().deliver(`({ t: 'userOutput', value: ${OVERSIZED} })`).terminated, true);
});

test('a small view over an in-budget backing store still passes', () => {
  const result = openFrame().deliver(
    '({ t: "userOutput", value: new Uint8Array(new ArrayBuffer(4096), 0, 1) })',
  );
  assert.equal(result.terminated, false);
  assert.equal(result.hostMessages.length, 0);
});

test('ordinary public output keeps working', () => {
  const result = openFrame().deliver('({ t: "userOutput", value: { ok: [1, "two", true] } })');
  assert.equal(result.terminated, false);
});

test('aliased views share one backing-store charge instead of undercounting', () => {
  const frame = openFrame();
  const withinBudget = frame.meter(
    '(() => { const b = new ArrayBuffer(64 * 1024); return { t: "userOutput", value: ['
    + 'new Uint8Array(b, 0, 1), new Uint8Array(b, 1, 1), new DataView(b, 2, 1), new Uint32Array(b, 0, 1)'
    + '] }; })()',
  );
  assert.ok(withinBudget <= LIMIT, `one 64 KiB store must stay within budget (got ${withinBudget})`);
  assert.equal(frame.deliver(
    '(() => { const b = new ArrayBuffer(64 * 1024); return { t: "userOutput", value: ['
    + 'new Uint8Array(b, 0, 1), new Uint8Array(b, 1, 1), new DataView(b, 2, 1), new Uint32Array(b, 0, 1)'
    + '] }; })()',
  ).terminated, false);

  const oversized = frame.meter(
    '(() => { const b = new ArrayBuffer(300 * 1024); return { t: "userOutput", value: ['
    + 'new Uint8Array(b, 0, 1), new Uint8Array(b, 1, 1), "tail" ] }; })()',
  );
  assert.ok(oversized > LIMIT, 'aliases must not undercount one 300 KiB store');
});

test('a detached or unmeasurable binary value fails closed', () => {
  const frame = openFrame();
  const shared = frame.meter(
    typeof SharedArrayBuffer === 'function'
      ? '(() => ({ t: "userOutput", value: new Uint8Array(new SharedArrayBuffer(8)) }))()'
      : '(() => ({ t: "userOutput", value: new Map() }))()',
  );
  assert.ok(shared > LIMIT, `unmeasurable binary state must fail closed (got ${shared})`);
});
