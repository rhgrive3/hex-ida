import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentTools } from '../js/agent/tools-core.js';
import { availableAgentProfiles, canSelectAgentProfile } from '../js/ai/dev/policy/agent-profile.js';
import { DevRunEventHost } from '../js/ai/dev/events/dev-events.js';
import { missingLabel } from '../js/ai/render/missing.js';
import { AiSession } from '../js/ai/ui/session.js';
import { createAiEngine } from '../js/ai/ui/bridge.js';
import { resolveVirtualTargetSet } from '../js/analysis/cxx/virtual-dispatch.js';
import { applyAarch64MappingSymbols } from '../js/binary/elf-aarch64-mapping.js';
import { PagedArtifactReader } from '../js/core/artifacts/paging/index.js';
import { ArtifactStore } from '../js/core/artifacts/store.js';
import { MemoryArtifactBackend } from '../js/core/artifacts/backends.js';
import { createValidationBatch } from '../js/core/identity/live-data.js';
import * as expr from '../js/expr.js';
import { recoverArm64ClangIdiom } from '../js/decompiler/idioms/arm64-clang.js';
import { expr as astExpr } from '../js/decompiler/ast/nodes.js';
import { structureKnownSwitches } from '../js/decompiler/switch.js';
import { observableEffectReason } from '../js/decompiler/phase8/dce.js';
import { decodeArm64PatchWord, suggestPatches } from '../js/patch.js';
import { mergeRangeDomain } from '../js/range-domain.js';
import { StringCollectionBudget } from '../js/string-budget.js';
import { arm64FpExceptionTrapFault } from '../js/targets/architecture/arm64/effects/fp-exception-traps.js';
import { fingerprintFunction } from '../js/fingerprint/index.js';
import { verifyPatchEquivalence } from '../js/symbolic/verify/patch.js';
import { createBv, createFreshSymbol, bvSort } from '../js/symbolic/expr/index.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { createCilCallStackEffect } from '../js/managed/cil/call-signatures.js';
import { liftCilMethod } from '../js/managed/cil/lifter-core.js';
import { buildSemanticSsa } from '../js/semantics/ssa/build-core.js';

test('P1-S04-003 & P1-S04-004: tools-core completeness and canonical function start', async () => {
  const analyzed = [];
  const calleesCalls = [];
  const ctx = {
    program: {
      functionRange: (addr) => ({ start: 0x1000n, end: 0x1040n }),
      calleesOf: (start, end, req) => {
        calleesCalls.push({ start, end, req });
        return Array.from({ length: req }, (_, i) => ({ addr: 0x2000n + BigInt(i * 4) }));
      },
    },
    analyze: async (start, end) => {
      analyzed.push({ start, end });
      return { instructions: [], blocks: [] };
    },
  };
  const tools = createAgentTools(ctx);
  await tools.get_function(0x1014n);
  assert.equal(analyzed[0].start, 0x1000n);

  const res = await tools.get_callees(0x1014n, { limit: 2, offset: 0 });
  assert.equal(calleesCalls[0].start, 0x1000n);
  assert.equal(res.complete, false);
  assert.equal(res.truncated, true);
});

test('P2-S09-002 & P1-S09-011: agent-profile requires authenticated === true', () => {
  assert.deepEqual([...availableAgentProfiles({ authenticated: false, admin: true })], ['standard']);
  assert.equal(canSelectAgentProfile({ authenticated: false, capabilities: { canUseDevAgent: true } }, 'dev'), false);
  assert.equal(canSelectAgentProfile({ authenticated: true, admin: true }, 'dev'), true);
});

