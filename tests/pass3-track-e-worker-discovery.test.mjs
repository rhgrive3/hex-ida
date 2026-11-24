import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { functionCandidates, createDiscoveryArtifact } from '../js/analysis/index.js';
import { buildSemanticModel } from '../js/blocks-base.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bytesOf(words) {
  const bytes = new Uint8Array(words.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i] >>> 0, true);
  return bytes;
}

function loadWorker(files) {
  const context = vm.createContext({
    console, TextDecoder, TextEncoder, Uint8Array, Uint8ClampedArray, Uint16Array,
    Uint32Array, Int32Array, BigUint64Array, BigInt64Array, DataView, ArrayBuffer,
    BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
    String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
    setTimeout, clearTimeout,
  });
  context.self = context;
  context.globalThis = context;
  context.self.postMessage = () => {};
  context.importScripts = () => {};
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return context;
}

function mountCodeRegion(context, words, vmAddr = 0x1000n) {
  context.__bytes = bytesOf(words);
  context.__vmAddr = vmAddr;
  vm.runInContext(`
    blocks.clear();
    fileSize = BigInt(__bytes.length);
    file = {
      size: __bytes.length,
      slice(start, end) {
        const copy = __bytes.slice(Number(start), Number(end));
        return { arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) };
      },
    };
    const __region = {
      id: 'code', kind: 'section', name: '__text', section: '__text',
      fileOffset: 0n, vmAddr: __vmAddr, size: BigInt(__bytes.length),
      exec: true, zerofill: false,
    };
    regions = new Map([['code', __region]]);
    slices = [{ regions: [__region], functionStarts: [] }];
    currentEpoch = 0;
  `, context);
}

const WORKER_LEGACY = ['js/macho.js', 'js/words.js', 'js/worker-budget.js', 'js/address-provenance.js', 'js/worker-legacy.js'];
const WORKER_FIXES = [...WORKER_LEGACY, 'js/worker-fixes.js', 'js/worker-xref-target-identity-fix.js'];
const WORKER_XREF_MEM = [...WORKER_FIXES, 'js/worker-xref-memory-fix.js'];
const WORKER_LOOP_SAFE = [...WORKER_XREF_MEM, 'js/worker-loop-provenance-fix.js'];

// ─────────────────────────────────────────────────────────────────────────────
// P3-S02-001: functionCandidates() + createDiscoveryArtifact() fusion contract
// ─────────────────────────────────────────────────────────────────────────────

test('P3-S02-001: functionCandidates handles truncated producer with emitted evidence without throwing', () => {
  const truncatingProducer = {
    id: 'test.truncating',
    architectureId: 'arm64',
    produce() {
      return {
        evidence: [
          {
            kind: 'debug-symbol',
            authority: 'authoritative',
            start: 0x1000n,
            name: '_foo',
            evidenceIds: ['ev:1'],
          },
        ],
        truncated: true,
        stopReason: 'budget-exhausted',
      };
    },
  };

  const result = functionCandidates({
    input: {},
    architectureId: 'arm64',
    producers: [truncatingProducer],
    snapshotId: 'snap-1',
    binaryId: 'bin-1',
    sourceHash: 'sha256:abc',
  });

  assert.deepEqual(result.candidates, []);
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.deepEqual(result.artifact.functionCandidates, []);
  assert.equal(result.artifact.publication.status, 'withheld');
  assert.equal(result.artifact.evidence.length, 1);
});

test('P3-S02-001: functionCandidates handles aborted signal after producer emits evidence', () => {
  const controller = new AbortController();
  const producerA = {
    id: 'test.a-emits-then-aborts',
    architectureId: 'arm64',
    produce() {
      controller.abort();
      return [
        {
          kind: 'debug-symbol',
          authority: 'authoritative',
          start: 0x2000n,
          name: '_bar',
          evidenceIds: ['ev:a'],
        },
      ];
    },
  };
  const producerB = {
    id: 'test.z-after-abort',
    architectureId: 'arm64',
    produce() {
      return [];
    },
  };

  const result = functionCandidates({
    input: {},
    architectureId: 'arm64',
    producers: [producerA, producerB],
    signal: controller.signal,
    snapshotId: 'snap-abort',
  });

  assert.deepEqual(result.candidates, []);
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'cancelled');
  assert.deepEqual(result.artifact.functionCandidates, []);
});

