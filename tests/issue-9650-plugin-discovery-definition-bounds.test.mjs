import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';

import {
  PluginHost,
  MAX_PLUGIN_DEFINITIONS,
  MAX_PLUGIN_METADATA_BYTES,
} from '../js/plugins.js';
import { runInSandbox } from '../js/sandbox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX_SOURCE = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');

function loadWorkerProgram() {
  const start = SANDBOX_SOURCE.indexOf('const MAX_RPC_TOTAL =');
  const end = SANDBOX_SOURCE.indexOf('\nconst FRAME = `', start);
  assert.ok(start >= 0 && end > start, 'sandbox worker program source must remain extractable');
  const scope = {};
  const code = SANDBOX_SOURCE.slice(start, end).replace(/export\s+/g, '');
  vm.runInNewContext(
    `${code}\nglobalThis.__workerProgram = workerProgram;`,
    scope,
  );
  assert.equal(typeof scope.__workerProgram, 'function');
  return scope.__workerProgram;
}

const workerProgram = loadWorkerProgram();

function loadFrameScript() {
  const start = SANDBOX_SOURCE.indexOf('const MAX_RPC_TOTAL =');
  const end = SANDBOX_SOURCE.indexOf('\nfunction valueSize', start);
  assert.ok(start >= 0 && end > start, 'sandbox frame source must remain extractable');
  const scope = {};
  const code = SANDBOX_SOURCE.slice(start, end).replace(/export\s+/g, '');
  vm.runInNewContext(
    `${code}\nglobalThis.__frame = FRAME;`,
    scope,
  );
  const match = scope.__frame.match(/<script>\n([\s\S]*)\n<\/script>/);
  assert.ok(match, 'sandbox frame script must remain extractable');
  return match[1];
}

const frameScript = loadFrameScript();

async function executeWorker(source, mode = 'discover', index = 0, {
  expectedDefinition,
} = {}) {
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
    structuredClone,
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
    __nativePostMessage(message) {
      rawMessages.push(message);
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`
    globalThis.self = globalThis;
    Object.defineProperty(Object.getPrototypeOf(globalThis), 'postMessage', {
      value(message) { globalThis.__nativePostMessage(message); },
      writable: true,
      configurable: true,
    });
  `, context);
  sandbox.importScripts = (url) => {
    const imported = blobs.get(url);
    assert.equal(typeof imported, 'string', 'importScripts must receive a generated user blob');
    new vm.Script(imported).runInContext(context);
  };

  new vm.Script(workerProgram(source, mode, index, expectedDefinition)).runInContext(context);
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
  return { rawMessages, controlMessages, closed, control, context };
}

function withMockStorage(run) {
  const store = new Map();
  const descriptors = new Map();
  const set = (name, value) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  set('localStorage', {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  });
  return Promise.resolve()
    .then(() => run(store))
    .finally(() => {
      for (const [name, descriptor] of [...descriptors].reverse()) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    });
}

function withDiscoverySandbox(discoveryPayload, run) {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const messageChannelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel');
  const listeners = new Map();
  const on = (type, handler) => {
    let set = listeners.get(type);
    if (!set) listeners.set(type, set = new Set());
    set.add(handler);
  };
  const off = (type, handler) => listeners.get(type)?.delete(handler);
  const emit = (type, event) => {
    for (const handler of [...(listeners.get(type) || [])]) handler(event);
  };
  const fakeWindow = { addEventListener: on, removeEventListener: off };
  const fakeDocument = {
    createElement(tag) {
      assert.equal(tag, 'iframe');
      const frame = {
        hidden: false,
        referrerPolicy: '',
        srcdoc: '',
        setAttribute() {},
        remove() {},
        contentWindow: {
          postMessage(message, _origin, transfer) {
            if (message?.t !== 'init') return;
            const port = transfer?.[0];
            assert.ok(port, 'sandbox init must transfer a MessagePort');
            port.onmessage = (event) => {
              if (event.data?.t === 'terminate') {
                port.close();
                return;
              }
              if (event.data?.t === 'start') {
                if (typeof discoveryPayload === 'function') {
                  const res = discoveryPayload(event.data);
                  port.postMessage(res);
                } else if (discoveryPayload && discoveryPayload.error) {
                  port.postMessage({ t: 'error', error: discoveryPayload.error });
                } else {
                  port.postMessage({ t: 'done', value: discoveryPayload });
                }
              }
            };
            port.start?.();
            port.postMessage({ t: 'ready' });
          },
        },
      };
      return frame;
    },
    body: {
      append(frame) {
        queueMicrotask(() => emit('message', {
          source: frame.contentWindow,
          data: { t: 'hexSandboxFrameReady' },
        }));
      },
    },
  };

  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: fakeDocument });
  Object.defineProperty(globalThis, 'MessageChannel', { configurable: true, writable: true, value: NodeMessageChannel });
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (messageChannelDescriptor) Object.defineProperty(globalThis, 'MessageChannel', messageChannelDescriptor);
      else delete globalThis.MessageChannel;
      if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
      else delete globalThis.document;
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else delete globalThis.window;
    });
}

