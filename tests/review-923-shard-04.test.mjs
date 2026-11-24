import test from 'node:test';
import assert from 'node:assert/strict';

import { provenAddressSpace } from '../js/analysis/alias/a1-region-alias.js';
import { aliasMemoryRegions } from '../js/analysis/alias/legacy-safety-floor.js';
import { taskHint, detectTask } from '../js/ai/prompts/task.js';
import { composePrompt } from '../js/ai/prompts/compose.js';
import { functionNameOf } from '../js/ai/ui/workbench.js';
import { publishBootstrapDiagnostic } from '../js/ai/dev/bootstrap/bootstrap-diagnostic.js';
import { decodeArtifactPayload, artifactPayloadChecksum, canonicalArtifactKeyValue, ArtifactError } from '../js/core/artifacts/contracts.js';
import { ResourceBudget } from '../js/core/budgets/index.js';
import { createEvidenceNode, EVIDENCE_NODE_FAMILIES } from '../js/core/evidence/index.js';
import { proposeMaskCondition, lowerMaskCondition } from '../js/core/evidence/task-idiom.js';
import { effectiveIndexOffset, renderExtendedIndex, renderIndexedMemory } from '../js/decompiler/address-semantics.js';
import { maxEffect, structuralKey } from '../js/decompiler/ast/nodes.js';
import { recoverAggregateLayouts } from '../js/decompiler/types/layout.js';
import { runAggregatePass } from '../js/decompiler/phase8/aggregates.js';
import { setLang, t } from '../js/i18n.js';
import { Store } from '../js/state.js';
import { SymbolIndex } from '../js/symbols.js';
import { TraceRingBuffer } from '../js/trace/ring-buffer.js';
import { createManagedRuntimeBinding, validateManagedRuntimeState } from '../js/managed/runtime-binding.js';
import { checkPreconditionsConsistency } from '../js/symbolic/verify/preconditions.js';
import { createTaintFlow } from '../js/symbolic/taint/flow.js';
import { createTaintModels } from '../js/symbolic/taint/models.js';
import { createX86DecodedInstruction } from '../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftArm64eAuthenticatedLoadEffects } from '../js/targets/architecture/arm64e/effects-memory.js';
import { liftRiscv64ControlEffects } from '../js/targets/architecture/riscv64/effects/control.js';

test('P1-S05-001 & P1-S05-002: alias provenAddressSpace & strict toBigInt fail closed on malformed inputs', () => {
  assert.equal(provenAddressSpace({ kind: 'rooted-offset', addressSpace: undefined }), 'memory');
  assert.equal(provenAddressSpace({ kind: 'rooted-offset', addressSpace: '' }), null);
  assert.equal(provenAddressSpace({ kind: 'rooted-offset', addressSpace: ' tls ' }), null);
  assert.equal(provenAddressSpace({ kind: 'rooted-offset', addressSpace: 123 }), null);
  const rel = aliasMemoryRegions(
    { kind: 'stack-fixed', functionId: 'f1', offset: '', widthBits: 64 },
    { kind: 'stack-fixed', functionId: 'f1', offset: false, widthBits: 64 },
  );
  assert.equal(rel, 'unknown');
});

test('P2-S12-010 & P1-S12-045 & P1-S12-044: taskHint rejects prototype keys and intentBlock trims whitespace', () => {
  assert.equal(taskHint('toString'), '');
  assert.equal(taskHint('constructor'), '');
  assert.equal(detectTask('この行の意味は？', { selection: 'instruction' }), 'explain_instruction');
  const prompt = composePrompt({ question: 'hello', intent: '   \n\t  ' });
  assert.ok(!prompt.system.includes('<intent>'));
});

test('P1-S11-022 & P2-S11-029: workbench functionNameOf handles invalid addr without throwing', () => {
  assert.equal(functionNameOf({}, 'not-a-number'), null);
  assert.equal(functionNameOf({}, 0x1000n), 'sub_1000');
});

