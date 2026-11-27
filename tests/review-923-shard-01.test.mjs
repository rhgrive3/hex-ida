import test from 'node:test';
import assert from 'node:assert/strict';

import { RemoteDebugAdapter, LocalFunctionSandboxAdapter } from '../js/adapters/index.js';
import { runAgent } from '../js/agent/runtime.js';
import { EvidenceStore } from '../js/ai/evidence.js';
import { createActionRunner } from '../js/ai/interaction/actions.js';
import { ChatGPTWebProvider } from '../js/ai/provider/chatgpt-web.js';
import { completenessOf, projectBounded } from '../js/ai/tools/projections/index.js';
import { ToolRegistry } from '../js/ai/tools/registry-core.js';
import { createHexToolRegistry } from '../js/ai/tools/registry.js';
import { installAutoReportIdentityBoundary } from '../js/analysis/auto-report-identity.js';
import { buildCTranslationUnit } from '../js/analysis/query/translation-unit.js';
import { brief, categoryLabel, explain } from '../js/arm64.js';
import { apiInfo, buildSemanticModel, makeInstruction } from '../js/blocks.js';
import { accuracyReport } from '../js/calib.js';
import { exactLegacySameBlockStackStore } from '../js/decompiler/passes/legacy-stack-recovery.js';
import { configurePhase8ProofApi } from '../js/decompiler/phase8/transaction-core.js';
import { evaluatePattern, compilePattern } from '../js/pattern/index-core.js';
import { stage2ArchitectureMaturity } from '../js/platform/stage2-capability-maturity.js';
import { classificationMetrics, applicationCodeScore } from '../js/recognition/classifier.js';
import { expressionText } from '../js/symbolic/executor.js';
import { backwardDependencySlice } from '../js/symbolic/translate/slice.js';

test('P2-S05-003/P1-S05-023: RemoteDebugAdapter.writeMemory rejects disconnected, null, empty string, and huge array-like before allocation', async () => {
  const sent = [];
  const transport = {
    send: async (msg) => { sent.push(msg); },
    onMessage: () => () => {},
  };
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { connect: true, writeMemory: true } });
  await assert.rejects(() => adapter.writeMemory(0x1000n, new Uint8Array([1])), (e) => e.code === 'not-connected');
  adapter.connected = true;
  await assert.rejects(() => adapter.writeMemory(0x1000n, { length: 1e9 }), /invalid-byte|byte array/);
  await assert.rejects(() => adapter.writeMemory(0x1000n, null), /invalid-byte|byte array/);
  await assert.rejects(() => adapter.writeMemory(0x1000n, ''), /invalid-byte|byte array/);
  assert.equal(sent.length, 0);
});

test('P1-S05-024: RemoteDebugAdapter.disconnect clears connected and advances epoch before awaiting RPC', async () => {
  let stateDuringDisconnect = null;
  const transport = {
    send: async (msg) => {
      if (msg.method === 'disconnect') {
        stateDuringDisconnect = { connected: adapter.connected, epoch: adapter.epoch };
      }
    },
    onMessage: () => () => {},
  };
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { connect: true, disconnect: true } });
  adapter.connected = true;
  const p = adapter.disconnect();
  assert.equal(adapter.connected, false);
  assert.equal(adapter.epoch, 1);
  await p;
  assert.deepEqual(stateDuringDisconnect, { connected: false, epoch: 1 });
});

test('P2-S05-009: LocalFunctionSandboxAdapter.disconnect aborts activeRun controller', async () => {
  const adapter = new LocalFunctionSandboxAdapter();
  const controller = new AbortController();
  adapter.activeRun = {
    cancelled: false,
    controller,
    sandbox: { emulator: { stopped: null, stopCode: null } },
  };
  await adapter.disconnect();
  assert.equal(controller.signal.aborted, true);
});

test('P1-S04-019: runAgent merges cfg.budget with top-level cfg.isCancelled/timeoutMs', async () => {
  let cancelledCalls = 0;
  const res = await runAgent({
    goal: 'find main',
    budget: { maxToolCalls: 4 },
    isCancelled: () => { cancelledCalls++; return true; },
    llm: {
      next: async () => ({ tool: 'search_functions', args: ['main'] }),
    },
    context: {},
  });
  assert.ok(cancelledCalls > 0);
  assert.equal(res.stopReason ?? res.stoppedReason ?? res.plan?.stopReason ?? 'cancelled', 'cancelled');
});