test('P3-S02-001: functionCandidates handles custom fusion budget overflow (maxCandidates & maxEvidencePerCandidate)', () => {
  const producer = {
    id: 'test.multi',
    architectureId: 'arm64',
    produce() {
      return [
        { kind: 'debug-symbol', authority: 'authoritative', start: 0x1000n, name: '_a', evidenceIds: ['ev:1'] },
        { kind: 'debug-symbol', authority: 'authoritative', start: 0x2000n, name: '_b', evidenceIds: ['ev:2'] },
      ];
    },
  };

  const candOverflow = functionCandidates({
    input: {},
    architectureId: 'arm64',
    producers: [producer],
    snapshotId: 'snap-cand-budget',
    budget: { maxCandidates: 1 },
  });
  assert.deepEqual(candOverflow.candidates, []);
  assert.equal(candOverflow.status.completeness, 'truncated');
  assert.equal(candOverflow.status.stopReason, 'budget-exhausted');
  assert.deepEqual(candOverflow.artifact.functionCandidates, []);

  const dupProducer = {
    id: 'test.dup',
    architectureId: 'arm64',
    produce() {
      return [
        { kind: 'debug-symbol', authority: 'authoritative', start: 0x1000n, name: '_a', evidenceIds: ['ev:1'] },
        { kind: 'prologue-candidate', authority: 'corroborating', start: 0x1000n, evidenceIds: ['ev:2'] },
      ];
    },
  };
  const evOverflow = functionCandidates({
    input: {},
    architectureId: 'arm64',
    producers: [dupProducer],
    snapshotId: 'snap-ev-budget',
    budget: { maxEvidencePerCandidate: 1 },
  });
  assert.equal(evOverflow.status.completeness, 'truncated');
  assert.equal(evOverflow.status.stopReason, 'budget-exhausted');
  assert.equal(evOverflow.artifact.functionCandidates.length, 1);
  assert.ok(evOverflow.artifact.collisionSets.some((c) => c.kind === 'evidence-budget'));
});

