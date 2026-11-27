import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  INPUT_BUDGET,
  OUTPUT_BUDGET,
  loadSandboxRpcEstimators,
} from './support/sandbox-rpc-estimators.mjs';
import { runInSandbox } from '../js/sandbox.js';
import { sanitizeToolSchema, normalizeAITools, finalResultTool } from '../js/ai/provider/worker-protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ===========================================================================
// 1. P2-S02-001: js/sandbox.js — valueSize depth/node/DAG/non-plain & host rejection
// ===========================================================================

test('P2-S02-001: valueSize and measure fail closed on deep nesting without stack overflow', () => {
  const { measure, valueSize } = loadSandboxRpcEstimators();
  const hostSize = (v) => valueSize(v, new Set(), INPUT_BUDGET + 1);

  let deep = { leaf: 1 };
  for (let i = 0; i < 120; i++) deep = { next: deep };

  assert.equal(hostSize(deep), INPUT_BUDGET + 1, 'host valueSize must fail closed past depth 64');
  assert.equal(measure(deep), INPUT_BUDGET + 1, 'worker measure must fail closed past depth 64');

  // Extreme depth that would otherwise cause RangeError: Maximum call stack size exceeded
  let veryDeep = { leaf: 1 };
  for (let i = 0; i < 20_000; i++) veryDeep = { next: veryDeep };
  assert.doesNotThrow(() => {
    assert.equal(hostSize(veryDeep), INPUT_BUDGET + 1);
    assert.equal(measure(veryDeep), INPUT_BUDGET + 1);
  });

  // Shallow nesting within depth limit still succeeds normally
  let okNested = { leaf: 'ok' };
  for (let i = 0; i < 32; i++) okNested = { next: okNested };
  assert.ok(hostSize(okNested) < INPUT_BUDGET);
  assert.equal(hostSize(okNested), measure(okNested));
});

test('P2-S02-001: valueSize and measure prevent exponential blowup on shared-node DAGs', () => {
  const { measure, valueSize } = loadSandboxRpcEstimators();
  const hostSize = (v) => valueSize(v, new Set(), INPUT_BUDGET + 1);

  // 35-level binary diamond DAG has 2^35 (~34 billion) paths if seen.delete(val) is present
  let dag = { leaf: 'x' };
  for (let i = 0; i < 35; i++) dag = { a: dag, b: dag };

  const start = performance.now();
  const hostBytes = hostSize(dag);
  const workerBytes = measure(dag);
  const elapsedMs = performance.now() - start;

  assert.ok(elapsedMs < 500, `DAG traversal must finish quickly without exponential blowup (took ${elapsedMs.toFixed(1)}ms)`);
  assert.equal(hostBytes, workerBytes, 'host and worker must agree on DAG size');
  assert.ok(hostBytes > 0 && hostBytes < INPUT_BUDGET);
});

test('P2-S02-001: valueSize and measure enforce object node-count upper bound', () => {
  const { measure, valueSize } = loadSandboxRpcEstimators();
  const hostSize = (v) => valueSize(v, new Set(), OUTPUT_BUDGET + 1);

  // 70,000 distinct empty objects would cost ~1.12 MiB (< 16 MiB) without a node cap,
  // but must fail closed once MAX_NODES (65536) is exceeded.
  const manyObjects = Array.from({ length: 70_000 }, () => ({}));
  assert.equal(hostSize(manyObjects), OUTPUT_BUDGET + 1, 'host valueSize must cap visited object nodes');
  assert.equal(
    measure(manyObjects, new Set(), OUTPUT_BUDGET + 1),
    OUTPUT_BUDGET + 1,
    'worker measure must cap visited object nodes',
  );
});

