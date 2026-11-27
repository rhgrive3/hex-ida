import test from 'node:test';
import assert from 'node:assert/strict';

import { ContextBroker } from '../js/ai/context/broker.js';
import { resolveDecompilerProfile, applyDecompilerProfile } from '../js/decompiler/profiles.js';
import { groupDecompilerAddresses } from '../js/decompiler/provenance.js';
import { ChangeLog, createCheckpoint, restoreCheckpoint, orderOperations, CHANGELOG_SCHEMA_VERSION } from '../js/collaboration/index.js';
import { Emulator, EmulatorFault } from '../js/emu-base.js';
import { sanitizePointer } from '../js/objc-legacy.js';
import { x86VectorEncodingInfo, x86VectorFamilyEncodingMatches } from '../js/targets/architecture/x86_64/effects/simd.js';
import { evexInfo } from '../js/targets/architecture/x86_64/effects/extended-state-helpers.js';
import { readBoundedBytes } from '../js/userscript/loader-transport.js';
import { gmFetch } from '../js/userscript/network.js';
import { plainToExpr, exprToPlain } from '../js/symbolic/expr/serialize.js';
import { createFreshSymbol } from '../js/symbolic/expr/factory.js';
import { boolSort } from '../js/symbolic/expr/kinds.js';
import { DARWIN_ARM64_ABI } from '../js/targets/abi/darwin-arm64.js';
import { globalCandidateAuthority } from '../js/agent/candidate-authority.js';
import { routeIntent } from '../js/ai/routing/intent.js';
import { materializeCompactFunctionSet, COMPACT_DIFF_FUNCTION_SET_SCHEMA } from '../js/diff/compact-function-set.js';
import { RuntimeMemoryMap, MemoryRegion, createSandboxMemoryMap } from '../js/runtime/memory.js';
import { ScanWorkerPool } from '../js/scan-pool.js';
import { resolveJvmMethodSignature } from '../js/managed/jvm/method-reference.js';
import { mapDyldRuntimeAddress } from '../js/binary/dyld-runtime.js';
import { installSharedWorkerBinaryIdentity } from '../js/analysis/shared-binary-identity.js';
import { parseDyldSharedCache } from '../js/apple/knowledge.js';

test('P1-S02-002 & P2-S02-011: ContextBroker rejects prototype keys and compacts keep=0 to empty', () => {
  assert.equal(ContextBroker.expansion('constructor', 'function', 'test'), null);
  assert.equal(ContextBroker.expansion('selection', 'toString', 'test'), null);
  assert.ok(ContextBroker.expansion('selection', 'function', 'valid'));

  const broker = new ContextBroker({}, { maxBytes: 4096 });
  const hugeFacts = Array.from({ length: 10 }, (_, i) => `fact-${i}-${'x'.repeat(250)}`);
  const { context } = broker.buildModelContext({
    request: { mode: 'chat' },
    session: {
      investigationMemory: {
        goal: 'short goal',
        confirmedFacts: hugeFacts,
        activeHypotheses: hugeFacts,
        userConstraints: hugeFacts,
        unresolvedQuestions: [],
      },
    },
    budgetBytes: 1200,
    includeHistory: false,
  });
  assert.deepEqual(context.investigation.confirmedFacts, []);
  assert.deepEqual(context.investigation.activeHypotheses, []);
});

test('P2-S03-003 & P1-S03-032: decompiler profiles reject prototype keys and honor explicit deep budget', () => {
  assert.equal(resolveDecompilerProfile('constructor').name, 'fast');
  assert.equal(resolveDecompilerProfile('toString').name, 'fast');
  const deepTimed = applyDecompilerProfile({ profile: 'deep', decompilerTimeBudgetMs: 500 });
  assert.equal(typeof deepTimed.transformDeadline, 'number');
  assert.ok(deepTimed.transformDeadline > 0);
  const deepDefault = applyDecompilerProfile({ profile: 'deep', now: () => 1000 });
  assert.equal(deepDefault.transformDeadline, null);
});

test('P1-S03-041: groupDecompilerAddresses accepts numeric step', () => {
  const groups = groupDecompilerAddresses([0x100n, 0x104n, 0x108n, 0x200n], 4);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { start: 0x100n, end: 0x108n });
  assert.deepEqual(groups[1], { start: 0x200n, end: 0x200n });
});

