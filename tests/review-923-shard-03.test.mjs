import test from 'node:test';
import assert from 'node:assert/strict';

import { ProposalStore } from '../js/ai/proposals.js';
import {
  normalizeAIInteraction,
  promptWorkbench,
  rejectBinaryPayload,
  sanitizeToolSchema,
} from '../js/ai/provider/worker-protocol.js';
import { fuseFunctionCandidates } from '../js/analysis/discovery/fusion.js';
import { jevAdvisoryRequest, jevArgumentContextSignature } from '../js/analysis/query/jev-advisory.js';
import { jevRecoveryRequest } from '../js/analysis/query/jev-recovery.js';
import { architectureCapability } from '../js/architecture/index.js';
import { AnalysisCache } from '../js/cache/analysis-cache.js';
import { ScopedAnalysisWork } from '../js/core/budgets/scoped-work.js';
import { chargeScopedWorkerCost } from '../js/core/budgets/scoped-worker.js';
import { evaluateNZCVCondition, invertBooleanCondition } from '../js/decompiler/flag-semantics.js';
import { truncateFact, joinFacts, fullFact } from '../js/decompiler/phase8/range.js';
import { branchConstraints, originOf, OP, MK } from '../js/ir-base.js';
import { createMemorySsaContract } from '../js/semantics/memoryssa/contract.js';
import { decodeRiscv64InstructionWord } from '../js/targets/architecture/riscv64/instruction-word.js';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';
import { reasonText } from '../js/ui/primitives.js';
import { installViewerDragReturnGuard } from '../js/ui/viewer-gesture-guard.js';

test('P1-S09-003 & P2-S09-001: ProposalStore charges parent ArrayBuffer and blocks getter TOCTOU', () => {
  const evidenceStore = { get: (id) => ({ id, status: 'verified' }), has: () => true };
  const store = new ProposalStore({ evidenceStore });
  const hugeBuf = new ArrayBuffer(512 * 1024);
  const tinyView = new Uint8Array(hugeBuf, 0, 1);
  assert.throws(() => store.create({
    kind: 'comment',
    target: '0x1000',
    before: tinyView,
    after: 'x',
    evidenceIds: ['ev1'],
  }), /budget/i);

  let getterCalls = 0;
  const hostileAfter = {};
  Object.defineProperty(hostileAfter, 'x', {
    enumerable: true,
    get() { getterCalls += 1; return getterCalls === 1 ? null : new Uint8Array(512 * 1024); },
  });
  assert.throws(() => store.create({
    kind: 'comment',
    target: '0x1000',
    before: 'old',
    after: hostileAfter,
    evidenceIds: ['ev1'],
  }), /accessor/i);
  assert.equal(getterCalls, 0);
});

test('P1-S12-003, P1-S12-016, P1-S12-028, P1-S12-047: worker-protocol schema, patch bytes, UTF-8, depth, binaryId', () => {
  const schema = sanitizeToolSchema({ type: 'object', properties: { s: { type: 'string' } } });
  assert.equal('properties' in schema.properties.s, false);

  const bytes40 = Array.from({ length: 40 }, (_, i) => i & 0xff);
  const interaction = normalizeAIInteraction({
    steps: [{
      type: 'tool_call',
      name: 'submit_hex_result',
      arguments: {
        answer: 'patch ready',
        proposals: [{ kind: 'patch', target: '0x1000', before: bytes40, after: bytes40, evidenceIds: ['e1'] }],
      },
    }],
  }, []);
  assert.equal(interaction.proposals[0].before.length, 40);
  assert.equal(interaction.proposals[0].after.length, 40);

  let deep = { leaf: 1 };
  for (let i = 0; i < 14; i++) deep = { next: deep };
  assert.throws(() => rejectBinaryPayload(deep), /depth|binary/i);

  const wb = promptWorkbench({ current: { binaryIdentity: { name: 'app.bin' } }, turn: { architecture: 'arm64' } });
  assert.equal(wb.binary?.name, 'app.bin');
});