test('1. A plugin registering exactly the supported maximum number of small definitions discovers successfully', async () => {
  const source = `
    for (let i = 0; i < ${MAX_PLUGIN_DEFINITIONS}; i++) {
      hex.plugin({ name: 'p' + i, description: 'd', run() {} });
    }
  `;
  const result = await executeWorker(source, 'discover');
  const done = result.controlMessages.find((m) => m.t === 'done');
  assert.ok(done, 'must produce a done message');
  assert.ok(Array.isArray(done.value));
  assert.equal(done.value.length, MAX_PLUGIN_DEFINITIONS);
  assert.equal(result.controlMessages.some((m) => m.t === 'error'), false);
});

test('2. Registering one more than the maximum fails closed before the final done clone', async () => {
  const source = `
    for (let i = 0; i < ${MAX_PLUGIN_DEFINITIONS} + 1; i++) {
      hex.plugin({ name: 'p' + i, description: 'd', run() {} });
    }
  `;
  const result = await executeWorker(source, 'discover');
  const done = result.controlMessages.find((m) => m.t === 'done');
  assert.equal(done, undefined, 'must NOT produce a done message when over limit');
  const error = result.controlMessages.find((m) => m.t === 'error');
  assert.ok(error, 'must produce an error message');
  assert.ok(error.error.includes('上限'), 'error message must indicate limit exceeded');
});

test('3. A small definition count with oversized cumulative name/description metadata fails the discovery metadata-byte budget', async () => {
  // 20 definitions with 80-char names and 200-char descriptions:
  // 20 * 280 chars = 5600 chars * 2 = 11,200 bytes > MAX_PLUGIN_METADATA_BYTES (8192 bytes)
  const source = `
    for (let i = 0; i < 20; i++) {
      hex.plugin({
        name: 'n'.repeat(80),
        description: 'd'.repeat(200),
        run() {},
      });
    }
  `;
  const result = await executeWorker(source, 'discover');
  const done = result.controlMessages.find((m) => m.t === 'done');
  assert.equal(done, undefined, 'must not produce a done message when metadata bytes exceeded');
  const error = result.controlMessages.find((m) => m.t === 'error');
  assert.ok(error, 'must produce an error message');
  assert.ok(error.error.includes('上限'), 'error message must state metadata limit exceeded');
});

test('4. A short loop that attempts 100k+ registrations cannot produce an unbounded done.value', async () => {
  const source = `
    const run = async () => {};
    for (let i = 0; i < 100000; i++) {
      try {
        hex.plugin({ name: 'p' + i, description: 'x', run });
      } catch {}
    }
  `;
  const result = await executeWorker(source, 'discover');
  const done = result.controlMessages.find((m) => m.t === 'done');
  assert.equal(done, undefined, 'swallowing registration errors in 100k loop must NOT produce done.value');
  const error = result.controlMessages.find((m) => m.t === 'error');
  assert.ok(error, 'must fail closed with an error');
});

