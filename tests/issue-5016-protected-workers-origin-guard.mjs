// Regression for #5016: installProtectedWorkers() must only swap a Worker URL
// into the embedded Hex Blob asset when the requested URL is same-origin with
// the protected page. A cross-origin URL whose pathname collides with an
// embedded worker (e.g. https://example.invalid/js/worker.js) must be handed
// to the native Worker unchanged and must not receive Hex bootstrap messages.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

const PAGE = { href: 'https://app.hex.invalid/userscript/entry.js', origin: 'https://app.hex.invalid' };
const ASSETS = {
  wasm: Buffer.from('fake-capstone-wasm-bytes').toString('base64'),
  classic: {
    'js/worker.js': '// synthetic embedded classic worker\n',
    'js/platform/capstone-probe-worker.js': '// synthetic\n',
  },
  modules: {
    'js/platform/worker.js': '// synthetic embedded module worker\n',
    'js/targets/architecture/x86_64/semantic-revalidation-worker.js': '// synthetic\n',
  },
};

const source = await readFile(new URL('../js/userscript/protected-workers.js', import.meta.url), 'utf8');
assert.ok(/^import \{ PROTECTED_WORKER_ASSETS \} from/m.test(source), 'protected-workers.js must import PROTECTED_WORKER_ASSETS');

const assetsURL = new URL(`data:text/javascript,export const PROTECTED_WORKER_ASSETS=${JSON.stringify(ASSETS)};`);
const instrumented = source.replace(
  /'\.\.\/\.\.\/\.runtime-build\/embedded-assets\.js'/,
  JSON.stringify(assetsURL.href),
).replace("'./runtime-host-location.js'", JSON.stringify(new URL('../js/userscript/runtime-host-location.js', import.meta.url).href));

const nativeCalls = [];
class FakeNativeWorker {
  constructor(value, options) {
    this.value = value;
    this.options = options;
    this.messages = [];
    this.terminated = false;
    nativeCalls.push(this);
  }
  postMessage(message, transfer) { this.messages.push({ message, transfer }); }
  terminate() { this.terminated = true; }
}

const previous = {
  location: globalThis.location,
  Worker: globalThis.Worker,
  addEventListener: globalThis.addEventListener,
  runtime: globalThis.__HEX_WORKER_RUNTIME__,
  host: globalThis.__HEX_RUNTIME_HOST_LOCATION__,
  hostHref: globalThis.__HEX_RUNTIME_HOST_HREF__,
  hostOrigin: globalThis.__HEX_RUNTIME_HOST_ORIGIN__,
};
globalThis.location = PAGE;
globalThis.Worker = FakeNativeWorker;
globalThis.addEventListener = () => {};
delete globalThis.__HEX_WORKER_RUNTIME__;