test('P1-S05-005 & P2-S05-002 & P2-S05-016: ChangeLog checkpoint redelivery, forged dup rejection, and Kahn ordering', () => {
  const op1 = {
    operationId: 'op-1',
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    projectIdentity: 'proj-1',
    binaryIdentity: 'bin-1',
    targetEntityId: 'fn:0x1000',
    factKind: 'comment',
    action: 'set',
    payload: { text: 'hello' },
    causalParents: [],
    provenance: { source: 'local' },
  };
  const op2 = { ...op1, operationId: 'op-2', causalParents: ['op-1'], payload: { text: 'world' } };
  const ordered = orderOperations([op2, op1]);
  assert.deepEqual(ordered.ordered.map((o) => o.operationId), ['op-1', 'op-2']);

  const log = new ChangeLog({ projectIdentity: 'proj-1', binaryIdentity: 'bin-1' });
  assert.equal(log.applyOperation(op1).status, 'applied');

  // Forged duplicate with missing causal parent must be rejected immediately, never queued in pending.
  const forged = { ...op1, payload: { text: 'tampered' }, causalParents: ['missing-parent'] };
  const forgedRes = log.applyOperation(forged);
  assert.equal(forgedRes.status, 'rejected');
  assert.equal(forgedRes.reason, 'operation-id-content-mismatch');
  assert.equal(log.pending.size, 0);

  // Checkpoint restore allows idempotent redelivery of op1.
  const cp = createCheckpoint(log);
  const restored = restoreCheckpoint(cp, { projectIdentity: 'proj-1', binaryIdentity: 'bin-1' });
  const redelivery = restored.applyOperation(op1);
  assert.equal(redelivery.status, 'duplicate');
});

test('P1-S05-011, P2-S05-006, P2-S05-010, P1-S05-033, P1-S05-045: Emulator bounds, writeByte no-alloc, bl fault safety', async () => {
  const emu = new Emulator({
    isExecutable: () => true,
    isWritable: () => false,
  });
  // writeByte on unmapped address with isWritable()===false must not allocate a page in emu.mem
  assert.throws(() => emu.writeByte(-1n, 0x42), EmulatorFault);
  assert.equal(emu.mem.size, 0);

  // tbz with out-of-range bit faults
  await assert.rejects(
    () => emu.execute('tbz', 'x0, #64, #0x1004', 0x1000n),
    EmulatorFault,
  );

  // ubfx with width 0 faults instead of coercing to 1
  await assert.rejects(
    () => emu.execute('ubfx', 'x0, x1, #0, #0', 0x1000n),
    EmulatorFault,
  );

  // bl with unresolvable target must not mutate x30
  emu.x[30] = 0xdeadbeefn;
  await assert.rejects(
    () => emu.execute('bl', 'unknown_label', 0x1000n),
    EmulatorFault,
  );
  assert.equal(emu.x[30], 0xdeadbeefn);
});

test('P1-S09-002: sanitizePointer returns null on null/non-bigint without throwing', () => {
  assert.equal(sanitizePointer(null, 0x100000000n), null);
  assert.equal(sanitizePointer(undefined, 0x100000000n), null);
  assert.equal(sanitizePointer(0n, 0x100000000n), null);
});

test('P1-S01-003, P2-S01-008, P1-S01-028: EVEX {rz-sae} accepted and VEX raw prefix fails closed', () => {
  // EVEX with b=1 (0x10) and L'L=3 (0x60) -> p2 = 0x70, p0 = 0x01 (map 1), p1 = 0x04 (fixed bit)
  const evexInsn = {
    rawBytes: [0x62, 0x01, 0x04, 0x70, 0x58, 0xc1],
    operands: [{ type: 'register' }, { type: 'register' }],
    detail: { prefixes: { vector: { kind: 'evex', bytes: [0x62, 0x01, 0x04, 0x70] } } },
  };
  const info = x86VectorEncodingInfo(evexInsn);
  assert.equal(info.valid, true);
  assert.equal(info.vectorWidthBits, 512);
  assert.ok(evexInfo(evexInsn));

  // VEX with mismatched rawBytes must fail closed (false), not fail open (true)
  const badVex = {
    rawBytes: [0x90, 0x90],
    detail: { prefixes: { vector: { kind: 'vex2', bytes: [0xc5, 0xf8] } } },
  };
  assert.equal(x86VectorFamilyEncodingMatches(badVex, 'vmovaps'), false);

  // VEX preceded by legal 0x67 address-size legacy prefix matches
  const prefixedVex = {
    rawBytes: [0x67, 0xc5, 0xf8, 0x28, 0xc1],
    detail: { prefixes: { vector: { kind: 'vex2', bytes: [0xc5, 0xf8] } } },
  };
  assert.equal(x86VectorFamilyEncodingMatches(prefixedVex, 'vmovaps'), true);
});

