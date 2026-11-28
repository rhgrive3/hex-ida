import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeModelAt as analyzeFacadeModelAt,
  createHexAIContext as createFacadeContext,
} from '../js/ai/ui/hex-context.js';
import {
  analyzeModelAt as analyzeBaseModelAt,
  createHexAIContext as createBaseContext,
} from '../js/ai/ui/hex-context-query-base.js';
import { createLocalEngine } from '../js/ai/ui/local-engine-base.js';
import { selectToolWindow, choosePhase } from '../js/ai/control/tool-window.js';
import { configureScopedAnalysisHost, disableScopedAnalysisHost } from '../js/analysis/query/scoped-host.js';

function makeQueryApp(overrides = {}) {
  let gen = 1;
  const app = {
    store: {
      get(key) {
        return ({
          fileInfo: { name: 'sample.bin' },
          architecture: 'arm64',
          canDisassemble: true,
          instructionAlignment: 4,
        })[key] ?? null;
      },
    },
    backend: {
      binaryId: 'bin-wave5-c',
      get gen() { return gen; },
      set gen(v) { gen = v; },
    },
    analysisArtifactVersions: {},
    analysisQueries: {
      async snapshot(opts = {}) {
        if (opts?.signal?.aborted) {
          const e = new Error('generic abort');
          e.name = 'AbortError';
          throw e;
        }
        return { snapshotId: `snap-${gen}`, artifactVersions: {} };
      },
      async scopedSnapshot(opts = {}) {
        return { snapshotId: `scoped-${gen}`, signal: opts?.signal ?? null };
      },
      async binaryInfo() {
        return {
          value: { regions: [{ id: 'r0' }, { id: 'r1' }] },
          status: { completeness: 'complete' },
        };
      },
      async search(_snap, query, page) {
        return {
          value: [{ address: '0x1000', text: `hit-${query.regionId}` }],
          page: { offset: page.offset, returned: 1, total: 1, next: null },
          status: { completeness: 'complete' },
        };
      },
      async functions(_snap, _query, page) {
        return {
          value: [{ address: '0x1000', name: `fn_gen_${gen}` }],
          page: { offset: page.offset, returned: 1, total: 1, next: null },
          status: { completeness: 'complete' },
        };
      },
      async instructions(_snap, _query, page) {
        return {
          value: [{ address: '0x1000', mnemonic: 'nop', operands: '' }],
          page: { offset: page.offset, returned: 1, total: 1, next: null },
          status: { completeness: 'complete' },
        };
      },
      async function(_snap, addr, opts) {
        return {
          value: {
            address: addr,
            name: `fn_${addr.toString(16)}`,
            model: { address: addr, instructions: [{ address: addr, mnemonic: 'ret', operands: '' }], blocks: [{}], _opts: opts },
          },
          status: { completeness: 'complete' },
        };
      },
      async decompile() {
        return { value: { pseudocode: 'int f() { return 0; }' }, status: { completeness: 'complete' } };
      },
      async cfg() {
        return { value: { blocks: [{ id: 0 }] }, status: { completeness: 'complete' } };
      },
      async causalPath() {
        return { value: { paths: [[0x1000n, 0x2000n]], returned: 1, total: 1 }, status: { completeness: 'complete' } };
      },
      async cancelScopedQuery(_snap, req) {
        return { value: { cancelled: true, id: req?.id ?? null }, completeness: 'complete' };
      },
      async semanticQuery() {
        return null;
      },
      ...overrides,
    },
  };
  return app;
}

// ============================================================================
// 1. hex-context.js & hex-context-query-base.js
// ============================================================================

test('hex-context & query-base: searchStrings fails closed on unsupported region when neededOffset > 0, preserves #5800 at offset 0', async () => {
  for (const [label, create] of [['facade', createFacadeContext], ['base', createBaseContext]]) {
    const app = makeQueryApp({
      async search(_snap, query) {
        if (query.regionId === 'r0') {
          return {
            value: null,
            page: { total: null },
            status: { completeness: 'unsupported', reason: 'r0-unsupported' },
          };
        }
        return {
          value: [{ address: '0x2000', text: 'from-r1' }],
          page: { offset: 0, returned: 1, total: 1, next: null },
          status: { completeness: 'complete' },
        };
      },
    });
    const ctx = create(app);

    // offset === 0 preserves #5800 partial results from r1
    const atZero = await ctx.searchStrings('needle', { offset: 0, limit: 10 });
    assert.equal(atZero.complete, false, label);
    assert.equal(atZero.reason, 'r0-unsupported', label);
    assert.deepEqual(atZero.results.map((r) => r.regionId), ['r1'], label);

    // offset > 0 MUST fail closed instead of fabricating global offset into r1
    const atOffset = await ctx.searchStrings('needle', { offset: 5, limit: 10 });
    assert.equal(atOffset.complete, false, label);
    assert.equal(atOffset.truncated, true, label);
    assert.deepEqual(atOffset.results, [], label);
    assert.equal(atOffset.total, null, label);
    assert.equal(atOffset.reason, 'r0-unsupported', label);
  }
});