test('P1-S13-001 & P1-S13-016: fusion reconcileOverlaps partitions by architecture and enforces maxCandidates', () => {
  const res = fuseFunctionCandidates([
    { kind: 'symbol-table', source: 'symtab', start: 0x1000n, regions: [{ start: 0x1000n, end: 0x1040n }], architectureId: 'arm64', name: 'f_arm', confidence: 0.99 },
    { kind: 'symbol-table', source: 'symtab', start: 0x1000n, regions: [{ start: 0x1000n, end: 0x1040n }], architectureId: 'x86_64', name: 'f_x64', confidence: 0.99 },
  ]);
  assert.equal(res.candidates.length, 2);
  for (const c of res.candidates) {
    assert.notEqual(c.extentState, 'unknown');
  }
  const capped = fuseFunctionCandidates([
    { kind: 'symbol-table', source: 'symtab', start: 0x1000n, architectureId: 'arm64', confidence: 0.9 },
    { kind: 'symbol-table', source: 'symtab', start: 0x1000n, architectureId: 'x86_64', confidence: 0.9 },
  ], { budget: { maxCandidates: 1 } });
  assert.equal(capped.status.completeness, 'truncated');
});

test('P1-S12-048 & P1-S12-049: jev-advisory null offset and jev-recovery formatting/typo', () => {
  const req = jevAdvisoryRequest('hp', [{ className: 'Player', offset: null, size: 4, functionContexts: [] }]);
  assert.match(req.questions.pick.criteria.c0, /offset unknown/);
  assert.equal(typeof jevArgumentContextSignature({ className: 'A', functionContexts: [] }), 'string');

  const rec = jevRecoveryRequest('hp', [{ className: 'Player', methodName: 'getHp', address: '0x1234', proof: 'vtable' }]);
  assert.ok(!rec.questions.pick.criteria.c0.includes('0x0x1234'));
  assert.throws(
    () => jevRecoveryRequest('hp', new Array(255).fill({ className: 'A' }), { requestPolicy: 'compact-accessor-v5' }),
    /at most 254/,
  );
});

test('P1-S06-021: architectureCapability respects partial semanticCapability', () => {
  const cap = architectureCapability({ format: 'macho', arch: 'arm64e', bits: 64 }, { arm64: true, arm64e: true });
  assert.equal(cap.analysisLevel, 'partial');
  const full = architectureCapability({ format: 'macho', arch: 'arm64', bits: 64 }, { arm64: true });
  assert.equal(full.analysisLevel, 'full');
});

test('P1-S02-020 & P2-S02-012: AnalysisCache stableValue rejects cycles/getters and invalidateStale handles non-string records', async () => {
  const cyc = {};
  cyc.self = cyc;
  assert.throws(() => new AnalysisCache({ memory: new Map(), settings: cyc }), TypeError);

  const cache = new AnalysisCache({ memory: new Map() });
  cache.memory.set(12345, { canonicalArtifactId: 999, schemaVersion: 1 });
  const removed = await cache.invalidateStale();
  assert.equal(removed, 1);
});

test('P1-S11-015 & P2-S11-019: chargeScopedWorkerCost is atomic on overflow', () => {
  const work = new ScopedAnalysisWork({ limits: { workUnits: 100, nodes: 5 } });
  const template = work.cost();
  assert.throws(() => chargeScopedWorkerCost(work, {
    ...template,
    used: {
      workUnits: 50,
      bytesRead: 0,
      residentBytes: 0,
      artifactsMaterialized: 0,
      pagesFetched: 0,
      queueOperations: 0,
      nodes: 10,
      edges: 0,
      results: 0,
      calls: 0,
    },
  }));
  assert.equal(work.cost().used.workUnits ?? 0, 0);
  assert.equal(work.cost().used.nodes ?? 0, 0);
});

test('P1-S03-028 & P2-S03-023: flag-semantics explicit undefined bits, float32 fround, and prototype guard', () => {
  assert.equal(evaluateNZCVCondition('sub', 'eq', 5n, 5n, undefined), true);
  assert.equal(evaluateNZCVCondition('fsub', 'eq', 1.0, 1.0 + 1e-8, 32), true);
  assert.equal(evaluateNZCVCondition('fsub', 'eq', 1.0, 1.0 + 1e-8, 64), false);

  const inv = invertBooleanCondition({ kind: 'compare', op: 'constructor', left: {}, right: {} });
  assert.equal(inv.kind, 'unary');
  assert.equal(inv.op, 'lnot');
});