test('P1-S09-010: publishBootstrapDiagnostic does not permanently cache no-op before #ai-panel mounts', () => {
  const g = { document: { getElementById: () => null } };
  publishBootstrapDiagnostic(g, { state: 'starting' });
  assert.equal(g.__HEX_DEV_BOOTSTRAP_DIAGNOSTIC__, undefined);
});

test('P1-S11-012 & P2-S11-029: contracts rejects Invalid Date with ArtifactError and handles non-Uint8Array views', () => {
  assert.throws(() => canonicalArtifactKeyValue(new Date('invalid')), ArtifactError);
  const encoded = new TextEncoder().encode('{"ok":true}');
  const dv = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  assert.deepEqual(decodeArtifactPayload(dv), { ok: true });
  assert.equal(artifactPayloadChecksum(dv), artifactPayloadChecksum(encoded));
});

test('P1-S11-014: ResourceBudget.checkCancelled checks ancestor AbortSignal', () => {
  const ac = new AbortController();
  const parent = new ResourceBudget({ ops: 10 }, { signal: ac.signal, name: 'parent' });
  const child = parent.scope('child', { ops: 5 });
  ac.abort(new Error('parent-cancelled'));
  assert.throws(() => child.checkCancelled(), /parent-cancelled/);
});

test('P2-S11-011: createEvidenceNode rejects excessively nested payloads with structured error', () => {
  let nested = { leaf: 1 };
  for (let i = 0; i < 80; i++) nested = { child: nested };
  assert.throws(() => createEvidenceNode({ id: 'ev1', family: EVIDENCE_NODE_FAMILIES.find(f => f !== 'Claim'), producer: 'test', origin: { instructionIds: ['i1'] }, payload: nested }), /evidence-payload-depth-exceeded/);
});

test('P1-S11-025 & P2-S11-029: task-idiom validates bits and non-null operand/sourceExpression', () => {
  assert.equal(proposeMaskCondition({
    kind: 'compare', op: '==', comparisonDomain: 'integer', effect: 'pure',
    left: { kind: 'binary', op: 'and', effect: 'pure', left: { kind: 'var', name: 'x' }, right: { kind: 'const', bits: 32, value: 1n } },
    right: { kind: 'const', bits: -1, value: 0n },
  }), null);
  assert.throws(() => lowerMaskCondition({
    schema: 'scpa-mask-condition-idiom/v1',
    kind: 'any-set',
    width: 32,
    maskHex: '0x1',
    operand: null,
    sourceExpression: null,
    scope: 'typed-bit-condition-only; not-C-or-machine-equivalence',
  }), /task-idiom-contract/);
});

test('P1-S03-027 & P2-S03-020: address-semantics masks empty extend to 64-bit and wraps compound expressions', () => {
  assert.equal(effectiveIndexOffset(-1n, '', 0), 0xffffffffffffffffn);
  assert.equal(renderExtendedIndex('a + b', 'lsl'), '(a + b)');
  assert.equal(renderIndexedMemory('a & b', 'i', { scale: 99 }), 'memory[(a & b) + __arm64_index_invalid_scale(i)]');
});

test('P1-S13-019 & P2-S13-014: AST maxEffect resists prototype keys and structuralKey preserves outer key on cycles', () => {
  assert.equal(maxEffect('pure', 'toString'), 'unknown');
  assert.equal(maxEffect('pure', 'constructor'), 'unknown');
  const a = { kind: 'unary', op: 'neg', bits: 64 };
  const b = { kind: 'unary', op: 'not', bits: 64, arg: a };
  a.arg = b;
  const k = structuralKey(a);
  assert.ok(k.startsWith('u:neg:'), `expected outer unary key, got ${k}`);
});