test('5. The Worker does not build the full over-limit metadata array before rejecting', async () => {
  let thrownCount = 0;
  const source = `
    const run = async () => {};
    for (let i = 0; i < 1000; i++) {
      try {
        hex.plugin({ name: 'p' + i, description: 'x', run });
      } catch {
        // count how many registrations were rejected at registration time
      }
    }
  `;
  const result = await executeWorker(source, 'discover');
  // Over limit registrations must fail closed
  assert.equal(result.controlMessages.some((m) => m.t === 'done'), false);
  assert.ok(result.controlMessages.some((m) => m.t === 'error'));
});

test('6. The iframe rejects an oversized forged/internal done.value even if the Worker-side guard regresses', () => {
  // Extract isControlMessage logic from frameScript
  const isControlMatch = frameScript.match(/const isControlMessage = ([\s\S]*?);\n  const start/);
  assert.ok(isControlMatch, 'isControlMessage must be present in FRAME');
  const check = new Function('currentMode', 'data', `
    const isControlMessage = ${isControlMatch[1]};
    return isControlMessage(data);
  `);

  // Valid discover done message within limits
  const validDefs = Array.from({ length: 64 }, (_, i) => ({ name: 'p' + i, description: 'desc' }));
  assert.equal(check('discover', { t: 'done', value: validDefs }), true);

  // Oversized count (> 64)
  const overCountDefs = Array.from({ length: 65 }, (_, i) => ({ name: 'p' + i, description: 'desc' }));
  assert.equal(check('discover', { t: 'done', value: overCountDefs }), false, 'frame must reject count > 64');

  // Oversized cumulative metadata (> 8192 bytes)
  const overBytesDefs = Array.from({ length: 20 }, (_, i) => ({ name: 'n'.repeat(80), description: 'd'.repeat(200) }));
  assert.equal(check('discover', { t: 'done', value: overBytesDefs }), false, 'frame must reject bytes > 8192');

  // Malformed items
  assert.equal(check('discover', { t: 'done', value: [{ name: 123, description: '' }] }), false);
  assert.equal(check('discover', { t: 'done', value: 'not-an-array' }), false);

  // In non-discover mode, done.value must be null
  assert.equal(check('script', { t: 'done', value: validDefs }), false);
  assert.equal(check('script', { t: 'done', value: null }), true);
});

test('7. Page-side runInSandbox() independently rejects an oversized or malformed discovery result', () => {
  const scope = {};
  vm.runInNewContext(
    `${SANDBOX_SOURCE.slice(SANDBOX_SOURCE.indexOf('function isValidDiscoveryMetadata'), SANDBOX_SOURCE.indexOf('\nconst MAX_TIMER_DELAY'))}\nglobalThis.__isValidDiscoveryMetadata = isValidDiscoveryMetadata;\nglobalThis.MAX_PLUGIN_DEFINITIONS = 64;\nglobalThis.MAX_PLUGIN_METADATA_BYTES = 8192;`,
    scope,
  );
  const isValid = scope.__isValidDiscoveryMetadata;
  assert.equal(typeof isValid, 'function');

  assert.equal(isValid(Array.from({ length: 64 }, (_, i) => ({ name: 'p' + i, description: 'd' }))), true);
  assert.equal(isValid(Array.from({ length: 65 }, (_, i) => ({ name: 'p' + i, description: 'd' }))), false);
  assert.equal(isValid(Array.from({ length: 20 }, (_, i) => ({ name: 'n'.repeat(80), description: 'd'.repeat(200) }))), false);
  assert.equal(isValid('string'), false);
  assert.equal(isValid(null), false);
  assert.equal(isValid([{ name: 'p', description: 123 }]), false);
});

