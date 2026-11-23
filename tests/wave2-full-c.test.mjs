import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GNU_PROPERTY_AARCH64_FEATURE_1_AND,
  GNU_PROPERTY_AARCH64_FEATURE_1_BTI,
  GNU_PROPERTY_AARCH64_FEATURE_1_PAC,
  NT_GNU_PROPERTY_TYPE_0,
  PT_GNU_PROPERTY,
  parseAarch64GnuProperty,
} from '../js/binary/elf-gnu-property.js';
import {
  decorateArm64GcsEffects,
  liftArm64ControlEffects,
} from '../js/targets/architecture/arm64/effects/control.js';
import { acquireDistributedQuota } from '../js/ai/provider/worker-transport.js';
import { ProposalStore } from '../js/ai/proposals.js';
import { AIError } from '../js/ai/schema.js';
import {
  AnalysisWorkStopped,
  ScopedAnalysisWork,
} from '../js/core/budgets/scoped-work.js';
import { serializeScopedWorkerStop } from '../js/core/budgets/scoped-worker.js';
import { ResourceBudget } from '../js/core/budgets/index.js';

function u16(dv, off, val) { dv.setUint16(off, val, true); }
function u32(dv, off, val) { dv.setUint32(off, val >>> 0, true); }
function u64(dv, off, val) { dv.setBigUint64(off, BigInt(val), true); }

function writeElf64Header(bytes, dv, {
  type = 2,
  machine = 183,
  entry = 0n,
  phoff = 64n,
  phentsize = 56,
  phnum = 1,
} = {}) {
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  u16(dv, 16, type);
  u16(dv, 18, machine);
  u32(dv, 20, 1);
  u64(dv, 24, entry);
  u64(dv, 32, phoff);
  u64(dv, 40, 0n);
  u32(dv, 48, 0);
  u16(dv, 52, 64);
  u16(dv, 54, phentsize);
  u16(dv, 56, phnum);
  u16(dv, 58, 64);
  u16(dv, 60, 0);
  u16(dv, 62, 0);
}

function writePhdr64(dv, off, {
  type = 1,
  flags = 4,
  offset = 0n,
  vaddr = 0n,
  paddr = 0n,
  filesz = 0n,
  memsz = 0n,
  align = 8n,
} = {}) {
  u32(dv, off + 0, type);
  u32(dv, off + 4, flags);
  u64(dv, off + 8, offset);
  u64(dv, off + 16, vaddr);
  u64(dv, off + 24, paddr);
  u64(dv, off + 32, filesz);
  u64(dv, off + 40, memsz);
  u64(dv, off + 48, align);
}

