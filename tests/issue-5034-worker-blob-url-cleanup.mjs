/* #5034: a partial worker-installer failure must revoke every Blob URL the
   failed attempt created (and must not revoke anything on success until the
   runtime cleanup owns them). */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { prepareUserscriptWorkers } from '../js/userscript/worker-assets.js';

const origin = 'https://api.hex.invalid';

function assetResponses(responses) {
  const byURL = new Map(Object.entries(responses).map(([path, value]) => [`${origin}/userscript-assets/${path}`, value]));
  return (input) => {
    const response = byURL.get(String(input));
    if (!response) return Promise.reject(new Error(`unexpected fetch: ${String(input)}`));
    return Promise.resolve({
      ok: response.ok !== false,
      status: response.status ?? 200,
      text: async () => response.text ?? '',
      arrayBuffer: async () => response.buffer ?? new ArrayBuffer(8),
    });
  };
}

async function runWorkerAssetsScenario({ manifest, responses, body }) {
  const created = [];
  const revoked = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { const url = `blob:hex-5034-${created.length + 1}`; created.push(url); return url; };
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  const nativeWorker = class { constructor(url) { this.url = url; } terminate() {} };
  const saved = {
    fetch: globalThis.fetch,
    worker: globalThis.Worker,
    addEventListener: globalThis.addEventListener,
    runtime: globalThis.__HEX_WORKER_RUNTIME__,
  };
  globalThis.fetch = assetResponses(responses);
  globalThis.Worker = nativeWorker;
  globalThis.addEventListener = () => {};
  delete globalThis.__HEX_WORKER_RUNTIME__;
  try {
    await body({ nativeWorker, manifest, created, revoked });
    return { created: [...created], revoked: [...revoked] };
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    globalThis.fetch = saved.fetch;
    if (saved.worker === undefined) delete globalThis.Worker; else globalThis.Worker = saved.worker;
    if (saved.addEventListener === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = saved.addEventListener;
    if (saved.runtime === undefined) delete globalThis.__HEX_WORKER_RUNTIME__; else globalThis.__HEX_WORKER_RUNTIME__ = saved.runtime;
  }
}

function assertFullyRevoked({ created, revoked }) {
  assert.ok(created.length > 0, 'the scenario must create at least one Blob URL');
  assert.equal(revoked.length, created.length, 'every created Blob URL must be revoked exactly once');
  for (const url of created) {
    assert.equal(revoked.filter((value) => value === url).length, 1, `${url} must be revoked exactly once`);
  }
}

const legacyManifest = ({ classicEntries, classicAssets, moduleBundles }) => ({
  wasm: 'capstone.wasm',
  classicAssets,
  classicEntries,
  moduleBundles,
});

await runWorkerAssetsScenario({
  manifest: legacyManifest({ classicAssets: ['workers/a.js', 'workers/b.js'], classicEntries: ['workers/a.js', 'workers/b.js'], moduleBundles: {} }),
  responses: {
    'capstone.wasm': { buffer: new ArrayBuffer(16) },
    'workers/a.js': { text: 'self.onmessage = () => {};' },
    'workers/b.js': { text: 'importScripts("missing.js");' },
  },
  body: async ({ manifest }) => {
    const error = await prepareUserscriptWorkers({ origin, manifest })
      .then(() => null, (reason) => reason);
    assert.ok(error instanceof Error, 'inlineImportScripts failure must reject the installer');
    assert.match(error.message, /Hex worker source missing from manifest/);
  },
}).then(assertFullyRevoked);

await runWorkerAssetsScenario({
  manifest: legacyManifest({
    classicAssets: ['workers/a.js'],
    classicEntries: ['workers/a.js'],
    moduleBundles: { 'workers/m1.js': 'bundles/m1.js', 'workers/m2.js': 'bundles/m2.js' },
  }),
  responses: {
    'capstone.wasm': { buffer: new ArrayBuffer(16) },
    'workers/a.js': { text: 'self.onmessage = () => {};' },
    'bundles/m1.js': { text: 'self.onmessage = () => {};' },
    'bundles/m2.js': { ok: false, status: 500 },
  },
  body: async ({ manifest }) => {
    const error = await prepareUserscriptWorkers({ origin, manifest }).then(() => null, (reason) => reason);
    assert.ok(error instanceof Error, 'a module bundle fetch failure must reject the installer');
    assert.match(error.message, /Could not load Hex module worker workers\/m2\.js \(500\)/);
  },
}).then(assertFullyRevoked);

for (let attempt = 0; attempt < 2; attempt++) {
  await runWorkerAssetsScenario({
    manifest: legacyManifest({ classicAssets: ['workers/a.js', 'workers/b.js'], classicEntries: ['workers/a.js', 'workers/b.js'], moduleBundles: {} }),
    responses: {
      'capstone.wasm': { buffer: new ArrayBuffer(16) },
      'workers/a.js': { text: 'self.onmessage = () => {};' },
      'workers/b.js': { text: 'importScripts("missing.js");' },
    },
    body: async ({ manifest }) => {
      await prepareUserscriptWorkers({ origin, manifest }).then(() => null, (reason) => reason);
      assert.equal(globalThis.__HEX_WORKER_RUNTIME__, undefined, 'a failed attempt must not publish a runtime');
    },
  }).then(assertFullyRevoked);
}

await runWorkerAssetsScenario({
  manifest: legacyManifest({ classicAssets: ['workers/a.js'], classicEntries: ['workers/a.js'], moduleBundles: {} }),
  responses: {
    'workers/a.js': { text: 'self.onmessage = () => {};' },
    'capstone.wasm': { ok: false, status: 404 },
  },
  body: async ({ manifest }) => {
    const error = await prepareUserscriptWorkers({ origin, manifest }).then(() => null, (reason) => reason);
    assert.ok(error instanceof Error, 'a WASM fetch failure must reject the installer');
    assert.match(error.message, /Could not load capstone\.wasm \(404\)/);
  },
}).then((outcome) => {
  assert.deepEqual(outcome.created, [], 'no Blob URL may be created before the WASM response is ok');
  assert.deepEqual(outcome.revoked, [], 'nothing may be revoked when nothing was created');
});

await runWorkerAssetsScenario({
  manifest: legacyManifest({
    classicAssets: ['workers/entry.js', 'workers/lib.js'],
    classicEntries: ['workers/entry.js'],
    moduleBundles: { 'workers/module.js': 'bundles/module.js' },
  }),
  responses: {
    'capstone.wasm': { buffer: new ArrayBuffer(16) },
    'workers/entry.js': { text: 'importScripts("lib.js");\nself.onmessage = () => {};' },
    'workers/lib.js': { text: 'globalThis.hexLib = true;' },
    'bundles/module.js': { text: 'self.onmessage = () => {};' },
  },
  body: async ({ nativeWorker, manifest }) => {
    const runtime = await prepareUserscriptWorkers({ origin, manifest });
    assert.equal(globalThis.__HEX_WORKER_RUNTIME__, runtime, 'the success runtime must own cleanup');
    assert.notEqual(globalThis.Worker, nativeWorker, 'the Worker override must be installed on success');
    assert.equal(runtime.cleanup(), undefined);
  },
}).then(({ created, revoked }) => {
  assert.equal(created.length, 3, 'WASM + classic entry + module bundle URLs');
  assert.deepEqual(revoked, created, 'cleanup must revoke each owned URL exactly once');
});

const hostLocationSource = (await readFile(new URL('../js/userscript/runtime-host-location.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
const protectedSource = hostLocationSource + '\n' + (await readFile(new URL('../js/userscript/protected-workers.js', import.meta.url), 'utf8'))
  .replace(
    "import { PROTECTED_WORKER_ASSETS } from '../../.runtime-build/embedded-assets.js';",
    'const PROTECTED_WORKER_ASSETS = globalThis.__HEX_TEST_PROTECTED_ASSETS__;',
  )
  .replace(/^import .* from '\.\/runtime-host-location\.js';\n/m, '')
  .replace('export function installProtectedWorkers', 'function installProtectedWorkers');

const protectedAssets = {
  wasm: Buffer.from('capstone-wasm-fixture-5034').toString('base64'),
  classic: {
    'js/worker.js': 'self.onmessage = () => {};',
    'js/platform/capstone-probe-worker.js': 'self.onmessage = () => {};',
  },
  modules: {
    'js/platform/worker.js': 'self.onmessage = () => {};',
    'js/targets/architecture/x86_64/semantic-revalidation-worker.js': 'self.onmessage = () => {};',
  },
};

function runProtectedScenario({ failOnCreate, failPagehide = false, foreign = null }) {
  const created = [];
  const revoked = [];
  const pagehide = [];
  const nativeWorker = class { constructor(url) { this.url = url; } postMessage() {} terminate() {} };
  const context = vm.createContext({
    Blob: class { constructor(parts, options) { this.parts = parts; this.options = options; } },
    URL: {
      createObjectURL() {
        if (created.length >= failOnCreate) throw new Error('create-object-url-denied');
        const url = `blob:protected-5034-${created.length + 1}`;
        created.push(url);
        return url;
      },
      revokeObjectURL(url) { revoked.push(url); },
    },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Worker: nativeWorker,
    addEventListener: (type, handler) => {
      if (failPagehide) {
        if (foreign) { context.Worker = foreign.worker; context.__HEX_WORKER_RUNTIME__ = foreign.runtime; }
        throw new Error('pagehide-registration-denied');
      }
      if (type === 'pagehide') pagehide.push(handler);
    },
    __HEX_TEST_PROTECTED_ASSETS__: protectedAssets,
  });
  vm.runInContext(`${protectedSource}\nglobalThis.__install = installProtectedWorkers;`, context);
  let error = null;
  let runtime = null;
  try { runtime = vm.runInContext('__install()', context); } catch (reason) { error = reason; }
  return { error, runtime, created, revoked, context, nativeWorker, pagehide };
}

function assertProtectedFailure(outcome, stagePattern) {
  assert.ok(outcome.error, 'the installer must rethrow the stage failure');
  assert.match(outcome.error.message, stagePattern);
  assertFullyRevoked(outcome);
  assert.equal(outcome.context.Worker, outcome.nativeWorker, 'a failed install must leave the native Worker');
  assert.equal(outcome.context.__HEX_WORKER_RUNTIME__, undefined, 'a failed install must not publish a runtime');
}

assertProtectedFailure(
  runProtectedScenario({ failOnCreate: 2 }),
  /protected classic worker Blob \(js\/platform\/capstone-probe-worker\.js\): create-object-url-denied/,
);

assertProtectedFailure(
  runProtectedScenario({ failOnCreate: 4 }),
  /protected module worker Blob \(js\/targets\/architecture\/x86_64\/semantic-revalidation-worker\.js\): create-object-url-denied/,
);

for (let attempt = 0; attempt < 2; attempt++) {
  assertProtectedFailure(runProtectedScenario({ failOnCreate: 2 }), /create-object-url-denied/);
}

{
  const outcome = runProtectedScenario({ failOnCreate: Number.POSITIVE_INFINITY });
  assert.equal(outcome.error, null, 'the success install must not throw');
  assert.equal(outcome.created.length, 5, 'WASM + 2 classic + 2 module URLs');
  assert.deepEqual(outcome.revoked, [], 'the fresh success runtime must not have revoked anything yet');
  assert.notEqual(outcome.context.Worker, outcome.nativeWorker, 'the Worker override must be installed on success');
  assert.equal(outcome.pagehide.length, 1, 'pagehide cleanup is registered');
  outcome.runtime.cleanup();
  assert.deepEqual(outcome.revoked, outcome.created, 'cleanup must revoke each owned URL exactly once');
  assert.equal(outcome.context.Worker, outcome.nativeWorker, 'cleanup must restore the native Worker');
  assert.equal(outcome.context.__HEX_WORKER_RUNTIME__, undefined, 'cleanup must retire the runtime');
}

for (const replaceOwner of [false, true]) {
  await runWorkerAssetsScenario({
    manifest: legacyManifest({ classicAssets: ['workers/a.js'], classicEntries: ['workers/a.js'], moduleBundles: {} }),
    responses: { 'capstone.wasm': { buffer: new ArrayBuffer(16) }, 'workers/a.js': { text: '' } },
    body: async ({ nativeWorker, manifest, created, revoked }) => {
      const foreignWorker = class {};
      const foreignRuntime = {};
      globalThis.addEventListener = () => {
        if (replaceOwner) { globalThis.Worker = foreignWorker; globalThis.__HEX_WORKER_RUNTIME__ = foreignRuntime; }
        throw new Error('pagehide-registration-denied');
      };
      await assert.rejects(prepareUserscriptWorkers({ origin, manifest }), /pagehide-registration-denied/);
      assert.equal(globalThis.Worker, replaceOwner ? foreignWorker : nativeWorker, 'failed registration restores only its own Worker');
      assert.equal(globalThis.__HEX_WORKER_RUNTIME__, replaceOwner ? foreignRuntime : undefined);
      assertFullyRevoked({ created, revoked });
      if (replaceOwner) return;
      const failedCount = created.length;
      globalThis.addEventListener = () => {};
      const runtime = await prepareUserscriptWorkers({ origin, manifest });
      assert.equal(globalThis.__HEX_WORKER_RUNTIME__, runtime);
      assert.notEqual(globalThis.Worker, nativeWorker);
      assert.equal(revoked.length, failedCount, 'retry URLs remain live until cleanup');
      runtime.cleanup();
      assertFullyRevoked({ created, revoked });
      assert.equal(globalThis.Worker, nativeWorker);
      assert.equal(globalThis.__HEX_WORKER_RUNTIME__, undefined);
    },
  });
}

{
  const outcome = runProtectedScenario({ failOnCreate: Infinity, failPagehide: true });
  assertProtectedFailure(outcome, /pagehide-registration-denied/);
  const failedCount = outcome.created.length;
  outcome.context.addEventListener = () => {};
  const runtime = vm.runInContext('__install()', outcome.context);
  assert.equal(outcome.context.__HEX_WORKER_RUNTIME__, runtime);
  assert.notEqual(outcome.context.Worker, outcome.nativeWorker);
  assert.equal(outcome.created.length, failedCount * 2, 'retry creates fresh URLs');
  assert.equal(outcome.revoked.length, failedCount, 'retry URLs remain live until cleanup');
  runtime.cleanup();
  assertFullyRevoked(outcome);
  assert.equal(outcome.context.Worker, outcome.nativeWorker);
  assert.equal(outcome.context.__HEX_WORKER_RUNTIME__, undefined);
}

{
  const foreign = { worker: class {}, runtime: {} };
  const outcome = runProtectedScenario({ failOnCreate: Infinity, failPagehide: true, foreign });
  assert.match(outcome.error.message, /pagehide-registration-denied/);
  assertFullyRevoked(outcome);
  assert.equal(outcome.context.Worker, foreign.worker, 'rollback preserves a replacement Worker');
  assert.equal(outcome.context.__HEX_WORKER_RUNTIME__, foreign.runtime, 'rollback preserves a replacement runtime');
}

console.log('issue #5034 worker blob URL failure-cleanup regressions PASS');