let runtime;
try {
  const moduleURL = new URL(`data:text/javascript,${encodeURIComponent(instrumented)}`);
  const { installProtectedWorkers } = await import(moduleURL.href);
  for (const context of ['http', 'opaque-object', 'opaque-primitive']) {
    globalThis.location = context === 'http' ? PAGE : { href: 'about:srcdoc', origin: 'null' };
    delete globalThis.__HEX_RUNTIME_HOST_HREF__;
    delete globalThis.__HEX_RUNTIME_HOST_ORIGIN__;
    delete globalThis.__HEX_RUNTIME_HOST_LOCATION__;
    if (context === 'opaque-object') globalThis.__HEX_RUNTIME_HOST_LOCATION__ = PAGE;
    if (context === 'opaque-primitive') {
      globalThis.__HEX_RUNTIME_HOST_HREF__ = PAGE.href;
      globalThis.__HEX_RUNTIME_HOST_ORIGIN__ = PAGE.origin;
    }
    runtime = installProtectedWorkers();
    assert.ok(runtime.workers.get('js/worker.js'), 'embedded classic asset registered');
    assert.ok(runtime.workers.get('js/platform/worker.js'), 'embedded module asset registered');

    // 1. The exact counterexample from the issue: cross-origin collision must pass through.
    const foreign = 'https://example.invalid/js/worker.js';
    const worker = new Worker(foreign);
    assert.equal(worker.value, foreign, 'cross-origin Worker URL must reach the native Worker unchanged');
    assert.notEqual(worker.value, runtime.workers.get('js/worker.js'), 'cross-origin URL must not be swapped into the embedded Hex Blob');
    assert.deepEqual(worker.messages, [], 'no Hex WASM bootstrap may be posted to a cross-origin worker');

    // 2. Cross-origin module pathname collision must pass through without nested bootstrap.
    const foreignModule = 'https://evil.invalid/js/platform/worker.js';
    const foreignModuleWorker = new Worker(foreignModule, { type: 'module' });
    assert.equal(foreignModuleWorker.value, foreignModule);
    assert.equal(foreignModuleWorker.options.type, 'module');
    assert.deepEqual(foreignModuleWorker.messages, [], 'no nested-worker bootstrap may be posted to a cross-origin worker');

    // 3. Positive control: same-origin owned URLs keep being replaced by the embedded Blob.
    const ownedClassic = 'https://app.hex.invalid/js/worker.js';
    const ownedWorker = new Worker(ownedClassic);
    assert.equal(ownedWorker.value, runtime.workers.get('js/worker.js'), 'same-origin owned classic URL must be replaced');
    assert.equal(ownedWorker.messages.length, 1, 'same-origin owned classic worker receives its WASM bootstrap');
    assert.equal(ownedWorker.messages[0].message.t, '__hex_capstone_wasm__');

    const ownedRelative = new Worker('/js/platform/worker.js', { type: 'module' });
    assert.equal(ownedRelative.value, runtime.workers.get('js/platform/worker.js'), 'same-origin relative module URL must be replaced');
    assert.equal(ownedRelative.messages.length, 1, 'same-origin platform worker receives its nested bootstrap');
    assert.equal(ownedRelative.messages[0].message.t, '__hex_nested_worker_runtime__');
    assert.equal(ownedRelative.messages[0].message.semanticURL, runtime.workers.get('js/targets/architecture/x86_64/semantic-revalidation-worker.js'), 'absent optional asset lookup must not leak a stale bootstrap');

    // 4. Same-origin URL that is not an owned asset passes through untouched.
    const unowned = `${PAGE.origin}/js/some-other-worker.js`;
    const unownedWorker = new Worker(unowned);
    assert.equal(unownedWorker.value, unowned, 'same-origin non-owned URL must reach the native Worker unchanged');
    runtime.cleanup();
  }
  globalThis.location = { href: 'about:srcdoc', origin: 'null' };
  delete globalThis.__HEX_RUNTIME_HOST_HREF__;
  delete globalThis.__HEX_RUNTIME_HOST_ORIGIN__;
  for (const host of [undefined, { href: 'about:srcdoc', origin: 'null' }, { href: 'invalid', origin: 'invalid' }]) {
    globalThis.__HEX_RUNTIME_HOST_LOCATION__ = host;
    runtime = installProtectedWorkers();
    for (const value of [`${PAGE.origin}/js/worker.js`, '/js/worker.js', 'https://foreign.invalid/js/worker.js']) {
      const worker = new Worker(value);
      assert.equal(worker.value, value, 'missing or invalid host authority must pass through');
      assert.deepEqual(worker.messages, []);
    }
    runtime.cleanup();
  }
} finally {
  if (runtime) runtime.cleanup();
  for (const [name, value] of [['__HEX_RUNTIME_HOST_LOCATION__', previous.host], ['__HEX_RUNTIME_HOST_HREF__', previous.hostHref], ['__HEX_RUNTIME_HOST_ORIGIN__', previous.hostOrigin]]) {
    if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
  }
  if (previous.location === undefined) delete globalThis.location; else globalThis.location = previous.location;
  if (previous.Worker === undefined) delete globalThis.Worker; else globalThis.Worker = previous.Worker;
  if (previous.addEventListener === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = previous.addEventListener;
  if (previous.runtime === undefined) delete globalThis.__HEX_WORKER_RUNTIME__; else globalThis.__HEX_WORKER_RUNTIME__ = previous.runtime;
}

console.log('issue #5016 protected-workers origin-guard regressions PASS');