test('P1-S07-027 & P2-S07-017: layout handles negative offsets and invalid scales safely', () => {
  const ir = {
    instructions: [
      { op: 'load', id: 'i1', row: 1, loc: { kind: 'field', base: 'x0', disp: -16, size: 4 }, addr: { base: { id: 'v0', reg: 'x0' }, disp: -16 } },
      { op: 'load', id: 'i2', row: 2, loc: { kind: 'field', base: 'x0', disp: 0.5, size: 4 }, addr: { base: { id: 'v0', reg: 'x0' }, disp: 0.5 } },
      { op: 'load', id: 'i3', row: 3, loc: { kind: 'field', base: 'x0', size: 4 }, addr: { base: { id: 'v0', reg: 'x0' }, index: { id: 'v1' }, scale: 32, size: 4 } },
    ],
  };
  const layouts = recoverAggregateLayouts(ir, null, {});
  assert.equal(layouts.length, 1);
  assert.equal(layouts[0].fields.length, 1);
  assert.equal(layouts[0].fields[0].name, 'field_neg_10');
  assert.equal(layouts[0].indexed[0].scale, null);
});

test('P1-S04-011 & P2-S04-008 & P2-S04-015: aggregates handles sub-byte widthBits, bad scaleShift, and undefined budget limits', () => {
  const staged = new Map();
  const area = { stage: (k, v) => staged.set(k, v) };
  const cfg = {
    blocks: [{
      index: 0,
      insts: [
        { id: 'i1', op: 'load', extra: { memoryAccess: { widthBits: 1 } }, addr: { base: { id: 'p0' }, disp: 0 } },
        { id: 'i2', op: 'load', extra: { memoryAccess: { widthBits: 32 } }, addr: { base: { id: 'p0' }, index: { id: 'idx' }, scale: 1e8 } },
      ],
    }],
  };
  const analysis = new Map([['cfg', cfg]]);
  const res = runAggregatePass({ analysis }, { limits: { maxAccesses: undefined, maxRegions: undefined } }, area);
  assert.ok(res);
  assert.ok(staged.has('aggregates'));
});

test('P2-S09-026: i18n resists Object.prototype keys', () => {
  setLang('toString');
  assert.equal(t('constructor'), 'constructor');
  assert.equal(t('toString', { a: 1 }), 'toString');
});

test('P1-S02-037: Store.set ignores nullish patches and uses Object.is for NaN', () => {
  const store = new Store();
  assert.doesNotThrow(() => store.set(null));
  assert.doesNotThrow(() => store.set(undefined));
  let calls = 0;
  store.subscribe(() => { calls++; });
  store.set({ view: NaN });
  store.set({ view: NaN });
  assert.equal(calls, 1);
});

test('P1-S02-013 & P2-S02-021: SymbolIndex.setGuessedFunctions clears functionTopologyEnds and bumps revision', () => {
  const idx = new SymbolIndex();
  idx.funcs = new BigUint64Array([0x1000n, 0x2000n]);
  idx.functionTopologyEnds.set('4096', 0x1500n);
  const prevRev = idx.functionTopologyRevision;
  idx.setGuessedFunctions(new BigUint64Array([0x3000n]));
  assert.equal(idx.functionTopologyEnds.size, 0);
  assert.equal(idx.functionTopologyRevision, prevRev + 1);
});

test('P2-S11-012 & P1-S11-027: TraceRingBuffer uses O(1) ring, rejects tampered TypedArray constructor, and rejects Date', () => {
  const ring = new TraceRingBuffer({ maxEvents: 16 });
  for (let i = 0; i < 40; i++) assert.equal(ring.push({ type: 'tick', i }), true);
  assert.equal(ring.events.length, 16);
  assert.equal(ring.snapshot().events[0].i, 24);
  assert.equal(ring.snapshot().events[15].i, 39);
  assert.equal(ring.push({ type: 'bad-date', at: new Date(0) }), false);
  const arr = new Uint8Array([1, 2, 3]);
  let tamperedCalled = false;
  Object.defineProperty(arr, 'constructor', { value: function () { tamperedCalled = true; return new Uint8Array(0); } });
  assert.equal(ring.push({ type: 'typed', arr }), true);
  assert.equal(tamperedCalled, false);
});