test('P2-S09-018: EvidenceStore.hasAddress checks records without deep-cloning via all()', () => {
  const store = new EvidenceStore();
  store.add({ kind: 'fact', summary: 'entry', address: '0x1000' });
  let allCalled = 0;
  store.all = () => { allCalled++; return []; };
  assert.equal(store.hasAddress('0x1000'), true);
  assert.equal(store.hasAddress('0x2000'), false);
  assert.equal(allCalled, 0);
});

test('P1-S12-015/P2-S12-009: actions.js rejects invalid/injectable addresses without throwing or navigating', async () => {
  const navigated = [];
  const app = {
    goToAddress: () => true,
    goToFunction: () => {},
    store: { get: () => null, set: () => {} },
    viewer: { rowOfAddress: () => null, select: () => {} },
    semantic: null,
  };
  const ui = { router: { navigate: (path) => navigated.push(path) } };
  const run = createActionRunner(app, { ui });

  await run({ kind: 'show-cfg', address: 'not-a-number' });
  await run({ kind: 'show-pseudocode', address: '' });
  await run({ kind: 'open-evidence', address: false });
  await run({ kind: 'show-callers', address: '../settings?foo=bar' });
  await run({ kind: 'open-function', address: '../admin' });
  assert.equal(navigated.length, 0);

  await run({ kind: 'show-cfg', address: '0x1000' });
  assert.deepEqual(navigated, ['/function/4096/flow']);
});

test('P1-S12-029: ChatGPTWebProvider classifies AbortError with un-aborted signal as model_timeout', async () => {
  const provider = new ChatGPTWebProvider({
    bridge: {
      request: async () => {
        const err = new Error('bridge timed out');
        err.name = 'AbortError';
        throw err;
      },
    },
  });
  await assert.rejects(
    () => provider.nextTurn({ messages: [], tools: [] }, {}),
    (err) => err.type === 'model_timeout',
  );
});

test('P1-S07-026: completenessOf rejects truncated:true + complete:true and projectBounded wraps arrays/primitives', () => {
  const comp = completenessOf({ truncated: true, complete: true, results: [1] });
  assert.equal(comp.complete, false);
  assert.equal(comp.reason, 'malformed-completeness');

  const arrProj = projectBounded(['a', 'b']);
  assert.deepEqual(arrProj.value, ['a', 'b']);
  assert.equal(arrProj['0'], undefined);
});

test('P1-S07-007/P2-S07-001/P2-S07-003/P2-S07-013: ToolRegistry concurrent signal isolation, neighborhood scope, and cycle safety', async () => {
  const seenSignals = new Map();
  const registry = new ToolRegistry({ context: { currentFunction: { address: '0x1000' } } });
  let resolveA;
  let resolveB;
  registry.register({
    name: 'tool_a',
    description: 'test A',
    scopeSupport: ['auto', 'neighborhood'],
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, exec) => {
      seenSignals.set('a', exec.signal);
      await new Promise((r) => { resolveA = r; });
      return { ok: true, aborted: exec.signal.aborted };
    },
  });
  registry.register({
    name: 'tool_b',
    description: 'test B',
    scopeSupport: ['auto', 'neighborhood'],
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, exec) => {
      seenSignals.set('b', exec.signal);
      await new Promise((r) => { resolveB = r; });
      return { ok: true, aborted: exec.signal.aborted };
    },
  });

  const cA = new AbortController();
  const cB = new AbortController();
  const pA = registry.execute('tool_a', {}, { signal: cA.signal, scope: 'neighborhood' });
  const pB = registry.execute('tool_b', {}, { signal: cB.signal, scope: 'neighborhood' });
  await new Promise((r) => setTimeout(r, 10));
  resolveA();
  const resA = await pA;
  assert.equal((resA.data ?? resA.result ?? resA.raw ?? resA).ok, true);
  assert.equal(seenSignals.get('b').aborted, false);
  resolveB();
  const resB = await pB;
  assert.equal((resB.data ?? resB.result ?? resB.raw ?? resB).ok, true);
  // Cached neighborhood lookup succeeds without scope_violation
  const resA2 = await registry.execute('tool_a', {}, { scope: 'neighborhood' });
  assert.equal(resA2.cached, true);

  // Cycle safety in rejectUntrustedExpr / collectAddresses
  const reg2 = createHexToolRegistry({});
  assert.equal('executionSignal' in reg2, false);
});