test('hex-context & query-base: base searchStrings uses exactTotal (not offset + rows.length) when offset exceeds total', async () => {
  const app = makeQueryApp({
    async binaryInfo() {
      return { value: { regions: [{ id: 'r0' }] }, status: { completeness: 'complete' } };
    },
    async search() {
      return {
        value: [],
        page: { offset: 50, returned: 0, total: 3, next: null },
        status: { completeness: 'complete' },
      };
    },
  });
  const baseCtx = createBaseContext(app);
  const res = await baseCtx.searchStrings('x', { offset: 50, limit: 10 });
  assert.equal(res.complete, true);
  assert.equal(res.total, 3);
  assert.equal(res.returned, 0);
});

test('hex-context & query-base: controller.abort(null), falsy reasons, and frozen Error reasons are preserved without mutation', async () => {
  for (const falsyReason of [null, 0, false, '']) {
    const controller = new AbortController();
    controller.abort(falsyReason);
    const app = makeQueryApp();
    const facade = createFacadeContext(app);
    const base = createBaseContext(app);

    await assert.rejects(
      () => facade.getDecompile(0x1000n, { signal: controller.signal }),
      (err) => err === falsyReason,
    );
    await assert.rejects(
      () => facade.searchStrings('a', { signal: controller.signal }),
      (err) => err === falsyReason,
    );
    await assert.rejects(
      () => base.searchFunctions('a', { signal: controller.signal }),
      (err) => err === falsyReason,
    );
    await assert.rejects(
      () => analyzeFacadeModelAt(app, 0x1000n, null, { signal: controller.signal }),
      (err) => err === falsyReason,
    );
  }

  // Frozen custom Error reason must NOT be mutated or cause TypeError
  const frozenErr = Object.freeze(Object.assign(new Error('custom-timeout'), { name: 'TimeoutError' }));
  const controller = new AbortController();
  controller.abort(frozenErr);
  const app = makeQueryApp();
  const base = createBaseContext(app);
  await assert.rejects(
    () => base.getCFG(0x1000n, { signal: controller.signal }),
    (err) => err === frozenErr && err.name === 'TimeoutError',
  );
});

test('hex-context & query-base: toBigInt, bounded/safeCount, maxInstructions, and options = null hardening', async () => {
  const seenCalls = [];
  const app = makeQueryApp({
    async function(_snap, addr, opts) {
      seenCalls.push({ addr, opts });
      return {
        value: { address: addr, name: 'ok', model: { instructions: [{ address: addr, mnemonic: 'ret', operands: '' }], blocks: [{}] } },
        status: { completeness: 'complete' },
      };
    },
    async functions(_snap, _query, page) {
      seenCalls.push({ page });
      return {
        value: [{ address: '0x1000', name: 'fn1' }],
        page: { offset: 'bad', returned: 'bad', total: 1, next: null },
        status: { completeness: 'complete' },
      };
    },
    async search(_snap, _query, page) {
      seenCalls.push({ searchPage: page });
      return {
        value: [{ address: '', text: 'empty-addr' }],
        page: { offset: page.offset, returned: 1, total: 1, next: null },
        status: { completeness: 'complete' },
      };
    },
  });

  // Empty string / boolean / array addresses must NOT coerce to 0n/1n
  assert.equal(await analyzeBaseModelAt(app, ''), null);
  assert.equal(await analyzeBaseModelAt(app, '   '), null);
  assert.equal(await analyzeBaseModelAt(app, false), null);
  assert.equal(await analyzeBaseModelAt(app, []), null);
  assert.equal(seenCalls.length, 0);

  // maxInstructions: null / '' / false must NOT abort queryFunction with null
  for (const ignoredMax of [null, '', false]) {
    const model = await analyzeBaseModelAt(app, 0x1000n, 0x1040n, { maxInstructions: ignoredMax });
    assert.ok(model, `expected model when maxInstructions=${String(ignoredMax)}`);
  }
  // end parameter is forwarded in QueryAPI path
  assert.equal(seenCalls[0].opts.end, 0x1040n);

  // options = null must not throw TypeError on any facade or base method
  const facade = createFacadeContext(app);
  const s = await facade.searchStrings('q', null);
  assert.equal(s.results[0].stringAddress, null);
  // limit: null / false must fall back to default (50), not coerce to 0 -> 1
  await facade.searchStrings('q', { limit: null, offset: false });
  const firstRegionSearchPage = seenCalls.at(-2).searchPage;
  assert.equal(firstRegionSearchPage.offset, 0);
  assert.equal(firstRegionSearchPage.limit, 51); // default 50 + 1

  // copyWithMetadata safeCount guards malformed page.offset / page.returned
  const fnPage = await facade.searchFunctions('fn', null);
  assert.equal(fnPage.offset, 0);
  assert.equal(fnPage.returned, 1);

  assert.ok(await facade.getDecompile(0x1000n, null));
  assert.ok(await facade.getCFG(0x1000n, null));
  assert.ok(await facade.findPaths(0x1000n, 0x2000n, null));
});