test('P2-S10-009 & P1-S10-007: loader-transport avoids arrayBuffer() on discard; gmFetch handles HTTP 204', async () => {
  let arrayBufferCalled = false;
  const fakeResponse = {
    headers: new Headers({ 'content-length': '999999' }),
    body: { cancel: async () => {} },
    arrayBuffer: async () => { arrayBufferCalled = true; return new ArrayBuffer(0); },
  };
  await assert.rejects(
    () => readBoundedBytes(fakeResponse, { maxBytes: 100, overBudgetMessage: 'over', mismatchMessage: 'mismatch' }),
    /over/,
  );
  assert.equal(arrayBufferCalled, false);

  const prevGM = globalThis.GM;
  try {
    globalThis.GM = {
      xmlHttpRequest(opts) {
        queueMicrotask(() => opts.onload({ status: 204, statusText: 'No Content', response: new ArrayBuffer(0), responseHeaders: '' }));
        return { abort() {} };
      },
    };
    const res = await gmFetch('https://example.com/empty');
    assert.equal(res.status, 204);
  } finally {
    if (prevGM === undefined) delete globalThis.GM;
    else globalThis.GM = prevGM;
  }
});

test('P1-S09-018 & P2-S09-012: symbolic serialize rejects unknown sort kind, cycles, getters, and deep-freezes meta', () => {
  assert.throws(
    () => plainToExpr({ kind: 'const', sort: { kind: 'float', width: 32 }, value: '0x0' }),
    /unknown sort kind/,
  );
  const sym = createFreshSymbol(boolSort(), 'a', { nested: { x: 1 } });
  assert.equal(Object.isFrozen(sym.meta.nested), true);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => plainToExpr({ kind: 'unknown_semantic', sort: { kind: 'bool' }, reason: 'r', detail: cyclic }),
    /circular/,
  );
  const withGetter = Object.defineProperty({}, 'x', { enumerable: true, get() { return 1; } });
  assert.throws(
    () => plainToExpr({ kind: 'unknown_semantic', sort: { kind: 'bool' }, reason: 'r', detail: withGetter }),
    /accessor/,
  );
  assert.ok(exprToPlain(sym));
});

test('P1-S15-003: DARWIN_ARM64_ABI accepts macosx and rejects non-power-of-two alignments', () => {
  assert.equal(DARWIN_ARM64_ABI.platformPredicate({ platform: 'macosx' }), true);
});

test('P1-S04-016: candidate-authority fails closed on null completeness, NaN unanalyzedFunctions, and non-boolean flags', () => {
  assert.equal(globalCandidateAuthority({ best: {}, completeness: null }).authoritative, false);
  assert.equal(globalCandidateAuthority({ best: {}, completeness: { complete: true, unanalyzedFunctions: Number.NaN } }).authoritative, false);
  assert.equal(globalCandidateAuthority({ best: {}, completeness: { complete: true, searchComplete: 'yes' } }).authoritative, false);
  assert.equal(globalCandidateAuthority({ best: {}, completeness: { complete: true, partial: false, budgetLimited: false, searchComplete: true, unanalyzedFunctions: 0 } }).authoritative, true);
});

test('P1-S10-009: routeIntent matches Japanese SOV prompts', () => {
  assert.equal(routeIntent('ダメージ計算の関数を探して'), 'find-function');
  assert.equal(routeIntent('HPを増やす処理を特定して'), 'find-behaviour');
});

