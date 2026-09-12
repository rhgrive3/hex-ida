import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const modulePath = new URL('../js/userscript/protected-workers.js', import.meta.url);
const source = fs.readFileSync(modulePath, 'utf8')
  .replace(/^import[^\n]*;\n/gm, '')
  .replace(/^export /gm, '');

const assets = {
  wasm: 'AAECAwQ=',
  classic: { 'js/worker.js': '/*classic*/' },
  modules: {},
};

let objectUrls = 0;
const revoked = [];
class FakeURL {
  constructor(path, base) { this.href = base ? new URL(String(path), String(base)).href : String(path); }
  toString() { return this.href; }
  static createObjectURL() { return `blob:protected-${++objectUrls}`; }
  static revokeObjectURL(url) { revoked.push(url); }
}
class FakeBlob { constructor(parts, options) { this.parts = parts; this.options = options; } }

const pagehide = [];
const context = vm.createContext({
  console, atob, URL: FakeURL, Blob: FakeBlob,
  location: { href: 'https://hex.invalid/' },
  addEventListener(type, handler, options) { if (type === 'pagehide') pagehide.push({ handler, options }); },
  removeEventListener(type, handler) {
    if (type === 'pagehide') {
      const at = pagehide.findIndex((entry) => entry.handler === handler);
      if (at >= 0) pagehide.splice(at, 1);
    }
  },
  PROTECTED_WORKER_ASSETS: assets,
});

vm.runInContext('globalThis.NativeWorker = function NativeWorker(){}; globalThis.Worker = NativeWorker;', context);
vm.runInContext(source, context, { filename: String(modulePath) });
const ev = (expr) => vm.runInContext(expr, context);
const install = () => ev('installProtectedWorkers()');
const currentRuntime = () => ev('globalThis.__HEX_WORKER_RUNTIME__');
const workerOverridden = () => ev('globalThis.Worker !== globalThis.NativeWorker');

const runtimeA = install();
assert.equal(currentRuntime(), runtimeA, 'install registers its own runtime');
assert.equal(workerOverridden(), true, 'install overrides Worker');

runtimeA.cleanup();
assert.equal(currentRuntime(), undefined, 'own cleanup removes its registration');
assert.equal(workerOverridden(), false, 'own cleanup restores the native Worker');

const runtimeB = install();
assert.equal(currentRuntime(), runtimeB, 'reinstall registers the new runtime');
assert.equal(workerOverridden(), true, 'reinstall overrides Worker again');

runtimeA.cleanup();
assert.equal(workerOverridden(), true, 'stale cleanup must not restore the native Worker under a newer override');
assert.equal(currentRuntime(), runtimeB, 'stale cleanup must not delete a newer runtime registration');
assert.equal(
  workerOverridden() && currentRuntime() === undefined, false,
  'Worker override and runtime bookkeeping must never disagree',
);

const stalePagehide = pagehide[0];
stalePagehide.handler();
stalePagehide.handler();
assert.equal(currentRuntime(), runtimeB, 'stale pagehide after cleanup must not disturb the current runtime');
assert.equal(workerOverridden(), true, 'stale pagehide must not restore the native Worker under a newer override');

runtimeB.cleanup();
assert.equal(currentRuntime(), undefined, 'current cleanup removes the live registration');
assert.equal(workerOverridden(), false, 'current cleanup restores the native Worker');

runtimeB.cleanup();
assert.equal(currentRuntime(), undefined, 'cleanup is idempotent');

const runtimeC = install();
assert.equal(currentRuntime(), runtimeC, 'fresh install after cleanup succeeds');
pagehide.at(-1).handler();
assert.equal(currentRuntime(), undefined, 'a live runtime reacts to its own pagehide');
assert.equal(workerOverridden(), false, 'pagehide cleanup restores the native Worker');
runtimeC.cleanup();

console.log('issue 5017 protected worker cleanup ownership regression: ok');