test('P3-S02-001: createDiscoveryArtifact validates fusionBudget and producerStatus fail-closed', () => {
  const baseStatus = {
    completeness: 'complete',
    stopReason: null,
    snapshotId: 'snap-validate',
    analyzerId: 'phase7.discovery.fusion',
    analyzerVersion: '1.0.0',
  };

  // Contradictory producerStatus.truncated=true with status.completeness='complete' must fail
  assert.throws(() => createDiscoveryArtifact({
    evidence: [],
    candidates: [],
    status: baseStatus,
    producerStatus: { truncated: true, stopReason: 'budget-exhausted' },
  }), /discovery-artifact-producer-status-mismatch/);

  // Malformed producerStatus
  assert.throws(() => createDiscoveryArtifact({
    evidence: [],
    candidates: [],
    status: baseStatus,
    producerStatus: { truncated: 'yes', stopReason: null },
  }), /discovery-artifact-producer-status-invalid/);

  assert.throws(() => createDiscoveryArtifact({
    evidence: [],
    candidates: [],
    status: baseStatus,
    producerStatus: { truncated: true, stopReason: 'not-a-reason' },
  }), /discovery-artifact-producer-status-invalid/);

  // Malformed fusionBudget
  assert.throws(() => createDiscoveryArtifact({
    evidence: [],
    candidates: [],
    status: baseStatus,
    fusionBudget: { maxCandidates: 0 },
  }), /discovery-artifact-fusion-budget-maxCandidates-invalid/);

  // Backward compatibility when fusionBudget and producerStatus are omitted
  const ok = createDiscoveryArtifact({
    evidence: [],
    candidates: [],
    status: baseStatus,
  });
  assert.equal(ok.functionCandidates.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// P3-S03-003: finishBlock() records upward-exposed reads on self-updating insns
// ─────────────────────────────────────────────────────────────────────────────

test('P3-S03-003: finishBlock preserves upward-exposed input registers on self-updating head instructions', () => {
  const model1 = buildSemanticModel([
    { row: 0, address: 0x1000n, mn: 'ldr', ops: 'x0, [x0, #0x18]' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' },
  ]);
  const ldrBlock = model1.semantic.find((b) => b.instructions.some((i) => i.mnemonic === 'ldr'));
  assert.ok(ldrBlock, 'expected semantic block containing ldr');
  assert.ok(ldrBlock.inputs.some((i) => i.reg === 'x0'), `expected x0 in inputs, got ${JSON.stringify(ldrBlock.inputs)}`);

  const model2 = buildSemanticModel([
    { row: 0, address: 0x1000n, mn: 'add', ops: 'x0, x0, #1' },
    { row: 1, address: 0x1004n, mn: 'ret', ops: '' },
  ]);
  const addBlock = model2.semantic.find((b) => b.instructions.some((i) => i.mnemonic === 'add'));
  assert.ok(addBlock, 'expected semantic block containing add');
  assert.ok(addBlock.inputs.some((i) => i.reg === 'x0'), `expected x0 in inputs, got ${JSON.stringify(addBlock.inputs)}`);

  // When an earlier instruction in the same block defines x0, x0 is NOT an upward-exposed input
  const model3 = buildSemanticModel([
    { row: 0, address: 0x1000n, mn: 'mov', ops: 'x0, #0' },
    { row: 1, address: 0x1004n, mn: 'add', ops: 'x0, x0, #1' },
    { row: 2, address: 0x1008n, mn: 'ret', ops: '' },
  ]);
  const calcBlock = model3.semantic.find((b) => b.instructions.some((i) => i.mnemonic === 'mov') && b.instructions.some((i) => i.mnemonic === 'add'));
  if (calcBlock) {
    assert.ok(!calcBlock.inputs.some((i) => i.reg === 'x0'), `x0 written before read in same block should not be in inputs: ${JSON.stringify(calcBlock.inputs)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P3-S10-001: findFieldAccess handles ARM64 LDP/STP pairs & post-index pairs
// ─────────────────────────────────────────────────────────────────────────────

test('P3-S10-001: findFieldAccess finds both slots of LDP/STP and handles post-index and per-slot cap', async () => {
  // ldr w8, [x0, #0x20]         => 0xb9402008
  const LDR_W8_X0_20 = 0xb9402008;
  // ldp w8, w9, [x0, #0x20]     => opc=00, 101, V=0, 010, L=1, imm7=8, Rt2=9, Rn=0, Rt=8
  const LDP_W8_W9_X0_20 = (0x29400000 | (8 << 15) | (9 << 10) | (0 << 5) | 8) >>> 0;
  // stp x8, x9, [x0, #0x40]     => opc=10, 101, V=0, 010, L=0, imm7=8, Rt2=9, Rn=0, Rt=8
  const STP_X8_X9_X0_40 = (0xa9000000 | (8 << 15) | (9 << 10) | (0 << 5) | 8) >>> 0;
  // ldp w8, w9, [x0], #0x10     => opc=00, 101, V=0, 001 (post), L=1, imm7=4, Rt2=9, Rn=0, Rt=8
  const LDP_W8_W9_X0_POST_10 = (0x28c00000 | (4 << 15) | (9 << 10) | (0 << 5) | 8) >>> 0;

  const ctx = loadWorker(WORKER_LOOP_SAFE);
  mountCodeRegion(ctx, [LDR_W8_X0_20, LDP_W8_W9_X0_20, STP_X8_X9_X0_40, LDP_W8_W9_X0_POST_10]);

  // 1. Both slots of 32-bit LDP found with size 4; second slot works even when first slot is not queried
  const onlySecond = await vm.runInContext(
    `findFieldAccess({ regionId:'code', offset:0x24n, size:4, limit:10, requestId:null, epoch:0 })`,
    ctx,
  );
  assert.equal(onlySecond.results.length, 1);
  assert.equal(onlySecond.results[0].addr, 0x1004n);
  assert.equal(onlySecond.results[0].size, 4);
  assert.equal(onlySecond.results[0].kind, 'load');

  // 2. Both slots of 64-bit STP found with size 8
  const stpBoth = await vm.runInContext(
    `findFieldAccess({ regionId:'code', offsets:[{ offset:0x40n, size:8 }, { offset:0x48n, size:8 }], limit:10, requestId:null, epoch:0 })`,
    ctx,
  );
  assert.equal(stpBoth.groups['64'].length, 1);
  assert.equal(stpBoth.groups['72'].length, 1);
  assert.equal(stpBoth.groups['64'][0].addr, 0x1008n);
  assert.equal(stpBoth.groups['72'][0].addr, 0x1008n);
  assert.equal(stpBoth.groups['72'][0].kind, 'store');
  assert.equal(stpBoth.groups['72'][0].size, 8);

  // 3. Per-slot cap: slot 0x20 hits cap=1 on row 0 (LDR), slot 0x24 must still be recorded on row 1 (LDP)
  const cappedFirst = await vm.runInContext(
    `findFieldAccess({ regionId:'code', offsets:[{ offset:0x20n, size:4 }, { offset:0x24n, size:4 }], limit:1, requestId:null, epoch:0 })`,
    ctx,
  );
  assert.equal(cappedFirst.groups['32'].length, 1);
  assert.equal(cappedFirst.groups['32'][0].addr, 0x1000n);
  assert.equal(cappedFirst.groups['36'].length, 1);
  assert.equal(cappedFirst.groups['36'][0].addr, 0x1004n);

  // 4. Post-index LDP [x0], #0x10 accesses offsets 0 and 4, NOT 0x10
  const postIdx = await vm.runInContext(
    `findFieldAccess({ regionId:'code', offsets:[{ offset:0n, size:4 }, { offset:4n, size:4 }, { offset:0x10n, size:4 }], limit:10, requestId:null, epoch:0 })`,
    ctx,
  );
  assert.equal(postIdx.groups['0'].length, 1);
  assert.equal(postIdx.groups['0'][0].addr, 0x100cn);
  assert.equal(postIdx.groups['4'].length, 1);
  assert.equal(postIdx.groups['4'][0].addr, 0x100cn);
  assert.equal(postIdx.groups['16'].length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// P3-S10-002: findXrefs invalidates ADRP provenance on LDP reg2, pre/post base, STXR statusReg
// ─────────────────────────────────────────────────────────────────────────────

test('P3-S10-002: findXrefs invalidates provenance on LDP reg2, pre/post writeback base, and STXR statusReg', async () => {
  const ADRP_X2 = 0x90000002;           // adrp x2, #0x1000
  const ADRP_X8 = 0x90000008;           // adrp x8, #0x1000
  const LDP_X1_X2_X19_0 = 0xa9400a61;   // ldp x1, x2, [x19, #0]
  const ADD_X0_X2_100 = 0x91040040;     // add x0, x2, #0x100
  const LDR_X1_X8_POST_8 = 0xf8408501;  // ldr x1, [x8], #8
  const STR_X1_X8_PRE_8 = 0xf8008d01;   // str x1, [x8, #8]!
  const STXR_W8_X1_X2 = 0xc8087c41;     // stxr w8, x1, [x2]
  const ADD_X0_X8_100 = 0x91040100;     // add x0, x8, #0x100

  const cases = [
    ['LDP second dest reg2', [ADRP_X2, LDP_X1_X2_X19_0, ADD_X0_X2_100]],
    ['post-index writeback base', [ADRP_X8, LDR_X1_X8_POST_8, ADD_X0_X8_100]],
    ['pre-index writeback base', [ADRP_X8, STR_X1_X8_PRE_8, ADD_X0_X8_100]],
    ['STXR exclusive store statusReg', [ADRP_X8, STXR_W8_X1_X2, ADD_X0_X8_100]],
  ];

  for (const [stackName, files] of [['findXrefsCanonicalMemory', WORKER_XREF_MEM], ['findXrefsLoopSafe', WORKER_LOOP_SAFE]]) {
    for (const [label, words] of cases) {
      const ctx = loadWorker(files);
      mountCodeRegion(ctx, words, 0x1000n);
      const res = await vm.runInContext(
        `findXrefs({ regionId:'code', target:0x1100n, limit:100, requestId:null, epoch:0 })`,
        ctx,
      );
      assert.equal(res.results.length, 0, `${stackName} (${label}): expected 0 stale xrefs, got ${JSON.stringify(res.results)}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P3-S10-003: findXrefs classifies PC-relative literal loads as 'load', not 'branch'
// ─────────────────────────────────────────────────────────────────────────────

test('P3-S10-003: findXrefs classifies literal-pool loads as load and branches as branch across all implementations', async () => {
  // 0x1000: ldr x0, 0x1010 (+4 words) => 0x58000080
  // 0x1004: ldr d0, 0x1010 (+3 words) => 0x5c000060
  // 0x1008: b 0x1010       (+2 words) => 0x14000002
  // 0x100c: nop                       => 0xd503201f
  // 0x1010: literal data              => 0x12345678
  const words = [0x58000080, 0x5c000060, 0x14000002, 0xd503201f, 0x12345678];

  for (const [stackName, files] of [
    ['worker-legacy', WORKER_LEGACY],
    ['worker-fixes', WORKER_FIXES],
    ['worker-xref-memory-fix', WORKER_XREF_MEM],
    ['worker-loop-provenance-fix', WORKER_LOOP_SAFE],
  ]) {
    const ctx = loadWorker(files);
    mountCodeRegion(ctx, words, 0x1000n);
    const res = await vm.runInContext(
      `findXrefs({ regionId:'code', target:0x1010n, limit:100, requestId:null, epoch:0 })`,
      ctx,
    );
    assert.equal(res.results.length, 3, `${stackName}: expected 3 xrefs`);
    const byAddr = new Map(res.results.map((r) => [r.addr, r.kind]));
    assert.equal(byAddr.get(0x1000n), 'load', `${stackName}: ldr x0 literal must be load`);
    assert.equal(byAddr.get(0x1004n), 'load', `${stackName}: ldr d0 literal must be load`);
    assert.equal(byAddr.get(0x1008n), 'branch', `${stackName}: b target must remain branch`);
  }
});
