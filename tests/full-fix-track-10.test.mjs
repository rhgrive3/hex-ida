import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  beginRuntimeBootstrapIssuance,
  RUNTIME_BOOTSTRAP_ADMISSION,
} from '../js/userscript/runtime-bootstrap-admission.js';
import {
  DomSkillRegistry,
  normalizeSkillManifest,
} from '../js/userscript/dev/skills/dom-skill-registry.js';
import {
  INPUT_BUDGET,
  buildWorkerProgram,
  loadSandboxRpcEstimators,
} from './support/sandbox-rpc-estimators.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ===========================================================================
// 1. [P1] js/sandbox.js — null/undefined heavy array RPC budget bypass (DoS)
// ===========================================================================

test('FullFix-Track10-1: Worker measure() and host valueSize() charge large null/undefined arrays against the 4 MiB RPC budget', () => {
  const { measure, prepareRpcArgs, valueSize, cloneCalls } = loadSandboxRpcEstimators();
  const hostSize = (v) => valueSize(v, new Set(), INPUT_BUDGET + 1);

  for (const [label, payload] of [
    ['null array (600k)', new Array(600_000).fill(null)],
    ['undefined array (600k)', new Array(600_000).fill(undefined)],
    ['nested null arrays (1000 x 600)', Array.from({ length: 1000 }, () => new Array(600).fill(null))],
    ['empty string array (600k)', new Array(600_000).fill('')],
    ['aliased object array (600k)', (() => { const o = {}; return new Array(600_000).fill(o); })()],
  ]) {
    cloneCalls.count = 0;
    const args = [payload];
    assert.ok(measure(args) > INPUT_BUDGET, `worker measure() must reject ${label}`);
    assert.ok(hostSize(args) > INPUT_BUDGET, `host valueSize() must reject ${label}`);
    assert.equal(prepareRpcArgs(args, INPUT_BUDGET), null, `prepareRpcArgs() must reject ${label}`);
    assert.equal(cloneCalls.count, 0, `${label} must be rejected before structuredClone()`);
  }

  // Medium-sized null arrays must accumulate across multiple RPCs and agree between worker & host
  const medium = [new Array(100_000).fill(null)];
  const workerMedium = measure(medium);
  const hostMedium = hostSize(medium);
  assert.equal(workerMedium, hostMedium, 'worker and host must agree on null-array slot cost');
  assert.ok(workerMedium > 500_000, '100k null array must carry meaningful slot cost');
  assert.ok(workerMedium * 6 > INPUT_BUDGET, 'repeated medium null arrays must exhaust cumulative 4 MiB budget');

  // Existing small-array compatibility preserved
  assert.equal(measure([1, 'x', null]), 34);
  assert.equal(hostSize([1, 'x', null]), 34);
});

test('FullFix-Track10-1: WORKER_PRELUDE rejects oversized null/undefined RPC array before sending rpc message', async () => {
  const program = buildWorkerProgram(`
    const __hexRun = async () => {
      const userBody = async function(hex, print) {
        let err1 = null;
        try {
          await hex.ping(new Array(600_000).fill(null));
        } catch (e) {
          err1 = e.message;
        }
        let err2 = null;
        try {
          await hex.ping(new Array(600_000).fill(undefined));
        } catch (e) {
          err2 = e.message;
        }
        print(err1, err2);
      };
      await userBody(hex, print);
      send({ t: 'done', value: null });
    };
  `);

  const controlSent = [];
  const realm = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    structuredClone,
    importScripts() {},
    postMessage() {},
    close() {},
  });
  realm.globalThis = realm;
  realm.self = realm;

  vm.runInContext(program, realm);
  const controlPort = {
    postMessage(msg) { controlSent.push(msg); },
    start() {},
    onmessage: null,
  };
  realm.self.onmessage({ data: { t: 'start' }, ports: [controlPort] });
  await new Promise((r) => setTimeout(r, 150));

  const rpcMsgs = controlSent.filter((m) => m.t === 'rpc');
  const budgetMsgs = controlSent.filter((m) => m.t === 'budgetExceeded');
  assert.equal(rpcMsgs.length, 0, 'oversized null/undefined arrays must never be sent over RPC');
  assert.equal(budgetMsgs.length, 2, 'both null and undefined oversized arrays must trigger budgetExceeded');
});