test('P2-S02-001: valueSize fails closed on non-plain objects and accessors while preserving binary containers', () => {
  const { valueSize } = loadSandboxRpcEstimators();
  const hostSize = (v) => valueSize(v, new Set(), INPUT_BUDGET + 1);

  const nonPlainPayloads = [
    ['Map', new Map([['big', 'x'.repeat(1024)]])],
    ['Set', new Set(['x'.repeat(1024)])],
    ['Date', new Date()],
    ['RegExp', /abc/],
    ['Error', new Error('boom')],
    ['CustomClass', new (class Box { constructor() { this.v = 1; } })()],
  ];
  if (typeof Blob === 'function') {
    nonPlainPayloads.push(['Blob', new Blob(['x'.repeat(1024)])]);
  }
  if (typeof File === 'function') {
    nonPlainPayloads.push(['File', new File(['x'.repeat(1024)], 'a.txt')]);
  }

  for (const [label, payload] of nonPlainPayloads) {
    assert.equal(hostSize([payload]), INPUT_BUDGET + 1, `host valueSize must fail closed on ${label}`);
  }

  // Getter-bearing object must fail closed without invoking the getter
  let getterCalls = 0;
  const accessorObj = {};
  Object.defineProperty(accessorObj, 'trap', {
    enumerable: true,
    get() {
      getterCalls++;
      throw new Error('getter must not run');
    },
  });
  assert.equal(hostSize([accessorObj]), INPUT_BUDGET + 1, 'accessor object must fail closed');
  assert.equal(getterCalls, 0, 'host valueSize must not invoke property getters');

  // Binary containers and null-prototype plain objects remain supported
  const nullProto = Object.assign(Object.create(null), { k: 'v' });
  assert.ok(hostSize(nullProto) < INPUT_BUDGET);
  assert.equal(hostSize(new Uint8Array(64)), 64);
  assert.equal(hostSize(new ArrayBuffer(64)), 64);
});