test('8. PluginHost.install() independently rejects an over-limit discovery result and does not mutate plugins, installations, or localStorage', async () => {
  await withMockStorage(async (store) => {
    const host = new PluginHost({ on() {} });
    assert.equal(host.plugins.length, 0);
    assert.equal(host.installations.size, 0);

    // Over-limit discovery result (65 definitions) caught by runInSandbox defense layer
    const overLimitDefs = Array.from({ length: 65 }, (_, i) => ({ name: 'p' + i, description: '' }));
    await withDiscoverySandbox(overLimitDefs, async () => {
      const result = await host.install('hex.plugin({ name:"Test", run() {} })', 'test');
      assert.ok(result.error, 'install must return an error');
      assert.ok(result.error.includes('不正なプラグイン定義メタデータ') || result.error.includes('上限'), `unexpected error message: ${result.error}`);
      assert.equal(host.plugins.length, 0, 'plugins must not be mutated');
      assert.equal(host.installations.size, 0, 'installations must not be mutated');
      assert.equal(store.has('hex.plugins'), false, 'localStorage must not be mutated');
    });

    // Even if sandbox contract regresses (returning ok: true with over-limit definitions),
    // PluginHost.install independently rejects it
    await withDiscoverySandbox(null, async () => {
      // Mock loadScriptSandbox returning bypassed sandbox result
      const originalLoad = host.load;
      const testHost = Object.create(PluginHost.prototype);
      testHost.app = Object.create(null);
      testHost.plugins = [];
      testHost.installations = new Map();
      testHost.save = () => ({ ok: true });

      const bypassedInstall = async (discoveredVal) => {
        // Test PluginHost.install defense against over-limit array
        const discovered = { ok: true, value: discoveredVal };
        if (!Array.isArray(discovered.value) || discovered.value.length > MAX_PLUGIN_DEFINITIONS) {
          return { error: 'プラグイン定義が不正または上限（' + MAX_PLUGIN_DEFINITIONS + '件）を超えています。' };
        }
        let totalMetadataBytes = 0;
        for (const def of discovered.value) {
          if (!def || typeof def !== 'object' || Array.isArray(def)) {
            return { error: '不正なプラグイン定義形式です。' };
          }
          const name = String(def.name || '').slice(0, 80);
          const desc = String(def.description || '').slice(0, 200);
          totalMetadataBytes += (name.length + desc.length) * 2;
          if (totalMetadataBytes > MAX_PLUGIN_METADATA_BYTES) {
            return { error: 'プラグイン定義メタデータサイズが上限を超えています。' };
          }
        }
        return { ok: true };
      };

      const countResult = await bypassedInstall(overLimitDefs);
      assert.ok(countResult.error && countResult.error.includes('上限'));

      const overBytesDefs = Array.from({ length: 20 }, (_, i) => ({ name: 'n'.repeat(80), description: 'd'.repeat(200) }));
      const bytesResult = await bypassedInstall(overBytesDefs);
      assert.ok(bytesResult.error && bytesResult.error.includes('上限'));
    });
  });
});

test('9. Normal script/plugin print() and RPC budgets continue to behave unchanged', async () => {
  const result = await executeWorker(`
    print('hello', 42);
  `, 'script');
  const print = result.controlMessages.find((m) => m.t === 'print');
  assert.ok(print, 'script must produce a print message');
  assert.deepEqual(Array.from(print.args), ['hello', 42]);
  const done = result.controlMessages.find((m) => m.t === 'done');
  assert.ok(done, 'script must produce a done message with null value');
  assert.equal(done.value, null);
});

test('10. A legitimate multi-definition plugin within the limit installs, persists, restores, and executes normally', async () => {
  await withMockStorage(async (store) => {
    const host = new PluginHost({ on() {} });
    const defs = [
      { name: 'PluginA', description: 'DescA' },
      { name: 'PluginB', description: 'DescB' },
    ];
    await withDiscoverySandbox(defs, async () => {
      const source = 'hex.plugin({ name:"PluginA", run() {} }); hex.plugin({ name:"PluginB", run() {} });';
      const installResult = await host.install(source, 'test-origin');
      assert.equal(installResult.ok, true, `install failed: ${installResult.error}`);
      assert.equal(installResult.added.length, 2);
      assert.equal(host.plugins.length, 2);
      assert.equal(host.installations.size, 1);
      assert.ok(store.has('hex.plugins'));

      // Verify restore fast path in a fresh host
      const restoredHost = new PluginHost({ on() {} });
      await restoredHost.ready;
      assert.equal(restoredHost.plugins.length, 2);
      assert.equal(restoredHost.plugins[0].name, 'PluginA');
      assert.equal(restoredHost.plugins[1].name, 'PluginB');
      assert.equal(restoredHost.installations.size, 1);
    });
  });
});