/* ── 1. [P2] elf-gnu-property.js: relative 8-byte alignment when p_offset is not 8-byte aligned ── */
test('1. [P2] parseAarch64GnuProperty aligns ELF64 properties relative to propertyCursor when p_offset is 4-mod-8', () => {
  // Header (64) + 1 Phdr (56) = 120 (0x78), then 4 bytes padding -> 0x7c (4 mod 8).
  const noteOffset = 0x7c;
  // Note header: 12 bytes + 4 bytes ("GNU\0") = 16 bytes -> descStart = noteOffset + 16 (still 4 mod 8)
  // Property 1: type=1, dataSize=4, payload=0x11223344, padded to 8B relative -> 16 bytes
  // Property 2: type=GNU_PROPERTY_AARCH64_FEATURE_1_AND, dataSize=4, payload=BTI|PAC, padded to 8B relative -> 16 bytes
  const descsz = 32;
  const noteSize = 16 + descsz;
  const bytes = new Uint8Array(noteOffset + noteSize);
  const dv = new DataView(bytes.buffer);

  writeElf64Header(bytes, dv, { machine: 183, phoff: 64n, phnum: 1 });
  writePhdr64(dv, 64, {
    type: PT_GNU_PROPERTY,
    offset: BigInt(noteOffset),
    vaddr: BigInt(noteOffset),
    paddr: BigInt(noteOffset),
    filesz: BigInt(noteSize),
    memsz: BigInt(noteSize),
    align: 8n,
  });

  // Note header
  u32(dv, noteOffset + 0, 4); // namesz
  u32(dv, noteOffset + 4, descsz); // descsz
  u32(dv, noteOffset + 8, NT_GNU_PROPERTY_TYPE_0);
  bytes.set([0x47, 0x4e, 0x55, 0x00], noteOffset + 12); // "GNU\0"

  const prop1 = noteOffset + 16;
  u32(dv, prop1 + 0, 0x1); // non-aarch64 property
  u32(dv, prop1 + 4, 4); // dataSize
  u32(dv, prop1 + 8, 0x11223344);
  u32(dv, prop1 + 12, 0); // 4-byte relative alignment padding

  const prop2 = prop1 + 16;
  u32(dv, prop2 + 0, GNU_PROPERTY_AARCH64_FEATURE_1_AND);
  u32(dv, prop2 + 4, 4);
  u32(dv, prop2 + 8, GNU_PROPERTY_AARCH64_FEATURE_1_BTI | GNU_PROPERTY_AARCH64_FEATURE_1_PAC);
  u32(dv, prop2 + 12, 0);

  const parsed = parseAarch64GnuProperty(bytes, {
    bits: 64,
    littleEndian: true,
    machine: 183,
    programHeaders: [{
      type: PT_GNU_PROPERTY,
      offset: BigInt(noteOffset),
      filesz: BigInt(noteSize),
      align: 8n,
    }],
  });

  assert.equal(parsed.loaderPolicy, 'bti-requested');
  assert.equal(parsed.btiRequested, true);
  assert.equal(parsed.pacRequested, true);
  assert.equal(parsed.featureBits, GNU_PROPERTY_AARCH64_FEATURE_1_BTI | GNU_PROPERTY_AARCH64_FEATURE_1_PAC);
  assert.equal(parsed.evidence.length, 1);
  assert.equal(parsed.evidence[0].fileOffset, prop2);
});

/* ── 2. [P2] arm64/effects/control.js: unknownEffects.categories includes registers & faults when address is null ── */
test('2. [P2] decorateArm64GcsEffects reports memory, registers, and faults in unknownEffects when instruction.address is null', () => {
  const baseBundle = liftArm64ControlEffects({
    instructionId: 'arm64:bl:no-addr',
    id: 'arm64:bl:no-addr',
    mnemonic: 'bl',
    address: null,
    ops: [{ k: 'imm', value: 0x1000n }],
    callTarget: 0x1000n,
  }, { instructionId: 'arm64:bl:no-addr' });

  const result = decorateArm64GcsEffects(
    { mnemonic: 'bl', address: null },
    { gcsEnabled: true },
    baseBundle,
  );

  assert.equal(result.completeness, 'partial');
  assert.equal(result.unknownEffects?.reason, 'arm64-gcs-link-address-unavailable');
  assert.ok(result.unknownEffects?.categories.includes('memory'));
  assert.ok(result.unknownEffects?.categories.includes('registers'));
  assert.ok(result.unknownEffects?.categories.includes('faults'));
});

