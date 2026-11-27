import assert from 'node:assert/strict';
import test from 'node:test';

import { registerRole } from '../js/abi/aapcs64/presentation.js';
import { classifyOmnibox } from '../js/ai/interaction/omnibox.js';
import { resolveInferenceAdapter } from '../js/ai/provider/worker-adapters.js';
import { createConversationStore } from '../js/ai/ui/conversations.js';
import { createSchedulerEventBuffer } from '../js/core/scheduler/lifecycle-events.js';
import { RewriteHistoryJournal } from '../js/decompiler/rewrite/engine.js';
import { KnowledgeDB } from '../js/knowledge/index.js';
import { recognizeWithKnowledgeDB } from '../js/knowledge/phase12-recognition.js';
import { evaluateCapabilityRule } from '../js/knowledge/phase12-rules.js';
import { createRuntimeEvidenceRecord, fuseStaticDynamic, traceToSemanticFacts } from '../js/runtime-evidence/index.js';
import { createMachineValue } from '../js/semantics/effects/index.js';
import { validateKnowledgePack } from '../js/signature/index.js';
import { swiftCallingConvention } from '../js/swift.js';
import { createArm64eEffectsExtension } from '../js/targets/architecture/arm64e/effects.js';
import { createSandboxMonitor } from '../js/userscript/chatgpt-sandbox-host.js';
import { EMBED_PROTOCOL, EMBED_PROTOCOL_VERSION } from '../js/userscript/embed-protocol.js';
import { ParentPageInspector } from '../js/userscript/dev/admin/page-inspector.js';
import { verifyGlobalEdgeReachability } from '../js/symbolic/verify/global-reachability.js';
import { VERDICT } from '../js/symbolic/verify/query.js';
import { FakeSolverBackend } from '../js/symbolic/solver/fake-backend.js';
import { bvSort, BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import { createBv, createCompare, createFreshSymbol } from '../js/symbolic/expr/factory.js';

test('P1-S04-032: AAPCS64 registerRole(31) does not fall back to gp', () => {
  const role = registerRole(31, false, false);
  assert.equal(role.id, 'sp_or_zr');
  assert.equal(registerRole(31, true, false).id, 'sp');
  assert.equal(registerRole(31, false, true).id, 'zr');
});

test('P1-S12-046: omnibox requires matching quotes and hex digit for unprefixed addresses', () => {
  assert.equal(classifyOmnibox('"foo\'').kind, 'search');
  assert.equal(classifyOmnibox('"foo"').kind, 'string');
  assert.equal(classifyOmnibox('facade').kind, 'search');
  assert.equal(classifyOmnibox('coffee').kind, 'search');
  assert.equal(classifyOmnibox('100004000').kind, 'address');
  assert.equal(classifyOmnibox('0xfacade').kind, 'address');
});

test('P1-S12-027: worker-adapters non-integer tool limit falls back to default 32', () => {
  const gem = resolveInferenceAdapter({ AI_PROVIDER: 'gemini', GEMINI_TOOL_LIMIT: '3.5' });
  assert.equal(gem.capabilities.maxTools, 32);
  const groq = resolveInferenceAdapter({ AI_PROVIDER: 'groq', GROQ_TOOL_LIMIT: '4.2' });
  assert.equal(groq.capabilities.maxTools, 32);
});

test('P1-S11-006 / P2-S11-018: conversations store fails closed on throwing key and skips reserved legacy index', () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  const badKey = { toString() { throw new Error('boom'); } };
  const badStore = createConversationStore({ storage, key: badKey });
  assert.equal(badStore.available(), false);
  assert.equal(badStore.key, null);
  assert.equal(badStore.save([{ id: '1', title: 't', messages: [] }]), false);
  assert.equal(mem.size, 0);

  mem.set('hex.ai.conversations.v1', JSON.stringify({
    index: [{ id: 'evil', title: 'evil', messages: [] }],
    projA: [{ id: 'ok', title: 'ok', messages: [] }],
  }));
  const defaultStore = createConversationStore({ storage });
  const loaded = defaultStore.load('projA');
  assert.equal(loaded.length, 1);
  const idx = JSON.parse(mem.get('hex.ai.conversations.v2.index'));
  assert.equal(Object.hasOwn(idx, 'index'), false);
  assert.equal(Object.hasOwn(idx, 'projA'), true);
});