// ===========================================================================
// 2. [P1] js/userscript/runtime-bootstrap-admission.js — prototype key bypass
// ===========================================================================

function createMemoryStorage({ roundTripJson = false } = {}) {
  const store = new Map();
  const clone = (v) => {
    if (v === undefined) return undefined;
    if (roundTripJson) return JSON.parse(JSON.stringify(v));
    return structuredClone(v);
  };
  const txApi = {
    async get(key) {
      return store.has(key) ? clone(store.get(key)) : undefined;
    },
    async put(key, value) {
      store.set(key, clone(value));
    },
    async delete(key) {
      if (Array.isArray(key)) {
        for (const k of key) store.delete(k);
      } else {
        store.delete(key);
      }
    },
    async list({ prefix = '', limit = Infinity } = {}) {
      const out = new Map();
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      for (const k of keys) {
        if (out.size >= limit) break;
        out.set(k, clone(store.get(k)));
      }
      return out;
    },
  };
  return {
    raw: store,
    async transaction(fn) {
      return fn(txApi);
    },
    async list(opts) {
      return txApi.list(opts);
    },
    async delete(key) {
      return txApi.delete(key);
    },
  };
}

test('FullFix-Track10-2: prototype-inherited bucket keys cannot bypass per-bucket rate limits', async () => {
  const protoKeys = ['toString', '__proto__', 'constructor', 'valueOf', 'hasOwnProperty'];
  const policy = {
    ...RUNTIME_BOOTSTRAP_ADMISSION,
    maxBucketPerWindow: 2,
    maxGlobalPerWindow: 100,
    maxConcurrent: 50,
    maxOutstanding: 100,
    maxOutstandingPerBucket: 50,
    maxTrackedBuckets: 32,
  };
  const now = 1_700_000_000_000;

  for (const roundTripJson of [false, true]) {
    const storage = createMemoryStorage({ roundTripJson });
    let seq = 0;

    for (const bucket of protoKeys) {
      const r1 = await beginRuntimeBootstrapIssuance(storage, {
        nonce: `n-${bucket}-${++seq}`,
        sessionId: `s-${bucket}-${seq}`,
        requestId: `req-${bucket}-${seq}`,
        bucket,
        expiry: now + 60_000,
      }, { now, policy, randomId: () => `lease-${seq}` });
      assert.equal(r1.ok, true, `1st request for ${bucket} (json=${roundTripJson}) should succeed`);

      const r2 = await beginRuntimeBootstrapIssuance(storage, {
        nonce: `n-${bucket}-${++seq}`,
        sessionId: `s-${bucket}-${seq}`,
        requestId: `req-${bucket}-${seq}`,
        bucket,
        expiry: now + 60_000,
      }, { now, policy, randomId: () => `lease-${seq}` });
      assert.equal(r2.ok, true, `2nd request for ${bucket} (json=${roundTripJson}) should succeed`);

      const r3 = await beginRuntimeBootstrapIssuance(storage, {
        nonce: `n-${bucket}-${++seq}`,
        sessionId: `s-${bucket}-${seq}`,
        requestId: `req-${bucket}-${seq}`,
        bucket,
        expiry: now + 60_000,
      }, { now, policy, randomId: () => `lease-${seq}` });
      assert.equal(r3.ok, false, `3rd request for ${bucket} (json=${roundTripJson}) must be rate-limited`);
      assert.equal(r3.reason, 'bootstrap-bucket-rate-limit');
    }

    assert.equal(({}).count, undefined, 'Object.prototype must not be polluted');
    const rate = storage.raw.get('admission:rate');
    for (const bucket of protoKeys) {
      assert.equal(Object.hasOwn(rate.buckets, bucket), true, `rate.buckets must store own key ${bucket}`);
      assert.equal(rate.buckets[bucket].count, 2, `${bucket} count must be 2`);
    }
  }
});

