import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import { buildFrameSrcdoc, inheritedCspNonce } from '../js/sandbox.js';
import { ParentPageInspector } from '../js/userscript/dev/admin/page-inspector.js';
import {
  decodeBase64URL,
  encodeBase64URL,
  signRuntimeSession,
  verifyRuntimeSession,
} from '../js/userscript/runtime-security.js';
import {
  buildSandboxSrcdoc,
  createChatGPTSandboxHost,
} from '../js/userscript/chatgpt-sandbox-host.js';
import { startEmbedChildRuntime } from '../js/userscript/embed-child.js';
import { PluginHost } from '../js/plugins.js';
import { createApi } from '../js/script.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX_SOURCE = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');

// ---------------------------------------------------------------------------
// [T10-P1-1] js/sandbox.js — inherited nonce CSP propagation (static FRAME)
// ---------------------------------------------------------------------------
test('T10-P1-1: inheritedCspNonce skips invalid nonces, guards querySelectorAll, and propagates valid nonce', () => {
  assert.match(SANDBOX_SOURCE, /\nconst FRAME = `<!doctype html>/, 'const FRAME must remain static');

  // Guarded when document has no querySelectorAll
  assert.equal(inheritedCspNonce({}), '');
  assert.equal(inheritedCspNonce(null), '');

  // Skips empty & malformed nonces and selects the first valid nonce
  const fakeDoc = {
    currentScript: { nonce: 'bad" onclick="alert(1)' },
    querySelectorAll(sel) {
      assert.equal(sel, 'script');
      return [
        { nonce: '', getAttribute: () => '' },
        { nonce: "bad'nonce;script-src *", getAttribute: () => '' },
        { nonce: '', getAttribute: () => 'validNonce_123+ABC/==' },
        { nonce: 'laterNonce', getAttribute: () => '' },
      ];
    },
  };
  assert.equal(inheritedCspNonce(fakeDoc), 'validNonce_123+ABC/==');

  // buildFrameSrcdoc replaces unsafe-inline and attaches nonce attribute
  const withNonce = buildFrameSrcdoc('validNonce_123+ABC/==');
  assert.match(withNonce, /script-src 'nonce-validNonce_123\+ABC\/==' blob:;/);
  assert.doesNotMatch(withNonce, /script-src 'unsafe-inline' blob:;/);
  assert.match(withNonce, /<script nonce="validNonce_123\+ABC\/==">\n/);

  // Invalid or empty nonce falls back to static FRAME without injection
  const fallbackInvalid = buildFrameSrcdoc('bad"nonce');
  assert.match(fallbackInvalid, /script-src 'unsafe-inline' blob:;/);
  assert.match(fallbackInvalid, /<script>\n/);
});

// ---------------------------------------------------------------------------
// [T10-P1-2] page-inspector.js — secret masking & external script read limit
// ---------------------------------------------------------------------------
test('T10-P1-2: inline script redacts normal strings, JSON-escaped strings, and JWTs', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_with-dash-';
  const inlineText = [
    'const marker = "needleHere";',
    'const a = { apiKey: "raw\\"secret\\\\", sessionToken: \'tok\\u003d123\' };',
    'self.__next_f.push([1,"{\\"accessToken\\":\\"esc\\u003dval\\\\\\",\\"csrfToken\\":\\"csrf_secret\\"}"])',
    `const b = "${jwt}";`,
    'const c = "Bearer superSecretBearerToken12345";',
  ].join('\n');

  const inspector = new ParentPageInspector({
    document: {
      querySelectorAll: () => [],
      scripts: [{ src: '', textContent: inlineText }],
    },
    location: { href: 'https://chatgpt.com/' },
  });

  const res = await inspector.scriptSource({ index: 0, needle: 'needleHere', contextChars: 1024 });
  assert.equal(res.excerpts.length, 1);
  const redacted = res.excerpts[0].text;
  assert.doesNotMatch(redacted, /raw\\"secret/);
  assert.doesNotMatch(redacted, /tok\\u003d123/);
  assert.doesNotMatch(redacted, /esc\\u003dval/);
  assert.doesNotMatch(redacted, /csrf_secret/);
  assert.doesNotMatch(redacted, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  assert.doesNotMatch(redacted, /superSecretBearerToken12345/);
  assert.match(redacted, /\\"accessToken\\":\\"\[redacted\]\\"/);
  assert.match(redacted, /\\"csrfToken\\":\\"\[redacted\]\\"/);
  assert.match(redacted, /Bearer \[redacted\]/);
});

test('T10-P1-2: external script streaming reader caps at MAX_SCRIPT_OFFSET, cancels, and releases lock', async () => {
  const MAX_SCRIPT_OFFSET = 8 * 1024 * 1024;
  let cancelled = false;
  let released = false;
  let reads = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(0x61); // 1 MiB of 'a'

  const inspector = new ParentPageInspector({
    document: {
      querySelectorAll: () => [],
      scripts: [{ src: 'https://cdn.oaistatic.com/big.js' }],
    },
    location: { href: 'https://chatgpt.com/' },
    fetchRef: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              reads++;
              if (reads > 12) return { done: true, value: undefined };
              return { done: false, value: chunk };
            },
            async cancel() { cancelled = true; },
            releaseLock() { released = true; },
          };
        },
      },
    }),
  });

  const res = await inspector.scriptSource({ index: 0, offset: 0, maxChars: 256 });
  assert.equal(res.truncated, true);
  assert.equal(res.totalChars, MAX_SCRIPT_OFFSET);
  assert.equal(cancelled, true);
  assert.equal(released, true);
  assert.ok(reads <= 9, `expected stream to stop at 8 MiB boundary, got ${reads} reads`);
});

test('T10-P1-2: external script mock text() fallback slices to MAX_SCRIPT_OFFSET and flags truncated', async () => {
  const MAX_SCRIPT_OFFSET = 8 * 1024 * 1024;
  const inspector = new ParentPageInspector({
    document: {
      querySelectorAll: () => [],
      scripts: [{ src: 'https://cdn.oaistatic.com/mock-big.js' }],
    },
    location: { href: 'https://chatgpt.com/' },
    fetchRef: async () => ({
      ok: true,
      status: 200,
      async text() { return 'b'.repeat(MAX_SCRIPT_OFFSET + 100); },
    }),
  });

  const res = await inspector.scriptSource({ index: 0, offset: 0, maxChars: 256 });
  assert.equal(res.truncated, true);
  assert.equal(res.totalChars, MAX_SCRIPT_OFFSET);
  assert.equal(res.text.length, 256);
});

// ---------------------------------------------------------------------------
// [T10-P1-3] runtime-security.js — strict exp & Base64URL validation
// ---------------------------------------------------------------------------
test('T10-P1-3: decodeBase64URL rejects non-Base64URL characters, padding, whitespace, and bad length', () => {
  assert.deepEqual(decodeBase64URL(encodeBase64URL(new Uint8Array([1, 2, 3, 255]))), new Uint8Array([1, 2, 3, 255]));
  for (const bad of ['abc+', 'abc/', 'abc=', 'ab c', 'ab\nc', 'a', 'abcde', null, 123]) {
    assert.throws(() => decodeBase64URL(bad), `expected decodeBase64URL(${JSON.stringify(bad)}) to throw`);
  }
});

test('T10-P1-3: verifyRuntimeSession strictly validates exp (missing/NaN/string/expired)', async () => {
  const key = new Uint8Array(32).fill(7);
  const now = 1_700_000_000_000;
  const base = { v: 1, sid: 'session-1234', bid: 'build-123456', rid: 'request-1234' };

  const valid = await signRuntimeSession({ ...base, exp: Math.floor(now / 1000) + 60 }, key);
  assert.ok(await verifyRuntimeSession(valid, key, { now }));

  const missingExp = await signRuntimeSession({ ...base }, key);
  assert.equal(await verifyRuntimeSession(missingExp, key, { now }), null);

  const stringExp = await signRuntimeSession({ ...base, exp: String(Math.floor(now / 1000) + 60) }, key);
  assert.equal(await verifyRuntimeSession(stringExp, key, { now }), null);

  const nullExp = await signRuntimeSession({ ...base, exp: null }, key);
  assert.equal(await verifyRuntimeSession(nullExp, key, { now }), null);

  const expired = await signRuntimeSession({ ...base, exp: Math.floor(now / 1000) - 1 }, key);
  assert.equal(await verifyRuntimeSession(expired, key, { now }), null);
  assert.ok(await verifyRuntimeSession(expired, key, { now, requireUnexpired: false }));
});

// ---------------------------------------------------------------------------
// [T10-P2-1] chatgpt-sandbox-host.js — parentOrigin propagation & postMessage
// ---------------------------------------------------------------------------
test('T10-P2-1: buildSandboxSrcdoc and createChatGPTSandboxHost enforce normalizeParentOrigin and restrict postMessage', () => {
  const worker = 'https://ida.rhgrive.workers.dev';
  const token = 'ab'.repeat(32);
  const runtimeSource = 'globalThis.__OK__=1;';
  const runtimeContentHash = createHash('sha256').update(runtimeSource).digest('hex');
  const baseConfig = {
    hostHtml: '<main id="app"></main>',
    cspNonce: 'nonce-abc',
    generation: 1,
    sandboxToken: token,
    apiOrigin: worker,
    virtualSrc: `${worker}/embed/chatgpt?__hex_embed_generation=1`,
    loaderVersion: '2.0.1',
    buildId: '0123456789abcdef01234567',
    runtimeContentHash,
  };

  for (const bad of ['null', 'https://evil.example', 'http://chatgpt.com', 'https://chatgpt.com/', 42]) {
    assert.throws(() => buildSandboxSrcdoc({ ...baseConfig, parentOrigin: bad }), TypeError);
    assert.throws(() => createChatGPTSandboxHost({
      ...baseConfig,
      parentOrigin: bad,
      documentRef: { createElement: () => ({}), documentElement: {} },
      windowRef: new EventTarget(),
      MessageChannelCtor: globalThis.MessageChannel,
      runtimeSourceProvider: () => new TextEncoder().encode(runtimeSource).buffer,
    }), TypeError);
  }

  // Explicit parentOrigin restricts postMessage target strictly to that origin
  const restrictedHtml = buildSandboxSrcdoc({ ...baseConfig, parentOrigin: 'https://chatgpt.com' });
  const restrictedScript = restrictedHtml.match(/<script nonce="[^"]+">([\s\S]*)<\/script><\/body>/)?.[1];
  assert.ok(restrictedScript);
  assert.doesNotMatch(restrictedScript, /parent\.postMessage\([^)]*,'\s*\*'\)/);

  const postedRestricted = [];
  const ctx1 = {
    parent: { postMessage(msg, targetOrigin) { postedRestricted.push({ msg, targetOrigin }); } },
    addEventListener() {},
    URL, ArrayBuffer, Uint8Array, TextDecoder, crypto: webcrypto,
  };
  ctx1.globalThis = ctx1;
  vm.runInNewContext(restrictedScript, ctx1);
  assert.deepEqual(postedRestricted.map((p) => p.targetOrigin), ['https://chatgpt.com']);

  // Omitted parentOrigin (undefined / null / '') sends to all CHATGPT_PARENT_ORIGINS, never '*'
  for (const omitted of [undefined, null, '']) {
    const html = buildSandboxSrcdoc({ ...baseConfig, parentOrigin: omitted });
    const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script><\/body>/)?.[1];
    const posted = [];
    const ctx = {
      parent: { postMessage(msg, targetOrigin) { posted.push({ msg, targetOrigin }); } },
      addEventListener() {},
      URL, ArrayBuffer, Uint8Array, TextDecoder, crypto: webcrypto,
    };
    ctx.globalThis = ctx;
    vm.runInNewContext(script, ctx);
    assert.deepEqual(posted.map((p) => p.targetOrigin), ['https://chatgpt.com', 'https://chat.openai.com']);
  }
});

// ---------------------------------------------------------------------------
// [T10-P2-2] embed-child.js — single try/catch cleanup & global restoration
// ---------------------------------------------------------------------------
test('T10-P2-2: startEmbedChildRuntime safely closes all resources and restores globals on failure', async () => {
  const closed = [];
  const port = { close() { closed.push('port'); } };
  const globalObject = { __HEX_API_BASE__: 'https://original.example' };
  const fakeWindow = { parent: {}, addEventListener() {}, removeEventListener() {} };
  const fakeDocument = {
    documentElement: {},
    head: { append() {} },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
  };

  await assert.rejects(() => startEmbedChildRuntime({
    window: fakeWindow,
    document: fakeDocument,
    location: { origin: 'https://worker.example', pathname: '/embed/chatgpt', search: '?__hex_embed_generation=3' },
    globalObject,
    waitForEmbedParentAttach: async () => ({ port, nonce: 'n1', generation: '3' }),
    createEmbedBridgeProxy: () => ({
      async refresh() {},
      close() { closed.push('bridge'); throw new Error('bridge close boom'); },
    }),
    createDevWorkerParentRpcClient: () => ({
      close() { closed.push('devWorker'); },
    }),
    setUiRoot: () => {},
    installProtectedWorkers: async () => {},
    startChildAuth: async () => ({
      close() { closed.push('auth'); throw new Error('auth close boom'); },
    }),
    importApp: async () => { throw new Error('app import failed'); },
  }), /app import failed/);

  assert.deepEqual(closed, ['auth', 'bridge', 'devWorker', 'port']);
  assert.equal(globalObject.__HEX_API_BASE__, 'https://original.example');
  assert.equal('__HEX_CHATGPT_BRIDGE__' in globalObject, false);
  assert.equal('__HEX_DEV_WORKER_CLIENT__' in globalObject, false);
  assert.equal('__HEX_AI_PROVIDER__' in globalObject, false);
});

// ---------------------------------------------------------------------------
// [T10-P2-3] plugins.js — installFromUrl URL scheme & post-redirect check
// ---------------------------------------------------------------------------
test('T10-P2-3: installFromUrl rejects non-HTTPS URLs and non-HTTPS redirects while staying mock-compatible', async () => {
  const origFetch = globalThis.fetch;
  let fetchCalled = 0;
  try {
    globalThis.fetch = async () => { fetchCalled++; return { ok: true, status: 200 }; };
    const install = (url, opts) => PluginHost.prototype.installFromUrl.call({}, url, opts);

    for (const bad of ['http://example.com/p.js', 'javascript:alert(1)', 'data:text/javascript,1', 'file:///etc/passwd', 'not-a-url']) {
      const res = await install(bad);
      assert.ok(typeof res.error === 'string' && res.error.length > 0, `expected error for ${bad}`);
      assert.equal(res.ok, undefined);
    }
    assert.equal(fetchCalled, 0, 'fetch must never be called for disallowed URL schemes');

    // Redirect to non-HTTPS must cancel body and return { error }
    let bodyCancelled = false;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      url: 'http://evil.example/redirected.js',
      headers: { get: () => '10' },
      body: { cancel: async () => { bodyCancelled = true; } },
    });
    const redir = await install('https://good.example/p.js');
    assert.ok(typeof redir.error === 'string');
    assert.equal(redir.ok, undefined);
    assert.equal(bodyCancelled, true);

    // Mock response without res.url still succeeds
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '12' },
      text: async () => 'hex.plugin()',
    });
    const okRes = await install('https://good.example/p.js');
    assert.equal(okRes.ok, true);
    assert.equal(okRes.source, 'hex.plugin()');
    assert.equal(okRes.origin, 'https://good.example/p.js');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// [T10-P2-4] sandbox.js — sandboxOutputSize backing-store metering
// ---------------------------------------------------------------------------
test('T10-P2-4: sandboxOutputSize meters backing store in both module and standalone VM extraction', () => {
  const start = SANDBOX_SOURCE.indexOf('function sandboxOutputSize');
  const end = SANDBOX_SOURCE.indexOf('\nfunction isAbortSignalLike', start);
  assert.ok(start >= 0 && end > start);

  // Standalone extraction (like tests/sandbox-private-control-boundary-5493.test.mjs)
  const standaloneScope = {};
  vm.runInNewContext(
    `const MAX_SANDBOX_OUTPUT_BYTES = 256 * 1024;\n${SANDBOX_SOURCE.slice(start, end)}\nglobalThis.__fn = sandboxOutputSize;`,
    standaloneScope,
  );
  const over = 256 * 1024 + 1;

  // 1-byte Uint8Array over 300 KiB backing store must charge backing store (> budget)
  assert.equal(
    vm.runInNewContext('__fn(new Uint8Array(new ArrayBuffer(300 * 1024), 0, 1))', standaloneScope),
    300 * 1024,
  );
  // 1-byte DataView over 300 KiB backing store must charge backing store (> budget)
  assert.equal(
    vm.runInNewContext('__fn(new DataView(new ArrayBuffer(300 * 1024), 0, 1))', standaloneScope),
    300 * 1024,
  );
  // Two aliased views over same 100 KiB buffer charge backing store once
  const aliasedBytes = vm.runInNewContext(`
    const buf = new ArrayBuffer(100 * 1024);
    __fn([new Uint8Array(buf, 0, 1), new Uint8Array(buf, 1, 1)]);
  `, standaloneScope);
  assert.ok(aliasedBytes >= 100 * 1024 && aliasedBytes < 110 * 1024, `expected ~100KiB, got ${aliasedBytes}`);
  // SharedArrayBuffer-backed view fails closed
  assert.equal(
    vm.runInNewContext('__fn(new Uint8Array(new SharedArrayBuffer(16)))', standaloneScope),
    over,
  );
});

// ---------------------------------------------------------------------------
// [T10-P2-5] script.js — emulatorStep / emulatorRun AbortSignal anti-padding
// ---------------------------------------------------------------------------
test('T10-P2-5: emulatorStep and emulatorRun propagate AbortSignal even with extra padding arguments', async () => {
  const fakeApp = {
    store: { get: (k) => (k === 'architecture' ? 'arm64' : []) },
    codeRegion: () => null,
  };
  const { api } = createApi(fakeApp, () => {});
  const { id } = api.emulatorCreate(null, []);

  // Pre-aborted signal with variable-length padding arguments must reject immediately
  const ac1 = new AbortController();
  ac1.abort(new Error('cancelled-step'));
  await assert.rejects(
    () => api.emulatorStep(id, 'pad1', 'pad2', { signal: ac1.signal }),
    /cancelled-step/,
  );

  const ac2 = new AbortController();
  ac2.abort(new Error('cancelled-run'));
  await assert.rejects(
    () => api.emulatorRun(id, 1000, 'pad1', 'pad2', { signal: ac2.signal }),
    /cancelled-run/,
  );

  // Also works when context is passed directly as 2nd arg to emulatorRun
  const ac3 = new AbortController();
  ac3.abort(new Error('cancelled-run-direct'));
  await assert.rejects(
    () => api.emulatorRun(id, { signal: ac3.signal }),
    /cancelled-run-direct/,
  );
});

// ---------------------------------------------------------------------------
// [T10-P2-6] tests/oracle.py — clear error guidance when fixture missing/stub
// ---------------------------------------------------------------------------
test('T10-P2-6: tests/oracle.py prints clear guidance on missing or placeholder fixture without traceback', () => {
  const missing = spawnSync('python3', ['tests/oracle.py', 'tests/does-not-exist-xyz'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /fixture binary not found/i);
  assert.match(missing.stderr, /npm run fixtures:large/);
  assert.doesNotMatch(missing.stderr, /Traceback/);

  const placeholder = spawnSync('python3', ['tests/oracle.py', 'tests/battlecats'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(placeholder.status, 0);
  assert.match(placeholder.stderr, /placeholder fixture/i);
  assert.match(placeholder.stderr, /npm run fixtures:large/);
  assert.doesNotMatch(placeholder.stderr, /Traceback/);
});