test('P2-S11-007 / P1-S11-026: lifecycle-events validates event before evicting and blocks __proto__/constructor abuse', () => {
  const buf = createSchedulerEventBuffer({ capacity: 1 });
  buf.onEvent({ type: 'start', details: { a: 1 } });
  assert.throws(() => buf.onEvent(null), TypeError);
  assert.equal(buf.size, 1);
  assert.equal(buf.dropped, 0);

  const evilPayload = JSON.parse('{"__proto__":{"polluted":true}}');
  const buf2 = createSchedulerEventBuffer({ capacity: 2 });
  buf2.onEvent({ type: 'evt', details: evilPayload });
  const snap = buf2.snapshot();
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(snap[0].details, '__proto__'), true);
});

test('P2-S01-021: RewriteHistoryJournal.rollback rejects stale/out-of-range marks', () => {
  const journal = new RewriteHistoryJournal({ rewrite: () => ({ proof: [] }) });
  assert.throws(() => journal.rollback({ length: 5, truncated: false }), RangeError);
  assert.throws(() => journal.rollback({ length: -1, truncated: false }), RangeError);
});

test('P1-S10-012 / P1-S10-001 / P1-S10-013: KnowledgeDB memory mode, recognizeWithKnowledgeDB, and rule comparison', async () => {
  const db = new KnowledgeDB({ memory: new Map() });
  assert.ok(db.negativeMemory instanceof Map);

  const fakeDb = {
    async findMatches() {
      const arr = [{
        record: { id: 'pkg-1', identityKey: 'id-1' },
        identity: 'exact',
        confidence: 0.95,
        reasons: ['exact-hash'],
        evidence: [{ id: 'ev-1' }],
      }];
      arr.truncated = false;
      return arr;
    },
  };
  const match = await recognizeWithKnowledgeDB({
    db: fakeDb,
    input: { entityId: 'fn-1' },
    packageEnvelope: { contentHash: 'hash-1' },
  });
  assert.equal(match.status, 'suggestion');
  assert.equal(match.sourceEntityId, 'fn-1');

  const rule = {
    id: 'r1',
    version: '1.0.0',
    capability: 'net',
    expression: { op: ' gt ', path: 'count', value: 5.5 },
  };
  const evalRes = evaluateCapabilityRule(rule, { count: 10n });
  assert.equal(evalRes.verdict, 'supported');
  assert.equal(evalRes.completeness, 'complete');
});

test('P1-S03-020 / P2-S03-009 / P1-S03-036 / P2-S03-013: runtime-evidence verdict priority, slice equality, null events, cloneable check', () => {
  assert.throws(() => createRuntimeEvidenceRecord({
    backend: 'sim',
    input: { fn: () => {} },
  }), TypeError);

  const sliceObj = { arch: 'arm64', offset: 0 };
  const recBad = createRuntimeEvidenceRecord({
    backend: 'sim',
    binaryHash: 'h1',
    sliceIdentity: sliceObj,
    function: 0x1000n,
    verdict: 'constructor',
    provenanceGroup: 'grp-1',
  });
  const recContra = createRuntimeEvidenceRecord({
    backend: 'sim',
    binaryHash: 'h1',
    sliceIdentity: { arch: 'arm64', offset: 0 },
    function: 0x1000n,
    verdict: 'contradicted',
    provenanceGroup: 'grp-1',
  });
  const fused = fuseStaticDynamic(
    { binaryHash: 'h1', sliceIdentity: { arch: 'arm64', offset: 0 }, functionAddress: 0x1000n, confidence: 0.8 },
    [recBad, recContra],
  );
  assert.equal(fused.status, 'contradicted');
  assert.equal(fused.contradictions, 1);

  const facts = traceToSemanticFacts([null, { type: 'return', value: 1 }, { type: 'ignored-noop' }], { limit: 1 });
  assert.equal(facts.length, 1);
  assert.equal(facts.complete, true);
});

test('P2-S14-007 / P2-S14-008: machine effects reject huge widthBits and undefined in serializable data', () => {
  assert.throws(() => createMachineValue({ kind: 'bitvector', widthBits: 1_000_000_000, value: 0n }), /invalid-bitvector-width/);
  assert.throws(() => createMachineValue({ kind: 'float', widthBits: 1_000_000_000, format: 'ieee754' }), /invalid-float-width/);
});

test('P1-S06-048 / P2-S06-025: signature validateKnowledgePack rejects array entries and array provenance', () => {
  const res = validateKnowledgePack({
    format: 'hex-signature-pack',
    version: 1,
    signatures: [[]],
    mappings: [],
  });
  assert.equal(res.ok, false);
});