test('P1-S09-012: dev-events preserves waiting on resume throw and releases on unmatched event', async () => {
  let shouldThrow = true;
  const supervisor = {
    applyDecision: (run, decision) => ({ run, decision }),
    resume: (run) => {
      if (shouldThrow) throw new Error('resume-failed');
      return { ...run, status: 'running' };
    },
    workerTools: {
      waitEvent: async () => ({ type: 'human.responded', data: {} }),
    },
  };
  const coord = new DevRunEventHost({ supervisor });
  const run = { runId: 'run-1' };
  coord.waiting.set('run-1', Object.freeze({ kind: 'event', events: ['worker.completed'] }));
  assert.throws(() => coord.acceptEvent(run, { type: 'worker.completed', data: {} }), /resume-failed/);
  assert.ok(coord.waitingFor('run-1'), 'waiting entry must survive resume() throw');

  shouldThrow = false;
  const res = await coord.waitForWorkerDecision({ runId: 'run-2' }, { type: 'wait', events: ['worker.completed'] });
  assert.equal(res.resumed, false);
  assert.equal(coord.waitingFor('run-2'), null);
});

test('P2-S03-015 & P1-S03-039: missingLabel blocks prototype keys', () => {
  const res = missingLabel('constructor');
  assert.equal(typeof res.label, 'string');
  assert.ok(res.label.includes('constructor'));
  assert.equal(typeof res.ask, 'string');
});

test('P1-S11-009 & P1-S11-024: AiSession historyFor(0) returns [] and flushSave clears timer', () => {
  const session = new AiSession({ storage: { namespace: () => 'ns', load: () => [], save: () => true } });
  session.current.turns.push({ role: 'user', text: 'hello' });
  assert.deepEqual(session.historyFor(0), []);
  assert.deepEqual(session.historyFor(-3), []);
  session.scheduleSave();
  assert.notEqual(session.saveTimer, null);
  session.flushSave();
  assert.equal(session.saveTimer, null);
});

test('P1-S11-010 & P2-S11-015: bridge runtime retries after failure and guards null engine', async () => {
  let attempts = 0;
  const app = { store: { get: () => null } };
  const engine = createAiEngine(app, {
    loadCore: async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient');
      return { createJob: async (x) => ({ ok: true, x }) };
    },
  });
  await assert.rejects(() => engine.createAgentJob({}), /AI core unavailable/);
  const ok = await engine.createAgentJob({ conversationId: 'c1' });
  assert.equal(ok.ok, true);
  assert.equal(attempts, 2);
});

test('P1-S14-029: virtual-dispatch keeps complete when closureProven even without RTTI', () => {
  const targetSet = resolveVirtualTargetSet({
    classEvidence: {
      rttiPresent: false,
      classes: [{ className: 'FinalObj', vtableAddress: '0x1000', slots: [{ index: 0, targetAddress: '0x2000', address: '0x2000', unresolved: false }] }],
      inheritance: [],
    },
    receiverClass: 'FinalObj',
    slotIndex: 0,
    dynamicClassProven: true,
    closureAuthority: { rule: 'exact-object-definition', callSiteId: 'call-1' },
  });
  assert.equal(targetSet.closureProven, true);
  assert.equal(targetSet.completeness, 'complete');
});

test('P1-S06-025: AArch64 mapping conflict terminates preceding $d span', () => {
  const dataInCode = [];
  const image = {
    format: 'elf',
    arch: 'arm64',
    sections: [{ index: 1, name: '.text', perms: { execute: true }, address: 0x1000n, size: 0x40n, fileOffset: 0, hasAddress: true }],
    symbols: [
      { name: '$d', address: 0x1000n, sectionIndex: 1, binding: 'local', kind: 'type-0', size: 0n },
      { name: '$x', address: 0x1010n, sectionIndex: 1, binding: 'local', kind: 'type-0', size: 0n },
      { name: '$d', address: 0x1010n, sectionIndex: 1, binding: 'local', kind: 'type-0', size: 0n },
    ],
    metadata: {},
    dataInCode,
    addDataInCodeEntry: (e) => dataInCode.push(e),
    isDataInCode: () => false,
    functions: [],
  };
  applyAarch64MappingSymbols(image);
  assert.equal(dataInCode.length, 1);
  assert.equal(dataInCode[0].length, 0x10);
});