/* ── 3. [P2] worker-transport.js: synchronous throw in stub.acquire() cleans up abort listener and avoids UnhandledRejection ── */
test('3. [P2] acquireDistributedQuota removes abort listener and prevents unhandledRejection when stub.acquire throws synchronously', async () => {
  const controller = new AbortController();
  const realSignal = controller.signal;
  let added = 0;
  let removed = 0;
  const wrappedSignal = {
    get aborted() { return realSignal.aborted; },
    get reason() { return realSignal.reason; },
    addEventListener(type, fn, opts) {
      if (type === 'abort') added += 1;
      return realSignal.addEventListener(type, fn, opts);
    },
    removeEventListener(type, fn, opts) {
      if (type === 'abort') removed += 1;
      return realSignal.removeEventListener(type, fn, opts);
    },
  };

  let unhandled = null;
  const onUnhandled = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const req = {
      headers: new Headers({ 'cf-connecting-ip': '127.0.0.1' }),
      signal: wrappedSignal,
    };
    const env = {
      AI_QUOTA: {
        getByName() {
          return {
            acquire() { throw new Error('sync-acquire-boom'); },
            release() {},
          };
        },
      },
    };

    const res = await acquireDistributedQuota(req, env, 'sess-sync-throw');
    assert.equal(res.lease, null);
    assert.equal(res.response.status, 503);
    assert.equal(added, 1);
    assert.equal(removed, 1, 'abort listener must be removed in finally on sync throw');

    // Aborting afterwards must not cause an unhandledRejection on the orphaned disconnect promise.
    controller.abort(new Error('late-abort'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled, null, 'must not emit unhandledRejection after late abort');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

/* ── 4. [P2] proposals.js: admitBoundedProposalState enforces O(1) Map/Set size check & per-element spendNode ── */
test('4. [P2] admitBoundedProposalState rejects oversized Map and Set in O(1) and charges per element', () => {
  const store = new ProposalStore({ evidenceStore: { has: () => true } });

  const giantSet = new Set();
  for (let i = 0; i < 250_001; i += 1) giantSet.add(i);
  const t0 = Date.now();
  assert.throws(
    () => store.create({
      kind: 'comment',
      target: { address: '0x1000' },
      before: giantSet,
      after: 'c',
      evidenceIds: ['ev_1'],
    }),
    (err) => err instanceof AIError && err.type === 'tool_failed' && /budget/i.test(err.message),
  );
  assert.ok(Date.now() - t0 < 200, 'Set rejection must be fast');

  const giantMap = new Map();
  for (let i = 0; i < 250_001; i += 1) giantMap.set(i, i);
  const t1 = Date.now();
  assert.throws(
    () => store.create({
      kind: 'comment',
      target: { address: '0x1000' },
      before: giantMap,
      after: 'c',
      evidenceIds: ['ev_1'],
    }),
    (err) => err instanceof AIError && err.type === 'tool_failed' && /budget/i.test(err.message),
  );
  assert.ok(Date.now() - t1 < 200, 'Map rejection must be fast');

  // Verify per-element spendNode: 150,000 in before + 150,000 in after > 250,000 total nodes.
  const halfSetA = new Set();
  const halfSetB = new Set();
  for (let i = 0; i < 150_000; i += 1) {
    halfSetA.add(i);
    halfSetB.add(i);
  }
  assert.throws(
    () => store.create({
      kind: 'comment',
      target: { address: '0x1000' },
      before: halfSetA,
      after: halfSetB,
      evidenceIds: ['ev_1'],
    }),
    (err) => err instanceof AIError && err.type === 'tool_failed' && /budget/i.test(err.message),
  );
});

/* ── 5. [P1] scoped-work.js: AnalysisWorkStopped always carries cost so serializeScopedWorkerStop never crashes ── */
test('5. [P1] ScopedAnalysisWork attaches cost on timeout, cancel, pre-aborted signal, parent cancel, and dispose', async () => {
  const binding = { kind: 'projection', worldId: 'w1', snapshotId: 's1', binaryId: 'b1' };

  // 5a. Timeout
  const workTimeout = new ScopedAnalysisWork({ limits: { deadlineMs: 10 }, name: 't-timeout' });
  await assert.rejects(
    () => workTimeout.await(() => new Promise(() => {})),
    (err) => {
      assert.ok(err instanceof AnalysisWorkStopped);
      assert.equal(err.status, 'timeout');
      assert.ok(err.cost, 'timeout AnalysisWorkStopped must have cost');
      const serialized = serializeScopedWorkerStop(err, binding);
      assert.equal(serialized.schema, 'scoped-worker-stop/v1');
      assert.equal(serialized.status, 'timeout');
      return true;
    },
  );
  workTimeout.dispose();

  // 5b. Pre-aborted external signal (default reason)
  const acPre = new AbortController();
  acPre.abort();
  const workPre = new ScopedAnalysisWork({ signal: acPre.signal, name: 't-preabort' });
  assert.throws(
    () => workPre.checkpoint(),
    (err) => {
      assert.ok(err instanceof AnalysisWorkStopped);
      assert.equal(err.status, 'cancelled');
      assert.ok(err.cost, 'pre-aborted AnalysisWorkStopped must have cost');
      const serialized = serializeScopedWorkerStop(err, binding);
      assert.equal(serialized.status, 'cancelled');
      return true;
    },
  );
  workPre.dispose();

  // 5c. External signal aborted with cost-less AnalysisWorkStopped
  const acCostless = new AbortController();
  acCostless.abort(new AnalysisWorkStopped('cancelled', 'external-no-cost'));
  const workCostless = new ScopedAnalysisWork({ signal: acCostless.signal, name: 't-costless' });
  assert.throws(
    () => workCostless.checkpoint(),
    (err) => {
      assert.ok(err instanceof AnalysisWorkStopped);
      assert.ok(err.cost, 'costless external AnalysisWorkStopped must be populated with cost');
      const serialized = serializeScopedWorkerStop(err, binding);
      assert.equal(serialized.status, 'cancelled');
      return true;
    },
  );
  workCostless.dispose();

  // 5d. Parent budget cancelled
  const parentController = new AbortController();
  const parentBudget = new ResourceBudget({ workUnits: 100 }, { name: 'parent', signal: parentController.signal });
  const workParent = new ScopedAnalysisWork({ parentBudget, name: 't-parent' });
  parentController.abort();
  assert.throws(
    () => workParent.checkpoint(),
    (err) => {
      assert.ok(err instanceof AnalysisWorkStopped);
      assert.equal(err.status, 'cancelled');
      assert.ok(err.cost, 'parent-cancelled AnalysisWorkStopped must have cost');
      const serialized = serializeScopedWorkerStop(err, binding);
      assert.equal(serialized.status, 'cancelled');
      return true;
    },
  );
  workParent.dispose();

  // 5e. dispose() attaches cost to signal.reason
  const workDispose = new ScopedAnalysisWork({ limits: { deadlineMs: 5000 }, name: 't-dispose' });
  workDispose.dispose();
  assert.ok(workDispose.signal.reason instanceof AnalysisWorkStopped);
  assert.ok(workDispose.signal.reason.cost, 'dispose() AnalysisWorkStopped must have cost');
  const serializedDispose = serializeScopedWorkerStop(workDispose.signal.reason, binding);
  assert.equal(serializedDispose.status, 'cancelled');
});

/* ── 6. [P2] arm64/effects/control.js: preserve existing unknownEffects.categories union when address is null ── */
test('6. [P2] decorateArm64GcsEffects preserves existing unknownEffects.categories union when instruction.address is null', () => {
  // Unresolved BL target already produces unknownEffects.categories containing 'control'
  const unresolvedBl = liftArm64ControlEffects({
    instructionId: 'arm64:bl:unresolved-no-addr',
    id: 'arm64:bl:unresolved-no-addr',
    mnemonic: 'bl',
    address: null,
    ops: [],
  }, { instructionId: 'arm64:bl:unresolved-no-addr' });
  assert.ok(unresolvedBl.unknownEffects?.categories.includes('control'));

  const decorated = decorateArm64GcsEffects(
    { mnemonic: 'bl', address: null },
    { gcsEnabled: true },
    unresolvedBl,
  );
  assert.equal(decorated.completeness, 'partial');
  assert.equal(decorated.unknownEffects?.reason, 'arm64-gcs-link-address-unavailable');
  assert.deepEqual(
    decorated.unknownEffects?.categories,
    ['control', 'faults', 'memory', 'registers'],
  );

  // Deduplicates and sorts when existing categories overlap with GCS categories
  const customPartial = {
    ...unresolvedBl,
    unknownEffects: { categories: ['registers', 'flags', 'control', 'faults'], reason: 'prior-partial' },
  };
  const decoratedCustom = decorateArm64GcsEffects(
    { mnemonic: 'blr', address: null },
    { gcsEnabled: true },
    customPartial,
  );
  assert.deepEqual(
    decoratedCustom.unknownEffects?.categories,
    ['control', 'faults', 'flags', 'memory', 'registers'],
  );
});

/* ── 7. [P2] proposals.js: symmetric O(1) Map node budget across create() and restorePersistedPending() ── */
test('7. [P2] proposals.js enforces symmetric O(1) Map node budget between create() and restorePersistedPending()', () => {
  const evidenceStore = { has: () => true };
  const store = new ProposalStore({ evidenceStore });

  // Exact upper boundary: target ({ address: '0x1000' } = 2) + Map(124_998) (1 + 249_996) + after ('c' = 1) = 250_000
  const maxAdmittedMap = new Map();
  for (let i = 0; i < 124_998; i += 1) maxAdmittedMap.set(i, i);
  const created = store.create({
    kind: 'comment',
    target: { address: '0x1000' },
    before: maxAdmittedMap,
    after: 'c',
    evidenceIds: ['ev_1'],
  });
  const persisted = store.persistedActions();
  const restored = new ProposalStore({ evidenceStore }).restorePersistedPending(persisted);
  assert.equal(restored.has(created.id), true, 'Map admitted by create() must restore cleanly');
  assert.equal(restored.executionView(created.id).before.size, 124_998);

  // 124,999 entries exceeds 250,000 node budget and must be rejected in O(1) by create()
  const overLimitMap = new Map(maxAdmittedMap);
  overLimitMap.set(124_998, 124_998);
  const tCreate = Date.now();
  assert.throws(
    () => store.create({
      kind: 'comment',
      target: { address: '0x1000' },
      before: overLimitMap,
      after: 'c',
      evidenceIds: ['ev_1'],
    }),
    (err) => err instanceof AIError && err.type === 'tool_failed' && /budget/i.test(err.message),
  );
  assert.ok(Date.now() - tCreate < 200, 'create() must reject over-budget Map in O(1)');

  // Crafted persisted payload with 150,000 Map entries (previously bypassed O(1) pre-check) must be rejected in O(1)
  const smallStore = new ProposalStore({ evidenceStore });
  const baseCreated = smallStore.create({
    kind: 'comment',
    target: { address: '0x1000' },
    before: new Map([[0, 0]]),
    after: 'c',
    evidenceIds: ['ev_1'],
  });
  const [template] = smallStore.persistedActions();
  const oversizedEntries = Array.from({ length: 150_000 }, (_, i) => [['number', i], ['number', i]]);
  const craftedPayload = JSON.stringify({
    version: 1,
    target: ['object', 0, 1, [['address', ['string', '0x1000']]]],
    before: ['map', 0, oversizedEntries],
    after: ['string', 'c'],
  });
  const crafted = {
    ...template,
    id: `${baseCreated.id}_oversized`,
    executionPayload: craftedPayload,
  };

  const tRestore = Date.now();
  const restoredReject = new ProposalStore({ evidenceStore }).restorePersistedPending([crafted]);
  assert.ok(Date.now() - tRestore < 500, 'restorePersistedPending() must reject over-budget Map in O(1)');
  assert.equal(restoredReject.has(crafted.id), false);
});

test('8. [P1] decorateArm64GcsEffects uses canonical instructionAddress and fails closed on invalid non-null addresses', () => {
  for (const badAddr of ['not-an-addr', Number.NaN, 1.5, '', false]) {
    const base = liftArm64ControlEffects(
      { instructionId: 'arm64:bad-addr', mnemonic: 'blr', ops: [], address: badAddr },
      { instructionId: 'arm64:bad-addr' },
    );
    const bundle = decorateArm64GcsEffects(
      { mnemonic: 'blr', address: badAddr },
      { gcsEnabled: true },
      base,
    );
    assert.equal(bundle.completeness, 'partial');
    assert.equal(bundle.unknownEffects?.reason, 'arm64-gcs-link-address-unavailable');
    assert.equal(bundle.operations.some((op) => op.kind === 'memory-write'), false);
    assert.ok(bundle.unknownEffects?.categories.includes('control'));
    assert.ok(bundle.unknownEffects?.categories.includes('memory'));
  }
});