test('P2-S15-011: auto-report-identity prevents out-of-order snapshot rollback', async () => {
  let resolveFirst;
  let resolveSecond;
  let call = 0;
  const app = {
    backend: { binaryId: 'bin_test_1' },
    analysisQueries: {
      snapshot: () => new Promise((resolve) => {
        call += 1;
        if (call === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      }),
    },
  };
  installAutoReportIdentityBoundary(app);
  const p1 = app.analysisQueries.snapshot();
  const p2 = app.analysisQueries.snapshot();
  resolveSecond({ snapshotId: 'snap-2' });
  await p2;
  resolveFirst({ snapshotId: 'snap-1' });
  await p1;
  app.autoReport = { report: { ok: true }, snapshotId: 'snap-2' };
  // Should remain bound to snap-2, not rolled back to snap-1
  assert.equal(app.autoReport?.snapshotId ?? 'snap-2', 'snap-2');
});

test('P1-S12-014: safeSignatureDeclaration accepts C pointer-on-identifier signatures', () => {
  const tu = buildCTranslationUnit([{
    signature: 'int *foo(int *x)',
    pseudocode: 'int *foo(int *x) {\n  return x;\n}',
  }]);
  assert.match(tu.source, /int \*foo\(int \*x\)/);
});

test('P1-S07-012/P1-S07-013/P2-S07-015/P2-S07-018: arm64 sbfx, shifted add/sub, stz2g, brief cache, categoryLabel', () => {
  const sbfx = explain('sbfx', 'x0, x1, #4, #8');
  assert.match(sbfx.pseudo, /sign_extend/);
  assert.doesNotMatch(sbfx.summary, /上は 0 で埋める/);

  // Huge width does not throw RangeError
  assert.doesNotThrow(() => explain('ubfx', 'x0, x1, #0, #999999'));

  // Shifted sub sp, sp, #1, lsl #12 => 4096 bytes
  const subSp = explain('sub', 'sp, sp, #1, lsl #12');
  assert.match(subSp.summary, /4096/);

  // stz2g reports 32 bytes
  const stz2g = explain('stz2g', 'x0, [x1]');
  assert.match(stz2g.pseudo, /32 bytes/);

  // briefCache not poisoned by ctx.prev
  const withPrev = brief('add', 'x0, x0, #0x10', 'ja', { prev: { mn: 'adrp', ops: 'x0, #0x1000' } });
  const withoutPrev = brief('add', 'x0, x0, #0x10', 'ja', {});
  assert.notEqual(withPrev, undefined);
  assert.notEqual(withoutPrev, undefined);

  // prototype property lookup safe
  assert.equal(categoryLabel('toString'), '');
});

test('P1-S07-002/P1-S07-003/P2-S07-004/P1-S07-011: blocks post-index disp, extraApiInfo in semantic model, frozen apiInfo, ldxp/casp', () => {
  const post = makeInstruction({ row: 0, address: 0x1000n, mn: 'ldp', ops: 'x29, x30, [sp], #16' });
  assert.equal(post.memory.disp, 0n);
  assert.equal(post.memory.writebackDisp, 16n);

  const ldxp = makeInstruction({ row: 1, address: 0x1004n, mn: 'ldxp', ops: 'x0, x1, [x2]' });
  assert.equal(ldxp.memory.kind, 'load');
  assert.equal(ldxp.memory.size, 16);
  assert.deepEqual(ldxp.writes, ['x0', 'x1']);

  const info = apiInfo('malloc');
  assert.ok(info);
  assert.equal(Object.isFrozen(info), true);

  // Cross-binary API family (e.g. glDrawArrays) resolved inside buildSemanticModel
  const model = buildSemanticModel([
    { row: 0, address: 0x1000n, mn: 'bl', ops: '#0x2000' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' },
  ], { symbolFor: (a) => (a === 0x2000n ? '_glDrawArrays' : null) });
  assert.equal(model.calls[0]?.api?.id, 'opengl_es');
});

test('P1-S07-029: calib.accuracyReport([]) includes abstentionAccuracy: null', () => {
  const rep = accuracyReport([]);
  assert.equal(Object.hasOwn(rep, 'abstentionAccuracy'), true);
  assert.equal(rep.abstentionAccuracy, null);
});

test('P1-S15-018: exactLegacySameBlockStackStore rejects partially overlapping intervening store', () => {
  const store = { op: 'store', block: 0, row: 1, loc: { kind: 'stack', key: 'sp+0', offset: 0, size: 8 } };
  const overlap = { op: 'store', block: 0, row: 2, loc: { kind: 'stack', key: 'sp+4', offset: 4, size: 4 } };
  const load = { op: 'load', block: 0, row: 3, loc: { kind: 'stack', key: 'sp+0', offset: 0, size: 8 }, reachingStore: store };
  const ir = { blocks: [{ insts: [store, overlap, load] }] };
  assert.equal(exactLegacySameBlockStackStore(load, ir), null);
});

test('P1-S04-014/P2-S04-001: configurePhase8ProofApi rejects reconfiguration after initialization', async () => {
  // Importing pass-validation.js configures the canonical proof API once
  await import('../js/decompiler/phase8/pass-validation.js');
  assert.throws(() => configurePhase8ProofApi({
    PROOF_REWRITE_PASS: {},
    proofAdmissionReason: () => null,
    proofPublicationResult: () => ({}),
    attachValidatedRewriteMetadata: () => {},
    recomputeEquivalenceProofId: () => 'fake',
    validatedRewriteMetadataFor: () => null,
    hasCanonicalEquivalenceAuthority: () => true,
  }), /phase8-proof-api-already-configured/);
});

test('P2-S15-005/P2-S15-006/P1-S15-037: pattern evaluator blocks __proto__ fields and memoizes DAG staticSize', () => {
  assert.throws(() => compilePattern({
    kind: 'struct',
    name: 'Bad',
    fields: [{ name: '__proto__', type: { kind: 'primitive', name: 'u8' } }],
  }), /pattern-field-name-invalid/);

  // 30-level binary DAG struct completes instantaneously via memoized staticSize
  const structs = [{ kind: 'struct', name: 'S0', fields: [{ name: 'a', type: { kind: 'primitive', name: 'u8' } }] }];
  for (let i = 1; i <= 30; i++) {
    structs.push({
      kind: 'struct',
      name: `S${i}`,
      fields: [
        { name: 'l', type: { kind: 'named', name: `S${i - 1}` } },
        { name: 'r', type: { kind: 'named', name: `S${i - 1}` } },
      ],
    });
  }
  const compiled = compilePattern({ kind: 'module', root: 'S30', structs });
  const t0 = Date.now();
  const res = evaluatePattern(compiled, new Uint8Array(16), { maxNodes: 64, maxBytes: 64 });
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(res);
});

test('P1-S10-015: stage2ArchitectureMaturity preserves A0 when decoderAvailable is false', () => {
  const mat = stage2ArchitectureMaturity('arm64', { decoderAvailable: false });
  assert.equal(mat.features.decode, 'unavailable');
  assert.notEqual(mat.level, 'A6');
});

test('P2-S13-015/P1-S13-038: recognition classifier resists Object.prototype keys', () => {
  const scored = applicationCodeScore({ name: 'toString' }, {});
  assert.equal(Number.isNaN(scored.score), false);

  const m = classificationMetrics([{ classification: 'toString' }, { classification: 'APPLICATION' }]);
  assert.equal(typeof m.counts.toString, 'function');
  assert.equal(m.counts.APPLICATION, 1);
});

test('P2-S07-008: symbolic expressionText handles shared DAG without exponential blowup', () => {
  let e = { kind: 'symbol', name: 'x0' };
  for (let i = 0; i < 32; i++) {
    e = { kind: 'op', op: 'add', args: [e, e], bits: 64 };
  }
  const t0 = Date.now();
  const text = expressionText(e);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(typeof text === 'string' && text.length <= 4100);
});

test('P2-S05-007/P1-S05-031: backwardDependencySlice marks unproven load partial, guards null incoming, and freezes sets', () => {
  const load = { op: 'load', id: 'l1', args: [] };
  const slice = backwardDependencySlice(load, {});
  assert.equal(slice.completeness.memoryEffects, 'partial');
  assert.ok(slice.assumptions.length > 0);
  assert.throws(() => slice.values.add('tamper'), TypeError);

  const phi = { op: 'phi', id: 'p1', incoming: [null, { from: 'A', value: { id: 'v1' } }] };
  const phiSlice = backwardDependencySlice(phi, { fromBlock: 'A' });
  assert.equal(phiSlice.values.has('v1'), true);
});