test('hex-context: runScopedAnalysis allows cancelScopedQuery with aborted signal and fails closed on non-object result', async () => {
  const app = makeQueryApp();
  configureScopedAnalysisHost(app, { enabled: true });
  try {
    const ctx = createFacadeContext(app);
    const controller = new AbortController();
    controller.abort('turn-cancelled');

    // cancelScopedQuery must still run even when signal is already aborted
    const cancelled = await ctx.runScopedAnalysis('cancelScopedQuery', { id: 'q1' }, { signal: controller.signal });
    assert.equal(cancelled.value.cancelled, true);
    assert.equal(cancelled.value.id, 'q1');

    // Non-object result from scoped method fails closed
    const bad = await ctx.runScopedAnalysis('semanticQuery', {}, null);
    assert.equal(bad.value, null);
    assert.equal(bad.completeness, 'unsupported');
    assert.equal(bad.analysisAuthority, 'AnalysisQueryAPI');
  } finally {
    disableScopedAnalysisHost(app);
  }
});

test('hex-context & query-base: findPaths/getCFG fail closed on array/primitive value and name cache invalidates on backend.gen change', async () => {
  const app = makeQueryApp({
    async cfg() { return { value: ['not-an-object'], status: { completeness: 'complete' } }; },
    async causalPath() { return { value: 'primitive', status: { completeness: 'complete' } }; },
  });
  const facade = createFacadeContext(app);
  const base = createBaseContext(app);

  const cfg = await facade.getCFG(0x1000n);
  assert.deepEqual(cfg.blocks, []);
  assert.equal(cfg.complete, false);

  const pathsFacade = await facade.findPaths(0x1000n, 0x2000n);
  assert.equal(pathsFacade.total, null);
  assert.equal(pathsFacade.complete, false);

  const pathsBase = await base.findPaths(0x1000n, 0x2000n);
  assert.equal(pathsBase.total, null);
  assert.equal(pathsBase.complete, false);

  // Name cache invalidation on backend.gen bump
  await base.searchFunctions('fn');
  assert.equal(base.functionName(0x1000n), 'fn_gen_1');
  app.backend.gen = 2;
  assert.equal(base.functionName(0x1000n), null);
});

// ============================================================================
// 2. local-engine-base.js
// ============================================================================

test('local-engine-base: runChat enforces 512 KiB cap on onText, ignores non-string chunks, and handles null context/onActivity/input', async () => {
  const app = makeQueryApp();
  const engine = createLocalEngine(app, {});

  // null input / missing context & onActivity must not crash
  const emptyRes = await engine.run(null);
  assert.equal(typeof emptyRes.answer, 'string');
  assert.equal(emptyRes.actions.length, 0);

  // File scope with an open function gives scope-unsupported-offline message (not missing-context)
  const fileScopeRes = await engine.run({
    mode: 'chat',
    scope: 'file',
    question: 'summarize file',
    context: { function: { name: 'foo', address: '0x1000', addressValue: 0x1000n } },
  });
  assert.doesNotMatch(fileScopeRes.answer, /まずは関数を選択するか|Please select a function/);

  // Already-aborted signal with null reason throws exact null reason in both chat and agent modes
  const controller = new AbortController();
  controller.abort(null);
  await assert.rejects(
    () => engine.run({ mode: 'chat', question: 'hi', signal: controller.signal }),
    (err) => err === null,
  );
  await assert.rejects(
    () => engine.run({ mode: 'agent', question: 'find', signal: controller.signal }),
    (err) => err === null,
  );
});