test('P1-S04-030 & P2-S04-011: phase8 range castFact unsupported width and mergeProvenance prototype safety', () => {
  const f = truncateFact(fullFact(32), 999);
  assert.equal(f.status, 'malformed');
  const joined = joinFacts(
    fullFact(32, { provenance: { toString: ['a'] } }),
    fullFact(32, { provenance: { toString: ['b'] } }),
  );
  assert.equal(joined.bits, 32);
});

test('P1-S09-015 & P2-S09-019: ir-base originOf MK.UNKNOWN and branchConstraints WeakMap non-mutation', () => {
  const unknownLoadVal = { id: 1, def: { op: OP.LOAD, loc: { kind: MK.UNKNOWN, key: 'unk' }, row: 0, address: 0x1000n } };
  assert.equal(originOf(unknownLoadVal)?.kind, 'unknown');

  const frozenIr = Object.freeze({ instructions: Object.freeze([]) });
  assert.deepEqual(branchConstraints(frozenIr), []);
});

test('P1-S01-002 & P1-S01-016: ARM64 AdvSIMD structure load 1D with 3 regs and fp-advsimd-access-trap', () => {
  const insn = {
    id: 'i1',
    address: 0x1000n,
    mnemonic: 'ld1',
    mn: 'ld1',
    ops: [
      {
        k: 'list',
        regs: [
          { k: 'reg', cls: 'vec', num: 0, bits: 128, arr: '1d', text: 'v0.1d' },
          { k: 'reg', cls: 'vec', num: 1, bits: 128, arr: '1d', text: 'v1.1d' },
          { k: 'reg', cls: 'vec', num: 2, bits: 128, arr: '1d', text: 'v2.1d' },
        ],
      },
      { k: 'mem', base: 'x0', disp: 0n },
    ],
  };
  const bundle = liftArm64MachineEffects(insn, { instructionId: 'i1', address: 0x1000n, bytes: new Uint8Array(4) });
  assert.equal(bundle.completeness, 'exact');
  assert.ok(bundle.possibleFaults.some((f) => f.kind === 'fp-advsimd-access-trap'));
});

test('P2-S01-023: riscv64 decodeRiscv64InstructionWord avoids Symbol.species hijack and huge-array allocation', () => {
  let speciesAccessed = false;
  class EvilU8 extends Uint8Array {
    static get [Symbol.species]() { speciesAccessed = true; return Uint8Array; }
  }
  const ev = new EvilU8([0x13, 0x00, 0x00, 0x00]); // addi x0, x0, 0
  const decoded = decodeRiscv64InstructionWord(ev);
  assert.equal(speciesAccessed, false);
  assert.equal(decoded.supported, true);

  const huge = new Array(1_000_000);
  const unsup = decodeRiscv64InstructionWord(huge);
  assert.equal(unsup.supported, false);
});

test('P2-S13-024, P1-S13-040, P1-S13-042: UI primitives prototype/NaN guards and viewer-gesture-guard cleanup', () => {
  assert.equal(reasonText('constructor'), null);
  assert.equal(reasonText('toString'), null);

  const listeners = new Map();
  const vp = {
    addEventListener(type) { listeners.set(type, (listeners.get(type) || 0) + 1); },
    removeEventListener(type) { listeners.set(type, Math.max(0, (listeners.get(type) || 0) - 1)); },
  };
  const viewer = { vp };
  assert.equal(installViewerDragReturnGuard(viewer), true);
  assert.equal(viewer.__dragReturnGuardInstalled, true);
  viewer.__disposeDragReturnGuard();
  assert.equal(viewer.__dragReturnGuardInstalled, undefined);
  assert.equal(installViewerDragReturnGuard(viewer), true);
  assert.equal(listeners.get('pointerdown'), 1);
});

test('P1-S12-018: MemorySSA contract exports cleanly', () => {
  assert.equal(typeof createMemorySsaContract, 'function');
});