test('FullFix-Track10-2: prototype-inherited bucket keys cannot bypass maxTrackedBuckets capacity cap', async () => {
  const storage = createMemoryStorage();
  const now = 1_700_000_000_000;
  const policy = {
    ...RUNTIME_BOOTSTRAP_ADMISSION,
    maxTrackedBuckets: 1,
    maxBucketPerWindow: 10,
  };

  const first = await beginRuntimeBootstrapIssuance(storage, {
    nonce: 'n-1',
    sessionId: 's-1',
    requestId: 'req-1',
    bucket: 'normal-bucket',
    expiry: now + 60_000,
  }, { now, policy, randomId: () => 'lease-1' });
  assert.equal(first.ok, true);

  for (const bucket of ['toString', '__proto__', 'constructor']) {
    const blocked = await beginRuntimeBootstrapIssuance(storage, {
      nonce: `n-${bucket}`,
      sessionId: `s-${bucket}`,
      requestId: `req-${bucket}`,
      bucket,
      expiry: now + 60_000,
    }, { now, policy, randomId: () => `lease-${bucket}` });
    assert.equal(blocked.ok, false, `${bucket} must not bypass maxTrackedBuckets`);
    assert.equal(blocked.reason, 'bootstrap-bucket-capacity');
  }
});

// ===========================================================================
// 3. [P2] js/userscript/dev/skills/dom-skill-registry.js — prototype program lookup
// ===========================================================================

function sampleManifest(version = '1.0.0') {
  return {
    skillId: 'track10-skill',
    version,
    description: 'Track 10 test skill',
    validationPrograms: ['read_title'],
    programs: {
      read_title: {
        name: 'read_title',
        version: '1',
        readOnly: true,
        steps: [{ op: 'readText', selector: '#root', as: 'title' }],
      },
    },
  };
}

test('FullFix-Track10-3: DomSkillRegistry returns program-missing instead of SyntaxError for prototype-inherited names', async () => {
  const manifest = normalizeSkillManifest(sampleManifest());
  assert.equal(Object.getPrototypeOf(manifest.programs), null, 'manifest.programs must have null prototype');

  const registry = new DomSkillRegistry({
    document: { querySelector: () => ({ textContent: 'Hello', innerText: 'Hello', tagName: 'DIV', childNodes: [] }) },
    location: { href: 'https://example.test/', origin: 'https://example.test', pathname: '/', search: '', hash: '' },
  });
  registry.installCandidate(sampleManifest('1.0.0'));
  await registry.validateCandidate({ skillId: 'track10-skill' });
  registry.activate({ skillId: 'track10-skill' });

  for (const badName of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    await assert.rejects(
      () => registry.run({ skillId: 'track10-skill', program: badName }),
      (err) => err?.code === 'program-missing' && !(err instanceof SyntaxError),
      `run({ program: '${badName}' }) must fail with program-missing`,
    );
  }

  // Candidate validation with prototype-inherited program names must also return program-missing
  registry.installCandidate(sampleManifest('1.1.0'));
  for (const badName of ['toString', 'constructor', 'valueOf']) {
    await assert.rejects(
      () => registry.validateCandidate({ skillId: 'track10-skill', programs: [badName] }),
      (err) => err?.code === 'program-missing',
      `validateCandidate({ programs: ['${badName}'] }) must fail with program-missing`,
    );
  }

  // Manifest normalization must reject unregistered prototype-inherited validationPrograms
  assert.throws(
    () => normalizeSkillManifest({ ...sampleManifest('1.2.0'), validationPrograms: ['toString'] }),
    (err) => err instanceof TypeError && /Validation program is unavailable: toString/.test(err.message),
  );
});

// ===========================================================================
// 4. [P2] js/plugins.js & js/tools.js — clear cached dynamic import() on reject
// ===========================================================================