test('P2-S02-001: runInSandbox handles hostile RPC errors and non-plain payloads without unhandled host rejection', async () => {
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  const origMessageChannel = globalThis.MessageChannel;

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  let hostPort = null;
  const posted = [];
  const fakeWindow = {
    addEventListener() {},
    removeEventListener() {},
  };
  const fakeFrame = {
    hidden: false,
    referrerPolicy: '',
    srcdoc: '',
    contentWindow: { postMessage() {} },
    setAttribute() {},
    remove() {},
  };
  const fakeDocument = {
    createElement() { return fakeFrame; },
    body: { append() {} },
    querySelectorAll() { return []; },
  };
  class FakeMessageChannel {
    constructor() {
      this.port1 = {
        onmessage: null,
        postMessage(msg) { posted.push(msg); },
        close() {},
      };
      this.port2 = {};
      hostPort = this.port1;
    }
  }

  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;
  globalThis.MessageChannel = FakeMessageChannel;

  try {
    // Case A: host API rejects with a non-stringifiable Symbol (String(Symbol()) throws TypeError)
    const runA = runInSandbox({
      source: 'test',
      api: {
        throwSymbol: async () => { throw Symbol('unstringifiable'); },
      },
      out() {},
      timeout: 5000,
    });
    assert.ok(hostPort && typeof hostPort.onmessage === 'function');
    await hostPort.onmessage({ data: { t: 'rpc', id: 1, method: 'throwSymbol', args: [] } });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].t, 'rpcResult');
    assert.equal(typeof posted[0].error, 'string');
    await hostPort.onmessage({ data: { t: 'done', value: null } });
    const resA = await runA;
    assert.equal(resA.ok, true);

    // Case B: RPC input carries non-plain Map -> rejected by host budget without unhandled rejection
    const runB = runInSandbox({
      source: 'test',
      api: { ping: async () => 'ok' },
      out() {},
      timeout: 5000,
    });
    await hostPort.onmessage({ data: { t: 'rpc', id: 2, method: 'ping', args: [new Map([['a', 'b']])] } });
    const resB = await runB;
    assert.match(resB.error, /上限/);

    // Case C: RPC return value is a non-plain Map -> rejected by host output budget without unhandled rejection
    const runC = runInSandbox({
      source: 'test',
      api: { badReturn: async () => new Map([['a', 'b']]) },
      out() {},
      timeout: 5000,
    });
    await hostPort.onmessage({ data: { t: 'rpc', id: 3, method: 'badReturn', args: [] } });
    const resC = await runC;
    assert.match(resC.error, /上限/);

    // Case D: RPC input is a Proxy that throws on Object.keys -> caught cleanly, no unhandled rejection
    const hostileProxy = new Proxy({}, {
      getPrototypeOf() { throw new Error('proxy trap'); },
    });
    const runD = runInSandbox({
      source: 'test',
      api: { ping: async () => 'ok' },
      out() {},
      timeout: 5000,
    });
    await hostPort.onmessage({ data: { t: 'rpc', id: 4, method: 'ping', args: [hostileProxy] } });
    const resD = await runD;
    assert.match(resD.error, /上限/);

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled.length, 0, `expected zero unhandled rejections, got: ${unhandled.length}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    globalThis.document = origDocument;
    globalThis.window = origWindow;
    globalThis.MessageChannel = origMessageChannel;
  }
});

// ===========================================================================
// 2. P1-S02-001: js/panels-base.js — showTools / showSections / showStructure bindings
// ===========================================================================

test('P1-S02-001: panels-base.js imports showTools and imports+exports showSections and showStructure', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/panels-base.js'), 'utf8');
  assert.match(
    src,
    /import\s*\{[^}]*\bshowTools\b[^}]*\}\s*from\s*['"]\.\/tools\.js['"]/,
    'panels-base.js must import showTools from ./tools.js',
  );
  assert.match(
    src,
    /import\s*\{[^}]*\bshowSections\b[^}]*\bshowStructure\b[^}]*\}\s*from\s*['"]\.\/ui\/panels\/file\.js['"]/,
    'panels-base.js must import showSections and showStructure from ./ui/panels/file.js',
  );
  assert.match(
    src,
    /export\s*\{[^}]*\bshowSections\b[^}]*\bshowStructure\b[^}]*\}/,
    'panels-base.js must re-export showSections and showStructure',
  );

  // Verify runtime module binding equality
  const [panelsBase, filePanels] = await Promise.all([
    import('../js/panels-base.js'),
    import('../js/ui/panels/file.js'),
  ]);
  assert.equal(panelsBase.showSections, filePanels.showSections);
  assert.equal(panelsBase.showStructure, filePanels.showStructure);
});

// ===========================================================================
// 3. P1-S12-003: js/ai/provider/worker-protocol.js — sanitizeToolSchema properties
// ===========================================================================

test('P1-S12-003: sanitizeToolSchema only initializes properties on object schemas', () => {
  const sanitized = sanitizeToolSchema({
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      count: { type: 'integer', minimum: 0, maximum: 100 },
      ratio: { type: 'number' },
      enabled: { type: 'boolean' },
      tags: { type: 'array', maxItems: 5, items: { type: 'string' } },
      nestedObj: { type: 'object' },
      unionField: { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'object' }] },
    },
    required: ['name'],
  });

  // Top-level object always has type: 'object' and properties
  assert.equal(sanitized.type, 'object');
  assert.ok(sanitized.properties && typeof sanitized.properties === 'object');

  // Non-object nested schemas must NOT get properties: {}
  assert.equal('properties' in sanitized.properties.name, false, 'string schema must not have properties');
  assert.equal('properties' in sanitized.properties.count, false, 'integer schema must not have properties');
  assert.equal('properties' in sanitized.properties.ratio, false, 'number schema must not have properties');
  assert.equal('properties' in sanitized.properties.enabled, false, 'boolean schema must not have properties');
  assert.equal('properties' in sanitized.properties.tags, false, 'array schema must not have properties');
  assert.equal('properties' in sanitized.properties.tags.items, false, 'array items string schema must not have properties');
  assert.equal('properties' in sanitized.properties.unionField, false, 'anyOf wrapper without type=object must not have properties');
  assert.equal('properties' in sanitized.properties.unionField.anyOf[0], false);
  assert.equal('properties' in sanitized.properties.unionField.anyOf[1], false);

  // Nested object schemas DO get properties: {}
  assert.deepEqual(sanitized.properties.nestedObj, { type: 'object', properties: {} });
  assert.deepEqual(sanitized.properties.unionField.anyOf[2], { type: 'object', properties: {} });

  // Top-level non-object input is still coerced to object with properties: {}
  const coercedRoot = sanitizeToolSchema({ type: 'string' });
  assert.deepEqual(coercedRoot, { type: 'object', properties: {} });

  // End-to-end via normalizeAITools and finalResultTool
  const [tool] = normalizeAITools([{ name: 'inspect_result', description: 'Inspect', inputSchema: finalResultTool().inputSchema }]);
  assert.equal(tool.inputSchema.type, 'object');
  assert.equal('properties' in tool.inputSchema.properties.answer, false);
  assert.equal('properties' in tool.inputSchema.properties.evidenceIds, false);
  assert.equal('properties' in tool.inputSchema.properties.evidenceIds.items, false);
  assert.equal(typeof tool.inputSchema.properties.hypotheses.items.properties, 'object');
});