test('P1-S11-008: PagedArtifactReader rejects pre-aborted signal before starting read', async () => {
  let reads = 0;
  const source = {
    size: 8192n,
    read: async () => { reads++; return new Uint8Array(4096); },
    readExactly: async () => { reads++; return new Uint8Array(4096); },
  };
  const paged = new PagedArtifactReader(source, { sourceId: 'src-1', pageSize: 4096 });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => paged.readRange(0n, 16, { signal: ac.signal }));
  assert.equal(reads, 0);
});

test('P1-S11-002 & P2-S11-030: ArtifactStore deletes corrupt non-byte payload and snapshots deleteIfMatches', async () => {
  const id = 'sha256:' + 'a'.repeat(64);
  let deleted = false;
  let deleteIfMatchesCalls = 0;
  const backend = {
    async getRaw() { return { record: { artifactId: id }, payload: 'not-bytes' }; },
    async putAtomic() { return { stored: true }; },
    async delete() { deleted = true; return true; },
    async deleteIfMatches() { deleteIfMatchesCalls++; throw new Error('should-not-call-with-non-bytes'); },
    capabilities() { return { persistent: false }; },
    async close() {},
  };
  const store = new ArtifactStore({ backend, corruptionPolicy: 'delete' });
  backend.deleteIfMatches = async () => { throw new Error('tampered-hook-must-not-run'); };
  const res = await store.get(id);
  assert.equal(res.status, 'corrupt');
  assert.equal(deleted, true);
  assert.equal(deleteIfMatchesCalls, 0);
});

test('P1-S11-018 & P2-S11-021: validation batch settle rejects re-entry and double settle', () => {
  const batch = createValidationBatch();
  batch.run(() => {
    assert.throws(() => batch.settle(), /validation-batch-invalid-state/);
  });
  assert.equal(batch.settle(), 0);
  assert.throws(() => batch.settle(), /validation-batch-invalid-state/);
});

test('P1-S05-012, P1-S05-013, P2-S05-005, P1-S05-036: expr fixes', () => {
  const min64 = expr.constNode(-(1n << 63n));
  const negated = expr.un('neg', min64);
  assert.equal(negated.v, -(1n << 63n));

  const ror32 = expr.bin('ror', expr.regNode('w0', 1), expr.constNode(5n), 32);
  assert.equal(ror32.bits, 32);

  let big = expr.regNode('x0', 1);
  for (let i = 0; i < 30; i++) big = expr.bin('add', big, expr.regNode('x1', i + 2), 64);
  const rendered = expr.render(big, { maxLen: 25 });
  assert.ok(rendered.length <= 25);
});

test('P1-S14-001: recoverArm64ClangIdiom matches c - (a * b) for msub, not (a * b) - c', () => {
  const a = astExpr.variable('a', 64, true);
  const b = astExpr.variable('b', 64, true);
  const c = astExpr.variable('c', 64, true);
  const mul = astExpr.binary('mul', a, b, 64, true);

  const wrongOrder = astExpr.binary('sub', mul, c, 64, true);
  assert.equal(recoverArm64ClangIdiom(wrongOrder).kind, 'binary');

  const rightOrder = astExpr.binary('sub', c, mul, 64, true);
  const recovered = recoverArm64ClangIdiom(rightOrder);
  assert.equal(recovered.kind, 'intrinsic');
  assert.equal(recovered.name, 'msub');
  assert.equal(recovered.args[2], c);
});

test('P2-S04-018: dce observableEffectReason blocks unknown ordering', () => {
  const reason = observableEffectReason({
    op: 'load',
    extra: {
      memoryAccess: { addressSpace: 'memory', volatility: false, atomic: false, ordering: 'unknown', faults: [] },
    },
  });
  assert.ok(reason && reason.includes('ordering'));
});

test('P1-S02-022 & P2-S02-026: patch.js ADD imm0 non-SP and prototype-safe suggestPatches', () => {
  // ADD X0, X1, #0 => 0x91000020 (rd=0, rn=1, neither is 31)
  assert.equal(decodeArm64PatchWord(0x91000020, 0x1000n), null);
  // ADD SP, X0, #0 => 0x9100001F (rd=31) => mov sp, x0
  assert.deepEqual(decodeArm64PatchWord(0x9100001f, 0x1000n), { mn: 'mov', ops: 'sp, x0' });

  const patches = suggestPatches('b.constructor', '#0x2000', 0x1000n);
  assert.equal(patches.some((p) => p.id === 'invert'), false);
});