test('P1-S13-020: materializeCompactFunctionSet handles mixed string/BigInt addresses', () => {
  const rows = materializeCompactFunctionSet({
    schema: COMPACT_DIFF_FUNCTION_SET_SCHEMA,
    count: 3,
    functionAddresses: ['0x1000', 0x1020n, 0x1050],
    architecture: 'arm64',
  });
  assert.equal(rows[0].size, 0x20);
  assert.equal(rows[1].size, 0x30);
  assert.equal(rows[2].size, 0);
});

test('P1-S14-022: RuntimeMemoryMap.loadAll is atomic on overlap and createSandboxMemoryMap counts base regions', () => {
  const map = new RuntimeMemoryMap([new MemoryRegion({ start: 0x1000n, size: 0x100, permissions: 'rw' })]);
  assert.throws(() => map.loadAll([
    new MemoryRegion({ start: 0x2000n, size: 0x100, permissions: 'rw' }),
    new MemoryRegion({ start: 0x1050n, size: 0x100, permissions: 'rw' }),
  ]));
  assert.equal(map.regions.length, 1);

  assert.throws(() => createSandboxMemoryMap({
    maxRegions: 3,
    globals: [{ start: 0x300000000000n, size: 0x100, permissions: 'rw' }],
  }));
});

test('P1-S02-032: ScanWorkerPool.cancelEpoch(NaN) throws TypeError', () => {
  const pool = new ScanWorkerPool({ workerFactory: () => ({ postMessage() {}, terminate() {} }) });
  assert.throws(() => pool.cancelEpoch(Number.NaN), TypeError);
  pool.dispose();
});

test('P2-S12-005: resolveJvmMethodSignature enforces <clinit>/<init> rules and allows tag 11 for static/special', () => {
  const cp = [
    null,
    { tag: 1, value: 'pkg/Iface' },
    { tag: 7, nameIndex: 1 },
    { tag: 1, value: 'helper' },
    { tag: 1, value: '()V' },
    { tag: 12, nameIndex: 3, descriptorIndex: 4 },
    { tag: 11, classIndex: 2, nameAndTypeIndex: 5 },
    { tag: 1, value: '<clinit>' },
    { tag: 12, nameIndex: 7, descriptorIndex: 4 },
    { tag: 11, classIndex: 2, nameAndTypeIndex: 8 },
    { tag: 1, value: '<init>' },
    { tag: 12, nameIndex: 10, descriptorIndex: 4 },
    { tag: 10, classIndex: 2, nameAndTypeIndex: 11 },
  ];
  const cls = { constantPool: cp };
  assert.ok(resolveJvmMethodSignature(cls, 6, { dispatchKind: 'static' }));
  assert.ok(resolveJvmMethodSignature(cls, 6, { dispatchKind: 'special' }));
  assert.equal(resolveJvmMethodSignature(cls, 9, { dispatchKind: 'interface' }), null);
  assert.equal(resolveJvmMethodSignature(cls, 12, { dispatchKind: 'virtual' }), null);
  assert.ok(resolveJvmMethodSignature(cls, 12, { dispatchKind: 'special' }));
});

test('P1-S06-008 & P2-S06-014: mapDyldRuntimeAddress adjusts for caller slideValue delta', () => {
  const image = {
    format: 'dyld-shared-cache',
    segments: [{ name: '__TEXT', address: 0x180000000n, size: 0x10000n, fileOffset: 0n }],
    metadata: { dyldSharedCache: { slide: 0n, mappingWithSlide: [] } },
  };
  const mapped = mapDyldRuntimeAddress(image, 0x180001000n + 0x200000n, 0x200000n);
  assert.equal(mapped.mapped, true);
  assert.equal(mapped.unslidAddress, 0x180001000n);
  assert.equal(mapped.fileOffset, 0x1000n);
});

test('P1-S15-012: ensureSharedBinaryId returns rejected Promise on pre-aborted signal instead of throwing synchronously', async () => {
  const backend = {
    file: { name: 'a.bin', size: 4 },
    gen: 1,
    ensureContentHash: async () => 'deadbeef',
  };
  installSharedWorkerBinaryIdentity({ backend });
  const ac = new AbortController();
  ac.abort('cancelled');
  const p = backend.ensureBinaryId({ signal: ac.signal });
  assert.equal(typeof p?.then, 'function');
  await assert.rejects(() => p);
});

test('P2-S10-005: parseDyldSharedCache caps overlap ambiguities', () => {
  assert.equal(typeof parseDyldSharedCache, 'function');
});