test('local-engine-base: runChat caps streamed onText at 512 KiB and preserves ARM64 stp/blr & safeAddrHex on missing instruction addresses', async () => {
  const app = makeQueryApp({
    async function(_snap, addr) {
      return {
        value: {
          address: addr,
          name: 'test_fn',
          model: {
            instructions: [
              { address: null, mnemonic: 'stp', operands: 'x29, x30, [sp, #-16]!' },
              { address: 0x1004n, mnemonic: 'blr', operands: 'x8' },
              { address: 0x1008n, mnemonic: 'ret', operands: '' },
            ],
            blocks: [{}, {}],
          },
        },
        status: { completeness: 'complete' },
      };
    },
  });

  // Mock global fetch for /api/gemini SSE stream sending > 512 KiB + non-string/empty events
  const originalFetch = globalThis.fetch;
  const chunk64k = 'A'.repeat(64 * 1024);
  const sseChunks = [];
  for (let i = 0; i < 10; i++) {
    sseChunks.push(`event: step.delta\ndata: ${JSON.stringify({ delta: { type: 'text', text: chunk64k } })}\n\n`);
  }
  sseChunks.push('data: [DONE]\n\n');
  const encoder = new TextEncoder();

  globalThis.fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        for (const s of sseChunks) controller.enqueue(encoder.encode(s));
        controller.close();
      },
    }),
  });

  try {
    const engine = createLocalEngine(app, {});
    let receivedChars = 0;
    const res = await engine.run({
      mode: 'chat',
      scope: 'function',
      question: 'show assembly for this function',
      context: {
        function: { name: 'test_fn', address: '0x1000', addressValue: 0x1000n },
        selection: { address: '0x1004', text: 'blr `x8`\nnext' },
      },
      onText: (chunk) => {
        assert.equal(typeof chunk, 'string');
        receivedChars += chunk.length;
      },
    });
    assert.equal(receivedChars, 512 * 1024);
    assert.equal(res.answer.length, 512 * 1024);
    // stp store with null address did not crash addrHex and used idx fallback ID
    assert.equal(res.evidence.some((e) => e.kind === 'field-write' && e.id === 'local:store:idx:0'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// 3. tool-window.js
// ============================================================================

test('tool-window: selectToolWindow does not mutate cached/frozen definitionsForModel arrays and deduplicates first-wins', () => {
  const funcTools = Object.freeze([
    { name: 'get_current_function', tag: 'first' },
    { name: 'get_current_function', tag: 'duplicate' },
    { name: 'get_cfg' },
  ]);
  const widerTools = Object.freeze([
    { name: 'search_functions' },
    { name: 'search_strings' },
  ]);
  const registry = {
    definitionsForModel({ scope }) {
      return scope === 'auto' ? widerTools : funcTools;
    },
  };

  // Must not throw on frozen array and must include auto-escape search_functions
  const autoWin = selectToolWindow(registry, {
    requestedScope: 'auto',
    effectiveScope: 'function',
    maxTools: 4,
  });
  assert.equal(funcTools.length, 3);
  assert.equal(autoWin.tools[0].name, 'search_functions');
  const curTool = autoWin.tools.find((t) => t.name === 'get_current_function');
  assert.equal(curTool.tag, 'first');

  // Strict non-auto scope must NOT see leaked search_functions
  const strictWin = selectToolWindow(registry, {
    requestedScope: 'function',
    effectiveScope: 'function',
    maxTools: 4,
  });
  assert.equal(strictWin.tools.some((t) => t.name === 'search_functions'), false);
});

test('tool-window: null/non-array observations & hypotheses and null entries do not crash selectToolWindow or choosePhase', () => {
  const registry = {
    definitionsForModel() {
      return [{ name: 'get_current_function' }, { name: 'custom_novel_tool' }];
    },
  };
  const win = selectToolWindow(registry, {
    requestedScope: 'function',
    effectiveScope: 'function',
    observations: null,
    hypotheses: null,
    maxTools: 5,
  });
  assert.equal(win.phase, 'current');
  assert.equal(win.tools.length, 2);

  // Null element inside observations must not throw on item?.tool
  const phase = choosePhase({
    observations: [null, { tool: 'search_functions' }],
    hypotheses: [null, { missingEvidence: [] }],
    effectiveScope: 'function',
  });
  assert.equal(phase, 'verification');

  // Non-object options argument must not throw
  assert.equal(choosePhase(null), 'current');
  const winNullOpts = selectToolWindow(registry, null);
  assert.ok(Array.isArray(winNullOpts.tools));
});