test('P1-S02-028: mergeRangeDomain is commutative when signedness differs', () => {
  const a = { min: 0n, max: 10n, bits: 32, signed: true };
  const b = { min: 5n, max: 20n, bits: 32, signed: false };
  assert.deepEqual(mergeRangeDomain(a, b), mergeRangeDomain(b, a));
});

test('P1-S02-038: StringCollectionBudget.exhausted accounts for 96-byte minimum string cost', () => {
  const b = new StringCollectionBudget({ inputBytes: 1000, resultLimit: 100, estimatedHeapBytes: 150 });
  assert.equal(b.accept('a'), true); // 96 + 2 = 98 bytes, remaining 52 < 96
  assert.equal(b.exhausted, true);
});

test('P2-S01-016: arm64FpExceptionTrapFault blocks Object.prototype keys', () => {
  assert.equal(arm64FpExceptionTrapFault('fadd', { exceptionClasses: ['constructor', 'toString'] }), null);
});

test('P2-S09-027: fingerprintFunction validates address and rejects cycles', () => {
  assert.throws(() => fingerprintFunction({ address: '' }), /function-fingerprint-address-invalid/);
  assert.throws(() => fingerprintFunction({ address: true }), /function-fingerprint-address-invalid/);
});

test('P1-S03-012: verifyPatchEquivalence handles BigInt in memoryRegions without throwing', async () => {
  const x = createFreshSymbol(bvSort(8), 'x');
  const backend = new ExhaustiveBvBackend({ maxAssignments: 256 });
  const res = await verifyPatchEquivalence({
    originalTarget: x,
    patchedTarget: x,
    memoryRegions: [{ base: 0x1000n, size: 64n }],
    backend,
  });
  assert.ok(['proved', 'unknown', 'refuted'].includes(res.verdict));
});

test('P1-S14-003 & P1-S14-006: CIL explicitThis not double-counted; rem is partial and not rejects float', () => {
  const effect = createCilCallStackEffect('call', {
    complete: true,
    signature: {
      hasThis: true,
      explicitThis: true,
      parameters: [{ stackType: 'object-ref' }, { stackType: 'int32' }],
      returnValue: null,
    },
    provenance: { token: 0x06000001 },
  });
  assert.equal(effect.consumedValues.length, 2);

  const mkImage = (bytes) => ({
    format: 'cil',
    moduleId: 'mod-1',
    methodBodies: [{
      bytecode: Uint8Array.from(bytes),
      codeOffset: 0,
      headerOffset: 0,
      codeSize: bytes.length,
      maxStack: 4,
      exceptionClauses: [],
    }],
  });
  // ldc.i4.1 (0x17), ldc.i4.2 (0x18), rem (0x5d), ret (0x2a)
  const remRes = liftCilMethod(0, mkImage([0x17, 0x18, 0x5d, 0x2a]));
  const remOp = remRes.bundles.find((o) => o.mnemonic === 'rem');
  assert.equal(remOp.completeness, 'partial');

  // ldarg.0 (0x02 with float32 param), not (0x66), ret (0x2a)
  const notRes = liftCilMethod(0, mkImage([0x02, 0x66, 0x2a]), {}, {
    complete: true,
    signature: { hasThis: false, explicitThis: false, parameters: [{ stackType: 'float', primitive: 'r4' }], returnValue: null },
  });
  const notOp = notRes.bundles.find((o) => o.mnemonic === 'not');
  assert.equal(notOp.completeness, 'partial');
  assert.ok(notOp.unknownEffects.some((u) => u.reason === 'cil-not-floating-operand-invalid'));
});

test('P1-S12-053: buildSemanticSsa rejects non-numeric budget values', () => {
  assert.throws(() => buildSemanticSsa(null, null, { budget: { maxWorkItems: true } }), TypeError);
  assert.throws(() => buildSemanticSsa(null, null, { budget: { maxWorkItems: '10' } }), TypeError);
});