test('P2-S01-010: runtime-binding rejects forged Proxy binding and freezes validated threads', () => {
  const binding = createManagedRuntimeBinding({
    frontendId: 'wasm',
    buildIdentity: 'b1',
    staticModuleIdentity: 'm1',
    runtimeModuleIdentity: 'm1',
    runtimeImplementation: 'v8',
    runtimeVersion: '1.0',
    providerIdentity: 'p1',
    runtimeInstanceIdentity: 'ri1',
    targetIdentity: 't1',
    binaryIdentity: 'bin1',
    loadMappingIdentity: 'lm1',
    sessionIdentity: 's1',
    capabilityVersion: '1',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
  });
  const forged = new Proxy({ ...binding }, {});
  assert.equal(validateManagedRuntimeState(forged, { threads: [] }).ok, false);
  const threads = [{ frames: [{ moduleIdentity: 'm1', locals: [1], operandStack: [2] }] }];
  const res = validateManagedRuntimeState(binding, { threads });
  assert.equal(res.ok, true);
  assert.ok(Object.isFrozen(res.threads));
  threads.push({ frames: [] });
  assert.equal(res.threads.length, 1);
});

test('P1-S03-011 & P2-S03-001: checkPreconditionsConsistency rejects stale/non-publishable solver results', async () => {
  const fakeSession = {
    async check() {
      return {
        schema: 'hex-solver-result/v1',
        status: 'sat',
        model: {},
        backend: 'mock',
        backendVersion: '1.0',
        queryHash: 'h',
        lifecycle: { publishable: false, stale: true },
      };
    },
  };
  const expr = { kind: 'bool-const', value: true, sort: { kind: 'bool' } };
  const res = await checkPreconditionsConsistency([expr], fakeSession);
  assert.equal(res.consistent, false);
});

test('P1-S13-006: taint flow rejects mutating clean singleton via value(null, ...)', () => {
  const models = createTaintModels({ id: 'model-1', version: '1.0.0', provenance: 'test', sources: [], sinks: [], memorySinks: [], sanitizers: [] });
  const flow = createTaintFlow({ models, identity: { queryId: 'queryId_1', snapshotId: 'snapshotId_1', binaryId: 'binaryId_1', functionId: 'functionId_1', architecture: 'architecture_1', addressSpace: 'addressSpace_1', semanticsVersion: 'semanticsVersion_1' } });
  assert.throws(() => flow.value(null, [], 'data', { unknown: true }), /invalid-semantic-value-id/);
});

test('P2-S01-015 & P1-S01-029 & P1-S01-010: x86 decoded-instruction rejects getter array elements and parses negative hex', () => {
  const getterBytes = [0x90];
  let getterRan = false;
  Object.defineProperty(getterBytes, 0, { get() { getterRan = true; return 0x90; }, enumerable: true });
  assert.throws(() => createX86DecodedInstruction({
    address: 0x1000n, length: 1, rawBytes: getterBytes, instructionFamily: 'nop', instructionCode: 1,
  }), TypeError);
  assert.equal(getterRan, false);
});

test('P2-S01-020 & P1-S01-019: arm64e authenticated load handles prototype mnemonic and omitted #0 pre-index', () => {
  assert.equal(liftArm64eAuthenticatedLoadEffects({ mnemonic: 'toString', opStr: 'x0, [x1]' }), null);
  const pre = liftArm64eAuthenticatedLoadEffects({ instructionId: 'insn_1', mnemonic: 'ldraa', opStr: 'x0, [x1]!', address: 0x1000n, bytes: new Uint8Array([0x20, 0x0c, 0x20, 0xf8]) });
  assert.equal(pre.completeness, 'exact-with-intrinsic');
});

test('P1-S01-020 & P2-S01-033: riscv64 control effects wrap 64-bit PC arithmetic', () => {
  const bundle = liftRiscv64ControlEffects({
    architectureId: 'riscv64',
    instructionId: 'rv_wrap_1',
    address: 0xfffffffffffffffcn,
    length: 4,
    rawBytes: new Uint8Array([0x6f, 0x00, 0x40, 0x00]),
    mnemonic: 'jal',
  });
  assert.equal(BigInt(bundle.controlEffect.target.value), 0n);
});