function extractLoader(relPath, startMarker, endMarker, mockImportCode) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `${relPath} must contain ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `${relPath} must contain ${endMarker}`);
  const snippet = src.slice(start, end).replace(/\bimport\(/g, '__mockImport(');
  return new Function('__mockImport', `${snippet}\n${mockImportCode}`);
}

test('FullFix-Track10-4: js/plugins.js clears scriptSandboxPromise on rejection and retries on next call', async () => {
  const factory = extractLoader(
    'js/plugins.js',
    'let scriptSandboxPromise = null;',
    'function newInstallId()',
    'return { loadScriptSandbox, getCache: () => scriptSandboxPromise };',
  );

  let scriptCalls = 0;
  let sandboxCalls = 0;
  let failScript = true;
  let failSandbox = false;
  const mockCreateApi = () => 'api';
  const mockRunInSandbox = () => 'sandbox';

  const { loadScriptSandbox, getCache } = factory(async (spec) => {
    if (spec === './script.js') {
      scriptCalls++;
      if (failScript) throw new Error('transient script import error');
      return { createApi: mockCreateApi };
    }
    if (spec === './sandbox.js') {
      sandboxCalls++;
      if (failSandbox) throw new Error('transient sandbox import error');
      return { runInSandbox: mockRunInSandbox };
    }
    throw new Error(`unexpected specifier: ${spec}`);
  });

  // 1st attempt fails on script.js -> cache must reset to null
  await assert.rejects(() => loadScriptSandbox(), /transient script import error/);
  assert.equal(getCache(), null, 'scriptSandboxPromise must be cleared after rejection');

  // 2nd attempt fails on sandbox.js -> cache must reset to null
  failScript = false;
  failSandbox = true;
  await assert.rejects(() => loadScriptSandbox(), /transient sandbox import error/);
  assert.equal(getCache(), null, 'scriptSandboxPromise must be cleared after sandbox.js rejection');

  // 3rd attempt succeeds -> resolves and caches
  failSandbox = false;
  const loaded = await loadScriptSandbox();
  assert.equal(loaded.createApi, mockCreateApi);
  assert.equal(loaded.runInSandbox, mockRunInSandbox);
  assert.notEqual(getCache(), null, 'successful load must remain cached');

  // 4th call reuses cache without calling import() again
  const prevScriptCalls = scriptCalls;
  const prevSandboxCalls = sandboxCalls;
  const cached = await loadScriptSandbox();
  assert.equal(cached, loaded);
  assert.equal(scriptCalls, prevScriptCalls);
  assert.equal(sandboxCalls, prevSandboxCalls);
});

test('FullFix-Track10-4: js/tools.js clears _toolsBasePromise on rejection and retries on next call', async () => {
  const factory = extractLoader(
    'js/tools.js',
    'let _toolsBasePromise = null;',
    'const FACT =',
    'return { loadToolsBase, getCache: () => _toolsBasePromise };',
  );

  let calls = 0;
  let shouldFail = true;
  const fakeModule = { openTools: () => 'ok' };

  const { loadToolsBase, getCache } = factory(async (spec) => {
    assert.equal(spec, './tools-base.js');
    calls++;
    if (shouldFail) throw new Error('transient tools-base import error');
    return fakeModule;
  });

  // 1st attempt rejects -> cache cleared
  await assert.rejects(() => loadToolsBase(), /transient tools-base import error/);
  assert.equal(getCache(), null, '_toolsBasePromise must be cleared after rejection');
  assert.equal(calls, 1);

  // 2nd attempt succeeds -> resolves and stays cached
  shouldFail = false;
  const mod = await loadToolsBase();
  assert.equal(mod, fakeModule);
  assert.notEqual(getCache(), null);
  assert.equal(calls, 2);

  // 3rd attempt uses cache
  const cached = await loadToolsBase();
  assert.equal(cached, fakeModule);
  assert.equal(calls, 2);
});