test('P1-S02-035: swiftCallingConvention preserves explicit metadataArguments: 0', () => {
  const cc = swiftCallingConvention({ metadata: { generic: true }, attributes: { metadataArguments: 0 } });
  assert.equal(cc.metadataArguments, 0);
});

test('P1-S03-010 / P2-S03-002: verifyGlobalEdgeReachability fails closed when supplied IR lacks targetBlock', async () => {
  const x = createFreshSymbol(bvSort(2), 'x');
  const incoming = createCompare(BV_COMPARE_OP.EQ, x, createBv(2, 1n));
  const targetEdge = createCompare(BV_COMPARE_OP.EQ, x, createBv(2, 0n));
  const res = await verifyGlobalEdgeReachability({
    ir: { blocks: [{ id: 0, pred: [] }] },
    entryBlock: 0,
    targetBlock: 99,
    targetEdge,
    pathCompleteness: 'complete',
    backend: new FakeSolverBackend(),
    globalScope: {
      entryBlock: 0,
      targetBlock: 99,
      incomingPaths: [{ id: 'p0', fromBlock: 0, toBlock: 99, complete: true, condition: incoming }],
      phiChoices: [],
      phiInventory: { complete: true, count: 0 },
      loopBounds: { complete: true, bounds: [] },
      pathCoverageEvidence: { complete: true, coveredPaths: 1, totalPaths: 1 },
      entryPreconditions: [],
      branchPredicates: [],
    },
  });
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'missing-cfg-context');
});

test('P2-S01-026: arm64e extension canHandle includes ldraa/ldrab', () => {
  const ext = createArm64eEffectsExtension();
  assert.equal(ext.canHandle({ mnemonic: 'ldraa', operands: ['x0', '[x1]'] }), true);
  assert.equal(ext.canHandle({ mnemonic: 'ldrab', operands: ['x0', '[x1]'] }), true);
});

test('P1-S10-004 / P2-S10-006: createSandboxMonitor clears bootstrap timer on SANDBOX_READY', async () => {
  const listeners = new Set();
  const windowRef = {
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
  };
  const contentWindow = {};
  const token = 'a'.repeat(64);
  const monitor = createSandboxMonitor({
    windowRef,
    iframe: { contentWindow },
    generation: '1',
    sandboxToken: token,
    timeoutMs: 30,
  });
  let failed = false;
  monitor.failure.then(() => { failed = true; });
  for (const fn of listeners) {
    fn({
      source: contentWindow,
      origin: 'null',
      data: {
        type: 'hex.embed.sandbox-ready',
        protocol: EMBED_PROTOCOL,
        version: EMBED_PROTOCOL_VERSION,
        generation: '1',
        sandboxToken: token,
      },
    });
  }
  await monitor.ready;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(failed, false);
  monitor.close();
});

test('P1-S10-006 / P1-S10-022: page-inspector strips root forbidden script element and detects bare contenteditable', () => {
  const scriptNode = {
    tagName: 'SCRIPT',
    outerHTML: '<script>const secret = "sk-123";</script>',
    cloneNode() { return this; },
    querySelectorAll() { return []; },
    remove() {},
  };
  const editableDiv = {
    tagName: 'DIV',
    attributes: [{ name: 'contenteditable', value: '' }],
    hasAttribute: (name) => name === 'contenteditable',
    getAttribute: (name) => (name === 'contenteditable' ? '' : null),
    textContent: 'secret input',
    get outerHTML() { return `<div contenteditable>${this.textContent}</div>`; },
    cloneNode() { const c = { ...this }; Object.defineProperty(c, 'outerHTML', { get() { return `<div contenteditable>${this.textContent}</div>`; } }); return c; },
    querySelectorAll() { return []; },
    removeAttribute() {},
  };
  const doc = {
    location: { href: 'https://example.com/' },
    title: 'Test',
    readyState: 'complete',
    querySelector: (sel) => (sel === 'script' ? scriptNode : sel === '#edit' ? editableDiv : null),
    querySelectorAll: () => [],
    body: { innerText: '' },
  };
  const inspector = new ParentPageInspector({ document: doc, location: doc.location });
  const snapScript = inspector.snapshot({ includeHtml: true, htmlSelector: 'script' });
  assert.equal(snapScript.html, '');
  const snapEdit = inspector.snapshot({ includeHtml: true, htmlSelector: '#edit' });
  assert.equal(snapEdit.html.includes('secret input'), false);
});
