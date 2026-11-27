import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { runInSandbox, SANDBOX_EXECUTION_CONTEXT } from '../js/sandbox.js';
import { createApi } from '../js/script.js';
import { gmFetch, installUserscriptNetworkBridge } from '../js/userscript/network.js';
import { DomSkillRegistry } from '../js/userscript/dev/skills/dom-skill-registry.js';
import { executeAutomationProgram } from '../js/userscript/dev/skills/automation-program.js';
import { buildWorkerProgram } from './support/sandbox-rpc-estimators.mjs';

function setGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
}

// ===========================================================================
// 1. [P1] js/sandbox.js & js/script.js — positional shadowing & maxScanned cap
// ===========================================================================

test('Track10-1: branded host execution context cannot be shadowed by untrusted { signal: null }', async () => {
  const ac = new AbortController();
  ac.abort(new Error('host-cancelled'));
  const hostContext = Object.freeze({
    [SANDBOX_EXECUTION_CONTEXT]: true,
    signal: ac.signal,
  });

  const fakeApp = {
    store: { get: (k) => (k === 'architecture' ? 'arm64' : []) },
    codeRegion: () => null,
    symbols: { functionList: () => [], funcs: [], nameAt: () => null, label: () => null },
    backend: { readAt: async () => ({ found: true, bytes: new Uint8Array([1]) }) },
    analysisQueries: {
      snapshot: async () => ({}),
      functions: async () => ({ value: [], status: { completeness: 'complete' } }),
      xrefs: async () => ({ value: [], status: { completeness: 'complete' } }),
      callees: async () => ({ value: [], status: { completeness: 'complete' } }),
    },
    analyzeFunctionAt: async () => ({ model: null }),
    stringIndex: [{ text: 'needle' }],
  };

  const { api } = createApi(fakeApp, () => {});
  const { id: emuId } = api.emulatorCreate(null, []);

  assert.throws(() => api.functions({ signal: null }, hostContext), /host-cancelled/);
  assert.throws(() => api.functions(100, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.queryFunctions({ signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.queryFunctions({}, {}, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.bytes(0x1000, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.bytes(0x1000, 16, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.string(0x1000, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.disasm(0x1000, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.decompile(0x1000, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.types(0x1000, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.struct(0x1000, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.queryXrefsTo(0x1000, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.xrefsTo(0x1000, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.queryXrefsFrom(0x1000, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.xrefsFrom(0x1000, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.queryMostCalled({ signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.mostCalled(20, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.loadStrings({ signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.findStrings('needle', { signal: null, maxScanned: 999999 }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.findStrings('needle', 10, { signal: null, maxScanned: 999999 }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.patch(0x1000, '90', { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.run(0x1000, [], 100, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.emulatorStep(emuId, { signal: null }, hostContext), /host-cancelled/);
  await assert.rejects(() => api.emulatorRun(emuId, 100, { signal: null }, hostContext), /host-cancelled/);
});

test('Track10-1: createApi options.signal cannot be nullified by { signal: null }', async () => {
  const ac = new AbortController();
  ac.abort(new Error('parent-cancelled'));
  const fakeApp = {
    store: { get: () => [] },
    codeRegion: () => null,
    symbols: { functionList: () => [], funcs: [] },
    stringIndex: [{ text: 'needle' }],
  };
  const { api } = createApi(fakeApp, () => {}, { signal: ac.signal });
  assert.throws(() => api.functions(10, { signal: null }), /parent-cancelled/);
  await assert.rejects(() => api.findStrings('needle', 10, { signal: null }), /parent-cancelled/);
});

test('Track10-1: findStrings clamps maxScanned to 10,000 ceiling while honoring smaller budgets', async () => {
  const items = Array.from({ length: 12_500 }, (_, i) => ({ addr: BigInt(i), text: i === 12_000 ? 'late-needle' : `row-${i}` }));
  const { api } = createApi({ store: { get: () => [] }, stringIndex: items }, () => {});
  const hostContext = Object.freeze({
    [SANDBOX_EXECUTION_CONTEXT]: true,
    signal: new AbortController().signal,
  });

  const capped1 = await api.findStrings('late-needle', 10, { maxScanned: Number.MAX_SAFE_INTEGER, signal: null }, hostContext);
  assert.equal(capped1.scanned, 10_000);
  assert.equal(capped1.length, 0);
  assert.equal(capped1.complete, false);
  assert.equal(capped1.reason, 'scan-budget-exhausted');

  const capped2 = await api.findStrings('late-needle', { limit: 10, maxScanned: 500_000, signal: null }, hostContext);
  assert.equal(capped2.scanned, 10_000);
  assert.equal(capped2.length, 0);
  assert.equal(capped2.reason, 'scan-budget-exhausted');

  const smaller = await api.findStrings('late-needle', 10, { maxScanned: 300 });
  assert.equal(smaller.scanned, 300);
  assert.equal(smaller.reason, 'scan-budget-exhausted');
});

test('Track10-1: runInSandbox passes branded SANDBOX_EXECUTION_CONTEXT to RPC handlers', async () => {
  let receivedArgs = null;
  let port1Ref = null;
  const frame = {
    contentWindow: { postMessage() {} },
    hidden: false,
    referrerPolicy: '',
    setAttribute() {},
    remove() {},
  };
  const restoreDocument = setGlobal('document', {
    createElement: () => frame,
    body: { append() {} },
  });
  const restoreWindow = setGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
  });
  const restoreMessageChannel = setGlobal('MessageChannel', class {
    constructor() {
      this.port1 = {
        onmessage: null,
        postMessage(msg) {
          if (msg?.t === 'rpcResult') {
            queueMicrotask(() => this.onmessage?.({ data: { t: 'done', value: null } }));
          }
        },
        close() {},
      };
      this.port2 = {};
      port1Ref = this.port1;
    }
  });

  try {
    const runPromise = runInSandbox({
      source: '',
      api: {
        probe(...args) {
          receivedArgs = args;
          return 'ok';
        },
      },
      out() {},
    });

    await port1Ref.onmessage({
      data: { t: 'rpc', id: 1, method: 'probe', args: [10, { signal: null }] },
    });
    const res = await runPromise;
    assert.equal(res.ok, true);
    assert.equal(receivedArgs.length, 3);
    const hostCtx = receivedArgs[2];
    assert.equal(hostCtx[SANDBOX_EXECUTION_CONTEXT], true);
    assert.ok(hostCtx.signal && typeof hostCtx.signal.aborted === 'boolean');
  } finally {
    restoreMessageChannel();
    restoreWindow();
    restoreDocument();
  }
});

// ===========================================================================
// 2. [P1] js/sandbox.js WORKER_PRELUDE — Math.min & Map.prototype tampering
// ===========================================================================

function createWorkerHarness(userBodySource) {
  const program = buildWorkerProgram(`
    const __hexRun = async () => {
      const userBody = async function(hex, print) {
        ${userBodySource}
      };
      await userBody(hex, print);
      send({ t: 'done', value: null });
    };
  `);

  const controlSent = [];
  const publicSent = [];
  let workerOnMessage = null;
  let controlOnMessage = null;
  let closed = false;

  const realm = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    structuredClone,
    importScripts() {},
    postMessage(msg) { publicSent.push(msg); },
    close() { closed = true; },
  });
  realm.globalThis = realm;
  realm.self = realm;

  vm.runInContext(program, realm);
  workerOnMessage = realm.self.onmessage;
  assert.equal(typeof workerOnMessage, 'function', 'worker prelude must register self.onmessage');

  const controlPort = {
    postMessage(msg) { controlSent.push(msg); },
    start() {},
    set onmessage(fn) { controlOnMessage = fn; },
    get onmessage() { return controlOnMessage; },
  };

  return {
    start() {
      workerOnMessage({ data: { t: 'start' }, ports: [controlPort] });
    },
    replyRpc(id, value, error = undefined) {
      controlOnMessage({ data: { t: 'rpcResult', id, value, error } });
    },
    controlSent,
    publicSent,
    isClosed: () => closed,
  };
}

test('Track10-2: WORKER_PRELUDE resists Math.min and Array.prototype[Symbol.iterator] tampering for RPC size budget', async () => {
  const harness = createWorkerHarness(`
    Math.min = () => 0;
    Array.prototype[Symbol.iterator] = function* () {};
    let stringErr = null;
    try {
      await hex.ping('a'.repeat(3 * 1024 * 1024));
    } catch (e) {
      stringErr = e.message;
    }
    let keyErr = null;
    try {
      await hex.ping({ ['k'.repeat(2_500_000)]: 1 });
    } catch (e) {
      keyErr = e.message;
    }
    print(stringErr, keyErr);
  `);

  harness.start();
  await new Promise((r) => setTimeout(r, 20));

  const rpcMsgs = harness.controlSent.filter((m) => m.t === 'rpc');
  const budgetMsgs = harness.controlSent.filter((m) => m.t === 'budgetExceeded');
  assert.equal(rpcMsgs.length, 0, 'oversized RPCs must never be sent after Math.min/iterator tampering');
  assert.equal(budgetMsgs.length, 2, 'both oversized RPCs must report budgetExceeded');
});

test('Track10-2: WORKER_PRELUDE resists Map.prototype.{size,set,get,delete} tampering for RPC concurrency cap', async () => {
  const harness = createWorkerHarness(`
    Object.defineProperty(Map.prototype, 'size', { get: () => 0, configurable: true });
    Map.prototype.set = () => {};
    Map.prototype.get = () => undefined;
    Map.prototype.delete = () => false;

    const pending = [];
    for (let i = 0; i < 16; i++) {
      pending.push(hex.ping(i));
    }
    let seventeenthError = null;
    try {
      await hex.ping(16);
    } catch (e) {
      seventeenthError = e.message;
    }
    const first = await pending[0];
    print(seventeenthError, first);
  `);

  harness.start();
  await new Promise((r) => setTimeout(r, 20));

  const rpcMsgs = harness.controlSent.filter((m) => m.t === 'rpc');
  const budgetMsgs = harness.controlSent.filter((m) => m.t === 'budgetExceeded');
  assert.equal(rpcMsgs.length, 16, 'at most MAX_OUTSTANDING_RPC (16) RPCs may be in flight');
  assert.equal(budgetMsgs.length, 1, '17th concurrent RPC must trigger budgetExceeded even after Map.prototype tampering');
  assert.match(budgetMsgs[0].error, /同時実行数/);

  harness.replyRpc(rpcMsgs[0].id, 'pong-0');
  await new Promise((r) => setTimeout(r, 20));
  const printMsg = harness.controlSent.find((m) => m.t === 'print');
  assert.ok(printMsg, 'script should receive resolved RPC result despite Map.prototype tampering');
  assert.equal(printMsg.args[1], 'pong-0');
});

// ===========================================================================
// 3. [P1] js/userscript/network.js — targetFor origin check & gmFetch hardening
// ===========================================================================

test('Track10-3: targetFor rejects leading-whitespace and backslash cross-origin bypasses', async () => {
  const origFetch = globalThis.fetch;
  const origGM = globalThis.GM;
  const origLocation = globalThis.location;
  const gmRequests = [];
  const nativeRequests = [];

  try {
    Object.defineProperty(globalThis, 'location', {
      value: new URL('https://chatgpt.com/c/test'),
      configurable: true,
      writable: true,
    });
    delete globalThis.__HEX_NATIVE_FETCH__;
    globalThis.fetch = async (input) => {
      nativeRequests.push(String(input));
      return new Response('native');
    };
    globalThis.GM = {
      xmlHttpRequest(details) {
        gmRequests.push(details);
        queueMicrotask(() => details.onload?.({
          status: 200,
          statusText: 'OK',
          response: new TextEncoder().encode('gm').buffer,
          responseHeaders: '',
        }));
        return { abort() {} };
      },
    };

    installUserscriptNetworkBridge({ apiBase: 'https://ida.example/' });

    const bypassInputs = [
      ' //evil.example/steal',
      '\t//evil.example/steal',
      ' https://evil.example/steal',
      '\\\\evil.example/steal',
      '/\\evil.example/steal',
      '\\/evil.example/steal',
      ' \\\\evil.example/steal',
    ];
    for (const bad of bypassInputs) {
      const res = await globalThis.fetch(bad);
      assert.equal(await res.text(), 'native', `expected ${JSON.stringify(bad)} to bypass GM bridge`);
    }
    assert.equal(gmRequests.length, 0, 'GM bridge must never be invoked for cross-origin bypass inputs');
    assert.equal(nativeRequests.length, bypassInputs.length);

    const ok = await globalThis.fetch('/api/ai/turn');
    assert.equal(await ok.text(), 'gm');
    assert.equal(gmRequests.length, 1);
    assert.equal(gmRequests[0].url, 'https://ida.example/api/ai/turn');
  } finally {
    globalThis.fetch = origFetch;
    if (origGM === undefined) delete globalThis.GM; else globalThis.GM = origGM;
    if (origLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { value: origLocation, configurable: true, writable: true });
    delete globalThis.__HEX_NATIVE_FETCH__;
  }
});

test('Track10-3: gmFetch enforces anonymous:true, redirect:error, and response.finalUrl origin check', async () => {
  const origGM = globalThis.GM;
  const origLocation = globalThis.location;
  const captured = [];
  let nextFinalUrl = undefined;

  try {
    Object.defineProperty(globalThis, 'location', {
      value: new URL('https://chatgpt.com/c/test'),
      configurable: true,
      writable: true,
    });
    globalThis.GM = {
      xmlHttpRequest(details) {
        captured.push(details);
        queueMicrotask(() => details.onload?.({
          status: 200,
          statusText: 'OK',
          finalUrl: nextFinalUrl,
          response: new TextEncoder().encode('ok').buffer,
          responseHeaders: '',
        }));
        return { abort() {} };
      },
    };

    nextFinalUrl = 'https://ida.example/api/ai/turn?v=2';
    const ok = await gmFetch('https://ida.example/api/ai/turn');
    assert.equal(await ok.text(), 'ok');
    assert.equal(captured.at(-1).anonymous, true);
    assert.equal(captured.at(-1).redirect, 'error');

    nextFinalUrl = 'https://evil.example/hijack';
    await assert.rejects(() => gmFetch('https://ida.example/api/ai/turn'), TypeError);

    nextFinalUrl = 'javascript:alert(1)';
    await assert.rejects(() => gmFetch('https://ida.example/api/ai/turn'), TypeError);

    nextFinalUrl = 'http://[::1';
    await assert.rejects(() => gmFetch('https://ida.example/api/ai/turn'), TypeError);
  } finally {
    if (origGM === undefined) delete globalThis.GM; else globalThis.GM = origGM;
    if (origLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { value: origLocation, configurable: true, writable: true });
  }
});

// ===========================================================================
// 4. [P2] js/userscript/dev/skills/dom-skill-registry.js — candidate run gate
// ===========================================================================

test('Track10-4: DomSkillRegistry.run({ candidate: true }) enforces validation and requireReadOnly', async () => {
  let clicks = 0;
  const button = {
    tagName: 'BUTTON',
    textContent: 'Action',
    disabled: false,
    getAttribute: () => null,
    click() { clicks += 1; },
  };
  const doc = {
    querySelector: (sel) => (sel === 'button' ? button : null),
    querySelectorAll: (sel) => (sel === 'button' ? [button] : []),
  };
  const registry = new DomSkillRegistry({
    document: doc,
    location: { href: 'https://chatgpt.com/', hostname: 'chatgpt.com' },
  });

  const makeManifest = (version) => ({
    schema: 'hex-dom-skill-v1',
    skillId: 'chatgpt.candidate-gate',
    version,
    validationPrograms: ['probe'],
    programs: {
      probe: {
        version: 1,
        name: 'probe',
        readOnly: true,
        steps: [
          { op: 'query', selector: 'button', as: 'btn' },
          { op: 'readText', target: 'btn', as: 'label' },
          { op: 'return', value: { label: { var: 'label' } } },
        ],
      },
      mutate: {
        version: 1,
        name: 'mutate',
        readOnly: false,
        steps: [
          { op: 'query', selector: 'button', as: 'btn' },
          { op: 'click', target: 'btn' },
          { op: 'return', value: { clicked: true } },
        ],
      },
    },
  });

  registry.installCandidate(makeManifest('1'));

  await assert.rejects(
    () => registry.run({ skillId: 'chatgpt.candidate-gate', program: 'probe', candidate: true }),
    (err) => err.code === 'candidate-not-validated',
  );
  await assert.rejects(
    () => registry.run({ skillId: 'chatgpt.candidate-gate', program: 'mutate', candidate: true }),
    (err) => err.code === 'candidate-not-validated',
  );
  assert.equal(clicks, 0);

  await registry.validateCandidate({ skillId: 'chatgpt.candidate-gate' });
  const readRes = await registry.run({ skillId: 'chatgpt.candidate-gate', program: 'probe', candidate: true });
  assert.equal(readRes.result.label, 'Action');

  await assert.rejects(
    () => registry.run({ skillId: 'chatgpt.candidate-gate', program: 'mutate', candidate: true }),
    (err) => err.code === 'program-not-read-only',
  );
  assert.equal(clicks, 0, 'candidate run must never execute mutating operations');

  registry.installCandidate(makeManifest('2'));
  await assert.rejects(
    () => registry.run({ skillId: 'chatgpt.candidate-gate', program: 'probe', candidate: true }),
    (err) => err.code === 'candidate-not-validated',
  );
});

// ===========================================================================
// 5. [P2] js/userscript/dev/skills/automation-program.js — sensitive DOM reads
// ===========================================================================

test('Track10-5: readText / collect / findText / textIncludes exclude script and style contents', async () => {
  const scriptNode = { tagName: 'SCRIPT', textContent: 'window.__SECRET_TOKEN__ = "top-secret-123";' };
  const styleNode = { tagName: 'STYLE', textContent: '.secret { content: "css-secret"; }' };
  const containerNode = {
    tagName: 'DIV',
    textContent: 'Hello window.__SECRET_TOKEN__ = "top-secret-123"; World .secret { content: "css-secret"; }',
    childNodes: [
      { nodeType: 3, nodeValue: 'Hello ' },
      scriptNode,
      { tagName: 'SPAN', childNodes: [{ nodeType: 3, nodeValue: 'World' }] },
      styleNode,
    ],
  };

  const doc = {
    querySelector: (sel) => ({ script: scriptNode, style: styleNode, div: containerNode }[sel] || null),
    querySelectorAll: (sel) => (sel === '*' ? [scriptNode, styleNode, containerNode] : []),
  };

  const result = await executeAutomationProgram({
    version: 1,
    name: 'read-safe-text',
    readOnly: true,
    steps: [
      { op: 'query', selector: 'script', as: 'sc' },
      { op: 'query', selector: 'style', as: 'st' },
      { op: 'query', selector: 'div', as: 'dv' },
      { op: 'readText', target: 'sc', as: 'scriptText' },
      { op: 'readText', target: 'st', as: 'styleText' },
      { op: 'readText', target: 'dv', as: 'divText' },
      { op: 'queryAll', selector: '*', as: 'all' },
      { op: 'collect', from: 'all', as: 'collected', fields: [{ kind: 'text', as: 'text' }] },
      { op: 'findText', from: 'all', text: 'top-secret-123', as: 'foundSecret' },
      { op: 'return', value: {
        scriptText: { var: 'scriptText' },
        styleText: { var: 'styleText' },
        divText: { var: 'divText' },
        collected: { var: 'collected' },
        foundSecret: { var: 'foundSecret' },
      } },
    ],
  }, { document: doc, location: { href: 'https://chatgpt.com/' } });

  assert.equal(result.scriptText, '');
  assert.equal(result.styleText, '');
  assert.equal(result.divText, 'Hello World');
  assert.deepEqual(result.collected, [{ text: '' }, { text: '' }, { text: 'Hello World' }]);
  assert.equal(result.foundSecret, null);

  await assert.rejects(() => executeAutomationProgram({
    version: 1,
    name: 'oracle',
    readOnly: true,
    steps: [
      { op: 'query', selector: 'div', as: 'dv' },
      { op: 'assert', condition: { type: 'textIncludes', target: 'dv', text: 'top-secret-123' } },
    ],
  }, { document: doc, location: { href: 'https://chatgpt.com/' } }), (err) => err.code === 'assertion-failed');
});

test('Track10-5: readProperty and collect block value reads on password, hidden, and sensitive inputs', async () => {
  const mkInput = (attrs, props = {}) => ({
    tagName: 'INPUT',
    type: attrs.type || 'text',
    name: attrs.name || '',
    id: attrs.id || '',
    value: props.value ?? 'secret-val',
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
  });

  const passwordInput = mkInput({ type: 'password' }, { value: 'hunter2' });
  const hiddenInput = mkInput({ type: 'hidden', name: 'state' }, { value: 'csrf-123' });
  const tokenInput = mkInput({ type: 'text', name: 'csrf_token' }, { value: 'tok-999' });
  const autocompleteInput = mkInput({ type: 'text', autocomplete: 'current-password' }, { value: 'pw-999' });
  const normalInput = mkInput({ type: 'text', placeholder: 'Project name' }, { value: 'Hex Project' });

  const map = {
    '#pw': passwordInput,
    '#hidden': hiddenInput,
    '#token': tokenInput,
    '#ac': autocompleteInput,
    '#normal': normalInput,
  };
  const doc = {
    querySelector: (sel) => map[sel] || null,
    querySelectorAll: (sel) => (sel === 'input.sensitive' ? [passwordInput] : [normalInput]),
  };

  for (const sel of ['#pw', '#hidden', '#token', '#ac']) {
    await assert.rejects(() => executeAutomationProgram({
      version: 1,
      name: 'read-sensitive-prop',
      readOnly: true,
      steps: [
        { op: 'query', selector: sel, as: 'el' },
        { op: 'readProperty', target: 'el', name: 'value', as: 'v' },
      ],
    }, { document: doc, location: { href: 'https://chatgpt.com/' } }), (err) => err.code === 'property-not-allowed', `expected ${sel} value read to be rejected`);
  }

  await assert.rejects(() => executeAutomationProgram({
    version: 1,
    name: 'collect-sensitive-prop',
    readOnly: true,
    steps: [
      { op: 'queryAll', selector: 'input.sensitive', as: 'els' },
      { op: 'collect', from: 'els', as: 'rows', fields: [{ kind: 'property', name: 'value', as: 'v' }] },
    ],
  }, { document: doc, location: { href: 'https://chatgpt.com/' } }), (err) => err.code === 'property-not-allowed');

  const ok = await executeAutomationProgram({
    version: 1,
    name: 'read-normal-prop',
    readOnly: true,
    steps: [
      { op: 'query', selector: '#normal', as: 'el' },
      { op: 'readProperty', target: 'el', name: 'value', as: 'v' },
      { op: 'return', value: { v: { var: 'v' } } },
    ],
  }, { document: doc, location: { href: 'https://chatgpt.com/' } });
  assert.deepEqual(ok, { v: 'Hex Project' });
});
