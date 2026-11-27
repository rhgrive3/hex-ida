// Track 7 Comprehensive Verification Suite (hex-ida v6: §4, §7, §9, §15 & INV-005).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OBS_BASE_KIND,
  OBS_TYPE_HINT,
  OBS_FLAGS,
  recoverStructLayout,
  buildStructMemberXrefIndex,
  StructRecoveryEngine,
} from '../js/analysis/types/core/struct-recovery.js';
import {
  projectTypedOverlay,
  PostEmitOverlayEngine,
  requiresStructuralReDecompile,
} from '../js/analysis/types/core/post-emit-overlay.js';
import { DirtyConeIndex, calculateDirtyCone } from '../js/analysis/types/core/dirty-cone.js';
import {
  deepClone,
  TypeTransactionManager,
} from '../js/analysis/types/core/type-transaction.js';
import {
  TYPE_CONFIDENCE,
  AUTHORITY_LEVEL,
  canPromoteType,
  resolveCanonicalTypeSize,
  promoteTypeEntry,
  promoteStructMemberSafe,
  SafeTypePromoter,
} from '../js/analysis/types/core/safe-type-promote.js';
import { GlobalTypeMap } from '../js/analysis/types/core/global-type-map.js';
import {
  MANUAL_SEG_KIND,
  MANUAL_SEG_PERM,
  MANUAL_SEG_FLAGS,
  MANUAL_SEG_NO_FILE,
  MANUAL_SEG_ENTRY_BYTES,
  MANUAL_SEGMENT_BYTES,
  ManualSegmentMap,
} from '../js/analysis/recovery/manual-segment-map.js';
import {
  FUNC_CHUNK_KIND,
  CHUNK_FLAGS,
  FUNC_CHUNK_RANGE_BYTES,
  FUNC_CHUNK_BYTES,
  FuncChunkTable,
} from '../js/analysis/recovery/func-chunk-table.js';
import {
  ABI_LOC_KIND,
  ABI_FLAGS,
  CUSTOM_ABI_SPEC_BYTES,
  CUSTOM_ABI_PIN_MASK,
  computeRetCount,
  parseUsercallSignature,
  validateCustomAbiSpec,
  exportCustomAbiWasm192,
  CustomAbiStore,
} from '../js/analysis/recovery/custom-abi-spec.js';
import {
  STACK_SLOT_FLAGS,
  STACK_SLOT_OVERRIDE_BYTES,
  StackSlotOverrideRegistry,
} from '../js/analysis/recovery/stack-slot-override.js';
import {
  SHIFTED_PTR_FLAGS,
  SHIFTED_PTR_SPEC_BYTES,
  fnv1a32,
  parseShiftedTypeAnnotation,
  ShiftedPtrRegistry,
} from '../js/analysis/recovery/shifted-ptr-spec.js';
import {
  ARM64_GP_ARG_REGS,
  ARM64_FP_ARG_REGS,
  ARM64_SP_REG,
  createArm64RecoveryAdapter,
} from '../js/targets/architecture/arm64/recovery-adapter.js';
import {
  toVaKey,
  evaluateJevNamingGates,
  JevQueryOverlay,
} from '../js/analysis/query/jev-overlay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. struct-recovery.js
// ---------------------------------------------------------------------------
test('struct-recovery: offset coalescing, padding, signedness voting, bitfields, union grouping & xref index', () => {
  const obs = [
    { funcVa: 0x1000n, insnVa: 0x1008n, structSeedId: 1, offset: 0, accessWidth: 8, typeHint: OBS_TYPE_HINT.PTR, obsFlags: OBS_FLAGS.ACCESS_READ },
    { funcVa: 0x2000n, insnVa: 0x2004n, structSeedId: 1, offset: 0, accessWidth: 8, typeHint: OBS_TYPE_HINT.PTR, obsFlags: OBS_FLAGS.ACCESS_READ },
    { funcVa: 0x1000n, insnVa: 0x1010n, structSeedId: 1, offset: 8, accessWidth: 4, typeHint: OBS_TYPE_HINT.INT, obsFlags: OBS_FLAGS.SIGNED_EV },
    { funcVa: 0x2000n, insnVa: 0x2010n, structSeedId: 1, offset: 8, accessWidth: 4, typeHint: OBS_TYPE_HINT.INT, obsFlags: OBS_FLAGS.SIGNED_EV },
    { funcVa: 0x3000n, insnVa: 0x3010n, structSeedId: 1, offset: 8, accessWidth: 4, typeHint: OBS_TYPE_HINT.UINT, obsFlags: OBS_FLAGS.UNSIGNED_EV },
    { funcVa: 0x1000n, insnVa: 0x1020n, structSeedId: 1, offset: 16, accessWidth: 4, typeHint: OBS_TYPE_HINT.UINT, obsFlags: OBS_FLAGS.HAS_BITFIELD, bfLsb: 0, bfWidth: 4, nameHint: 'flags' },
    { funcVa: 0x1000n, insnVa: 0x1024n, structSeedId: 1, offset: 16, accessWidth: 4, typeHint: OBS_TYPE_HINT.INT, obsFlags: OBS_FLAGS.HAS_BITFIELD | OBS_FLAGS.SIGNED_EV, bfLsb: 4, bfWidth: 8, nameHint: 'mode' },
    { funcVa: 0x1000n, insnVa: 0x1030n, structSeedId: 1, offset: 24, accessWidth: 4, typeHint: OBS_TYPE_HINT.FLOAT },
    { funcVa: 0x2000n, insnVa: 0x2030n, structSeedId: 1, offset: 24, accessWidth: 4, typeHint: OBS_TYPE_HINT.INT },
    { funcVa: 0x1000n, insnVa: 0x1040n, structSeedId: 1, offset: 32, accessWidth: 8, baseKind: OBS_BASE_KIND.STACK_SLOT, typeHint: OBS_TYPE_HINT.INT },
  ];

  const engine = new StructRecoveryEngine();
  const layout = engine.recover(1, obs, { structName: 'Entity' });

  assert.equal(layout.name, 'Entity');
  assert.equal(layout.stats.isolatedStack, 1);
  assert.equal(layout.fieldCount, 4);
  assert.equal(layout.alignment, 8);
  assert.equal(layout.byteSize, 32);

  const f0 = layout.members.find((m) => m.offset === 0);
  assert.equal(f0.type, 'void *');
  assert.ok(f0.confidence > 0.5 && f0.confidenceU8 > 128);

  const f8 = layout.members.find((m) => m.offset === 8);
  assert.equal(f8.type, 'int32_t');
  assert.equal(f8.signed, true);

  const pad12 = layout.members.find((m) => m.offset === 12);
  assert.equal(pad12.kind, 'padding');
  assert.equal(pad12.size, 4);

  const bf16 = layout.members.find((m) => m.offset === 16);
  assert.equal(bf16.kind, 'bitfield_group');
  assert.equal(bf16.bitfields.length, 2);
  assert.equal(bf16.bitfields[0].name, 'flags');
  assert.equal(bf16.bitfields[1].signed, true);

  const u24 = layout.members.find((m) => m.offset === 24);
  assert.equal(u24.kind, 'union');
  assert.equal(u24.variants.length, 2);

  const badBfLayout = recoverStructLayout([
    { funcVa: 1n, offset: 0, accessWidth: 4, typeHint: OBS_TYPE_HINT.UINT, obsFlags: OBS_FLAGS.HAS_BITFIELD, bfLsb: 0, bfWidth: 8 },
    { funcVa: 1n, offset: 0, accessWidth: 4, typeHint: OBS_TYPE_HINT.UINT, obsFlags: OBS_FLAGS.HAS_BITFIELD, bfLsb: 4, bfWidth: 8 },
  ]);
  assert.equal(badBfLayout.members[0].kind, 'field');
  assert.equal(badBfLayout.members[0].bitfields, null);

  const xrefIdx = buildStructMemberXrefIndex([
    { structSeedId: 1, offset: 0, funcIdx: 42, insnRel: 0x10, obsFlags: OBS_FLAGS.ACCESS_WRITE },
    { structSeedId: 1, offset: 0, funcIdx: 43, insnRel: 0x24, obsFlags: OBS_FLAGS.ACCESS_READ },
  ], { maxEntries: 1 });
  assert.equal(xrefIdx.byteLength, 8);
  assert.equal(xrefIdx.truncated, true);
  const q = xrefIdx.query(1, 0);
  assert.equal(q.entries.length, 1);
  assert.equal(q.entries[0].funcIdx, 42);
  assert.equal(q.entries[0].insnRel, 0x10);
  assert.equal(q.entries[0].accessKind, OBS_FLAGS.ACCESS_WRITE);
});

// ---------------------------------------------------------------------------
// 2. post-emit-overlay.js
// ---------------------------------------------------------------------------
test('post-emit-overlay: non-destructive O(1) line projection preserving line count and provenance keys', () => {
  const baseEmit = {
    lines: [
      'int64_t sub_1000(int64_t a0, int64_t a1) {',
      '    int32_t v0 = *(int32_t *)(a0 + 0x18);',
      '    if (v0 == 42) {',
      '        return sub_2000(a0, a1);',
      '    }',
      '    return 0;',
      '}',
    ],
    renderProvenance: {
      entities: {
        'L0:fn': { va: '0x1000' },
        'L1:field': { offset: 0x18 },
        'L3:callee': { va: '0x2000' },
      },
    },
  };

  const single = projectTypedOverlay(baseEmit, {
    renames: { sub_1000: 'Player_tick', sub_2000: 'Player_applyDamage', a0: 'player' },
    typeOverrides: { a0: 'Player *' },
    structFields: { 'a0:24': 'health' },
    comments: { 2: 'critical threshold' },
  });

  assert.equal(baseEmit.lines[0], 'int64_t sub_1000(int64_t a0, int64_t a1) {');
  assert.equal(single.lines.length, baseEmit.lines.length);
  assert.deepEqual(Object.keys(single.renderProvenance.entities), Object.keys(baseEmit.renderProvenance.entities));
  assert.ok(single.lines[0].includes('Player *player'));
  assert.ok(single.lines[0].includes('Player_tick'));
  assert.ok(single.lines[1].includes('player->health'));
  assert.ok(single.lines[2].includes('// critical threshold'));
  assert.ok(single.lines[3].includes('Player_applyDamage(player, a1)'));

  const engine = new PostEmitOverlayEngine(baseEmit);
  const touchedComment = engine.setComment(5, 'early exit');
  assert.deepEqual(touchedComment, [5]);
  assert.ok(engine.getLine(5).includes('// early exit'));

  const touchedRename = engine.setRename('sub_2000', 'apply_hit');
  assert.deepEqual(touchedRename, [3]);
  assert.ok(engine.getLine(3).includes('apply_hit'));

  assert.equal(requiresStructuralReDecompile({ renameOnly: true }), false);
  assert.equal(requiresStructuralReDecompile({ argCountChanged: true }), true);
});

// ---------------------------------------------------------------------------
// 3. dirty-cone.js
// ---------------------------------------------------------------------------
test('dirty-cone: bounded forward/reverse BFS, bipartite struct/global seeds, and POLYMORPHIC barrier', () => {
  const index = new DirtyConeIndex();
  index.addCallEdge('f0', 'f1');
  index.addCallEdge('f1', 'f2');
  index.addCallEdge('f2', 'f3');
  index.addCallEdge('f3', 'f4');
  index.addCallEdge('f4', 'f5');
  index.addCallEdge('g0', 'g1');
  index.setPolymorphic('f0', true);

  index.addStructRef('Entity', 'f2');
  index.addGlobalRef(0x50000n, 'f3');

  const cone = calculateDirtyCone(index, { kind: 'struct', structId: 'Entity' }, {
    maxUpstreamDepth: 2,
    maxDownstreamDepth: 2,
    maxNodes: 10,
    syncBudget: 3,
  });

  assert.ok(cone.ordered.includes('f2'));
  assert.ok(cone.ordered.includes('f1'));
  assert.ok(cone.ordered.includes('f3'));
  assert.ok(cone.ordered.includes('f4'));
  assert.ok(!cone.ordered.includes('f0'));
  assert.ok(!cone.ordered.includes('f5'));
  assert.ok(!cone.ordered.includes('g0'));
  assert.deepEqual(cone.blockedByPolymorphic, ['f0']);
  assert.equal(cone.syncWave.length, 3);
  assert.equal(cone.asyncWave.length, 1);

  const capped = index.computeDirtyCone({ kind: 'global', va: 0x50000n }, { maxNodes: 2 });
  assert.equal(capped.ordered.length, 2);
  assert.equal(capped.truncated, true);
});

// ---------------------------------------------------------------------------
// 4. type-transaction.js + Round 1 regressions
// ---------------------------------------------------------------------------
test('type-transaction: atomic commit/rollback, exception-safe undo/redo, array deltas, prototype guard & BigInt/Map/Set clone', () => {
  // BigInt, Map, Set deepClone fidelity
  const original = {
    va: 0x100004000n,
    map: new Map([[0x1000n, { name: 'fn', tags: new Set(['a', 2n]) }]]),
  };
  const cloned = deepClone(original);
  assert.equal(typeof cloned.va, 'bigint');
  assert.equal(cloned.va, 0x100004000n);
  assert.ok(cloned.map instanceof Map);
  assert.ok(cloned.map.get(0x1000n).tags instanceof Set);
  assert.ok(cloned.map.get(0x1000n).tags.has(2n));

  const dcIndex = new DirtyConeIndex();
  dcIndex.addCallEdge('callerA', 'targetFn');
  dcIndex.addCallEdge('targetFn', 'calleeB');

  const abortReasons = [];
  const txMgr = new TypeTransactionManager({
    dirtyConeIndex: dcIndex,
    onAbortInflight: (reason) => abortReasons.push(reason),
  });

  // Multiple recordDelta calls on same deltaKey accumulate into array
  const res1 = txMgr.runAtomic(
    { label: 'multi-delta', dirtySeeds: [{ kind: 'func', funcId: 'targetFn' }], requiresPathA2ReDecompile: true },
    () => {
      txMgr.recordDelta('sigDelta', { key: 'targetFn', before: 'void', after: 'Player *' });
      txMgr.recordDelta('sigDelta', { key: 'calleeB', before: 'int', after: 'bool' });
    }
  );
  assert.equal(res1.ok, true);
  assert.equal(res1.revision, 1);
  assert.equal(txMgr.undoStack[0].deltas.sigDelta.length, 2);
  assert.equal(txMgr.getState().sigDelta.targetFn, 'Player *');
  assert.equal(txMgr.getState().sigDelta.calleeB, 'bool');

  // Prototype-pollution keys rejected in recordDelta
  for (const badKey of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => {
      txMgr.runAtomic({ label: 'bad-key' }, () => {
        txMgr.recordDelta('sigDelta', { key: badKey, before: null, after: 'evil' });
      });
    }, /Forbidden delta key/);
  }
  assert.equal(txMgr.revision, 1);

  // Undo & Redo
  const undoRes = txMgr.undo();
  assert.equal(undoRes.ok, true);
  assert.equal(undoRes.revision, 2);
  assert.deepEqual(abortReasons, ['undo-redo']);
  assert.equal(txMgr.getState().sigDelta, undefined);

  const redoRes = txMgr.redo();
  assert.equal(redoRes.ok, true);
  assert.equal(redoRes.revision, 3);
  assert.equal(txMgr.getState().sigDelta.targetFn, 'Player *');

  // Round 1 regression: undo()/redo() exception safety preserves stacks, totalBytes & revision
  let shouldThrowRestore = false;
  let extState = { va: 0x1000n, val: 1 };
  const safeMgr = new TypeTransactionManager({
    captureSnapshot: () => extState,
    restoreSnapshot: (snap) => {
      if (shouldThrowRestore) throw new Error('restore hook exploded');
      extState = snap;
    },
  });
  safeMgr.runAtomic({ label: 'ext-edit' }, () => {
    extState = { va: 0x1000n, val: 2 };
  });
  const savedUndoLen = safeMgr.undoStack.length;
  const savedRedoLen = safeMgr.redoStack.length;
  const savedBytes = safeMgr.totalBytes;
  const savedRev = safeMgr.revision;

  shouldThrowRestore = true;
  assert.throws(() => safeMgr.undo(), /restore hook exploded/);
  assert.equal(safeMgr.undoStack.length, savedUndoLen);
  assert.equal(safeMgr.redoStack.length, savedRedoLen);
  assert.equal(safeMgr.totalBytes, savedBytes);
  assert.equal(safeMgr.revision, savedRev);

  shouldThrowRestore = false;
  assert.equal(safeMgr.undo().ok, true);
  assert.equal(extState.val, 1);
  assert.equal(typeof extState.va, 'bigint');
});

// ---------------------------------------------------------------------------
// 5. safe-type-promote.js + Round 1 regressions
// ---------------------------------------------------------------------------
test('safe-type-promote: monotonic lattice, fail-closed UNKNOWN default, USER_PINNED guard & prototype/toString rejection', () => {
  assert.equal(canPromoteType(TYPE_CONFIDENCE.UNKNOWN, TYPE_CONFIDENCE.HEURISTIC), true);
  assert.equal(canPromoteType(TYPE_CONFIDENCE.HEURISTIC, TYPE_CONFIDENCE.PROPAGATED), true);
  assert.equal(canPromoteType(TYPE_CONFIDENCE.PROPAGATED, TYPE_CONFIDENCE.TIL_MATCH), true);
  assert.equal(canPromoteType(TYPE_CONFIDENCE.TIL_MATCH, TYPE_CONFIDENCE.USER_PINNED), true);
  assert.equal(canPromoteType(TYPE_CONFIDENCE.USER_PINNED, TYPE_CONFIDENCE.TIL_MATCH), false);
  assert.equal(canPromoteType(TYPE_CONFIDENCE.USER_PINNED, TYPE_CONFIDENCE.USER_PINNED), true);

  // Round 1 regression: null-prototype CANONICAL_TYPE_SIZES rejects toString / __proto__ / constructor
  assert.equal(resolveCanonicalTypeSize('toString'), null);
  assert.equal(resolveCanonicalTypeSize('valueOf'), null);
  assert.equal(resolveCanonicalTypeSize('__proto__'), null);
  assert.equal(resolveCanonicalTypeSize('constructor'), null);
  assert.equal(resolveCanonicalTypeSize('prototype'), null);
  assert.equal(resolveCanonicalTypeSize('const char *'), 8);
  assert.equal(resolveCanonicalTypeSize('uint32_t[4]'), 16);

  // Plain object forbidden key guards
  const plainStore = {};
  assert.equal(promoteTypeEntry(plainStore, '__proto__', { type: 'int', confidence: TYPE_CONFIDENCE.USER_PINNED }).ok, false);
  assert.equal(promoteTypeEntry(plainStore, 'constructor', { type: 'int', confidence: TYPE_CONFIDENCE.USER_PINNED }).ok, false);
  assert.equal(promoteTypeEntry(plainStore, 'prototype', { type: 'int', confidence: TYPE_CONFIDENCE.USER_PINNED }).ok, false);

  const promoter = new SafeTypePromoter();
  assert.equal(promoter.promote('0x1000', { type: 'int64_t', confidence: TYPE_CONFIDENCE.HEURISTIC }).ok, true);
  assert.equal(promoter.promote('0x1000', { type: 'Player *', confidence: TYPE_CONFIDENCE.USER_PINNED }).ok, true);
  const blocked = promoter.promote('0x1000', { type: 'uint64_t', confidence: TYPE_CONFIDENCE.TIL_MATCH });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'user_pinned_protected');

  // Round 1 regression: unspecified confidence defaults to UNKNOWN (fail-closed) and cannot overwrite USER_PINNED
  const notesStructs = new Map();
  notesStructs.set('S1', {
    name: 'S1',
    members: [
      { name: 'pinned_ptr', type: 'Player *', offset: 0, size: 8, confidence: TYPE_CONFIDENCE.USER_PINNED },
    ],
  });
  const unspecOverwrite = promoteStructMemberSafe(notesStructs, 'S1', {
    offset: 0,
    type: 'uint64_t',
    name: 'auto_field',
  });
  assert.equal(unspecOverwrite.ok, false);
  assert.equal(unspecOverwrite.reason, 'user_pinned_protected');
  assert.equal(notesStructs.get('S1').members[0].name, 'pinned_ptr');

  // Forbidden typeName / structKey in promoteStructMemberSafe
  assert.equal(promoteStructMemberSafe({}, '__proto__', { offset: 0, type: 'int' }).reason, 'forbidden_key');
  assert.equal(promoteStructMemberSafe(notesStructs, 'S1', { offset: 8, type: 'toString' }).reason, 'forbidden_type_name');
  assert.equal(promoteStructMemberSafe(notesStructs, 'S1', { offset: 8, type: '__proto__' }).reason, 'forbidden_type_name');

  // split_container and replace_overlapping
  notesStructs.set('S2', {
    name: 'S2',
    members: [{ name: 'raw8', type: 'uint64_t', offset: 0, size: 8, confidence: TYPE_CONFIDENCE.HEURISTIC }],
  });
  assert.equal(promoteStructMemberSafe(notesStructs, 'S2', { offset: 0, type: 'uint32_t', confidence: TYPE_CONFIDENCE.USER_PINNED }).reason, 'member_overlap');
  const split = promoteStructMemberSafe(
    notesStructs,
    'S2',
    { offset: 0, type: 'uint32_t', name: 'lo', confidence: TYPE_CONFIDENCE.USER_PINNED },
    { resolution: 'split_container' }
  );
  assert.equal(split.ok, true);
  assert.equal(split.struct.members.length, 2);

  const okReplace = promoteStructMemberSafe(
    notesStructs,
    'S2',
    { offset: 0, type: 'double', name: 'merged', confidence: TYPE_CONFIDENCE.USER_PINNED },
    { resolution: 'replace_overlapping', allowOverwritePinned: true }
  );
  assert.equal(okReplace.ok, true);
  assert.equal(okReplace.struct.members[0].type, 'double');
});

// ---------------------------------------------------------------------------
// 6. global-type-map.js
// ---------------------------------------------------------------------------
test('global-type-map: address containment, array-stride, shifted-ptr queries, USER_PINNED guard & notes roundtrip', () => {
  const gmap = new GlobalTypeMap();
  const r1 = gmap.set(0x100000n, {
    name: 'g_entities',
    typeName: 'Entity[4]',
    arrayLen: 4,
    elementStride: 32,
    structSeedId: 1,
    confidence: TYPE_CONFIDENCE.USER_PINNED,
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.entry.byteSize, 128);

  const rBlocked = gmap.set(0x100000n, { typeName: 'uint8_t[128]', confidence: TYPE_CONFIDENCE.PROPAGATED });
  assert.equal(rBlocked.ok, false);
  assert.equal(rBlocked.reason, 'user_pinned_protected');

  const hit = gmap.queryAddress(0x100000n + 80n);
  assert.equal(hit.arrayIndex, 2);
  assert.equal(hit.elementOffset, 16);

  const elem3 = gmap.queryArrayElement(0x100000n, 3);
  assert.equal(elem3.elementVa, 0x100060n);

  const shifted = gmap.queryShifted(0x100018n, 0x18);
  assert.equal(shifted.baseVa, 0x100000n);
  assert.equal(shifted.memberOffset, 0x18);

  gmap.addXref(0x100000n, 'sub_1000', 'adrp_add');
  assert.equal(gmap.getXrefs(0x100000n).length, 1);

  const notesTypes = gmap.toNotesTypes();
  assert.ok('data:0x100000' in notesTypes);
  const restored = GlobalTypeMap.fromNotesTypes(notesTypes);
  assert.equal(restored.get(0x100000n).name, 'g_entities');
  assert.equal(restored.get(0x100000n).elementStride, 32);
});

// ---------------------------------------------------------------------------
// 7. manual-segment-map.js + Round 1 BSS_ZERO & 40B HexManualSegment POD
// ---------------------------------------------------------------------------
test('manual-segment-map: sorted non-overlapping, va<->fileOffset, BSS_ZERO, 24B Slot 5A & 40B HexManualSegment POD', () => {
  assert.equal(MANUAL_SEG_FLAGS.BSS_ZERO, 1 << 6);
  const arm64 = createArm64RecoveryAdapter();
  const segMap = new ManualSegmentMap({ archAdapter: arm64 });

  const badAlign = segMap.add({ startVa: 0x4002n, byteLen: 4, kind: MANUAL_SEG_KIND.CODE });
  assert.equal(badAlign.ok, false);
  assert.equal(badAlign.reason, 'unaligned_code_segment');

  assert.equal(
    segMap.add({
      startVa: 0x4010n,
      byteLen: 16,
      kind: MANUAL_SEG_KIND.DATA_U32,
      flags: MANUAL_SEG_FLAGS.BSS_ZERO,
      perms: MANUAL_SEG_PERM.R | MANUAL_SEG_PERM.W,
      fileOffset: null,
    }).ok,
    true
  );
  assert.equal(
    segMap.add({
      startVa: 0x4000n,
      byteLen: 16,
      kind: MANUAL_SEG_KIND.CODE,
      flags: MANUAL_SEG_FLAGS.FUNC_START,
      fileOffset: 0x1000n,
    }).ok,
    true
  );

  const ov = segMap.add({ startVa: 0x400cn, byteLen: 8, kind: MANUAL_SEG_KIND.DATA_U8 });
  assert.equal(ov.ok, false);
  assert.equal(ov.reason, 'segment_overlap');

  assert.equal(segMap.vaToFileOffset(0x4008n), 0x1008n);
  assert.equal(segMap.fileOffsetToVa(0x1008n), 0x4008n);

  // 24B Slot 5A roundtrip
  const slot5A = segMap.exportWasmSlot5A();
  assert.equal(slot5A.byteLength, 2 * MANUAL_SEG_ENTRY_BYTES);
  const re24 = ManualSegmentMap.importWasmSlot5A(slot5A, { archAdapter: arm64 });
  assert.equal(re24.size, 2);
  assert.equal(re24.queryVa(0x4014n).flags & MANUAL_SEG_FLAGS.BSS_ZERO, MANUAL_SEG_FLAGS.BSS_ZERO);

  // 40B HexManualSegment POD roundtrip (hex_manual_recovery.hpp:49-60)
  const buf40 = segMap.exportWasmSegments40();
  assert.equal(buf40.byteLength, 2 * MANUAL_SEGMENT_BYTES);
  const dv = new DataView(buf40.buffer, buf40.byteOffset, buf40.byteLength);
  assert.equal(dv.getBigUint64(0x00, true), 0x4000n);
  assert.equal(dv.getBigUint64(0x10, true), 0x1000n);
  assert.equal(dv.getBigUint64(40 + 0x10, true), MANUAL_SEG_NO_FILE);
  assert.equal(dv.getUint32(40 + 0x1c, true), MANUAL_SEG_FLAGS.BSS_ZERO);
  assert.equal(dv.getUint8(40 + 0x24), MANUAL_SEG_KIND.DATA_U32);
  assert.equal(dv.getUint8(40 + 0x27), 0);

  const re40 = ManualSegmentMap.importWasmSegments40(buf40, { archAdapter: arm64 });
  assert.equal(re40.size, 2);
  assert.equal(re40.vaToFileOffset(0x4004n), 0x1004n);
  assert.equal(re40.queryVa(0x4014n).fileOffset, null);
});

// ---------------------------------------------------------------------------
// 8. func-chunk-table.js + Round 1 DETACHED flag & 32B HexFuncChunk POD
// ---------------------------------------------------------------------------
test('func-chunk-table: primary/cold chunks, DETACHED flag, range merge, 24B & 32B HexFuncChunk POD export', () => {
  assert.equal(CHUNK_FLAGS.DETACHED, 1 << 4);
  const arm64 = createArm64RecoveryAdapter();
  const table = new FuncChunkTable({ archAdapter: arm64 });

  assert.equal(table.attachChunk(0x1000n, { startVa: 0x1000n, endVa: 0x1080n, isPrimary: true }).ok, true);
  assert.equal(table.attachChunk(0x1000n, { startVa: 0x9000n, endVa: 0x9040n, chunkFlags: CHUNK_FLAGS.UNWIND_COLD }).ok, true);
  assert.equal(table.attachChunk(0x1000n, { startVa: 0x9040n, endVa: 0x9080n, chunkFlags: CHUNK_FLAGS.UNWIND_COLD }).ok, true);

  const owner = table.lookupOwner(0x9020n);
  assert.equal(owner.ownerFuncVa, 0x1000n);
  assert.equal(owner.chunk.chunkOrd, 1);

  const merged = table.mergeAdjacentRanges(0x1000n);
  assert.equal(merged.mergedCount, 1);
  assert.equal(merged.chunks.length, 2);

  const det = table.detachChunk(0x1000n, 0x9000n);
  assert.equal(det.ok, true);
  assert.ok((det.removed.chunkFlags & CHUNK_FLAGS.DETACHED) !== 0);
  const autoReadd = table.attachChunk(0x1000n, { startVa: 0x9000n, endVa: 0x9080n, chunkFlags: CHUNK_FLAGS.UNWIND_COLD });
  assert.equal(autoReadd.ok, false);
  assert.equal(autoReadd.reason, 'detached_by_user');

  const outlined = table.attachOutlinedCandidates(0x1000n, [
    {
      startVa: 0xa000n,
      endVa: 0xa010n,
      inDegree: 1,
      isExported: false,
      insns: [
        { mnemonic: 'mov', operands: 'x0, #1' },
        { mnemonic: 'ret', operands: '' },
      ],
    },
  ]);
  assert.equal(outlined.attached.length, 1);

  const wasm24 = table.exportChunkRangesWasm(0x1000n);
  assert.equal(wasm24.byteLength, 2 * FUNC_CHUNK_RANGE_BYTES);

  // 32B HexFuncChunk POD roundtrip (hex_manual_recovery.hpp:106-112)
  const wasm32 = table.exportChunksWasm32(0x1000n);
  assert.equal(wasm32.byteLength, 2 * FUNC_CHUNK_BYTES);
  const dv32 = new DataView(wasm32.buffer, wasm32.byteOffset, wasm32.byteLength);
  assert.equal(dv32.getBigUint64(0x00, true), 0x1000n);
  assert.equal(dv32.getBigUint64(0x08, true), 0x1000n);
  assert.equal(dv32.getUint32(0x18, true), FUNC_CHUNK_KIND.PRIMARY);
  assert.equal(dv32.getUint32(32 + 0x18, true), FUNC_CHUNK_KIND.TAIL_CALL);
  assert.equal(dv32.getUint32(32 + 0x1c, true), CHUNK_FLAGS.OUTLINED_TAIL);

  const re32 = FuncChunkTable.importChunksWasm32(wasm32, { archAdapter: arm64 });
  assert.equal(re32.getChunks(0x1000n).length, 2);
  assert.equal(re32.lookupOwner(0xa004n).ownerFuncVa, 0x1000n);
});

// ---------------------------------------------------------------------------
// 9. custom-abi-spec.js + Round 1 ret_count (+0x0F) regression
// ---------------------------------------------------------------------------
test('custom-abi-spec: __usercall parsing, Fail-Closed validation, ret_count 0/1/2 at +0x0F & 192B POD export', () => {
  const arm64 = createArm64RecoveryAdapter();
  const store = new CustomAbiStore({ archAdapter: arm64 });

  // ret_count = 0 (NONE)
  const parsedVoid = parseUsercallSignature('void __usercall f_void(uint64_t a@<x0>)', arm64);
  assert.equal(parsedVoid.ok, true);
  assert.equal(computeRetCount(parsedVoid.spec.retLoc), 0);
  const pod0 = exportCustomAbiWasm192(parsedVoid.spec);
  assert.equal(pod0[0x0f], 0);

  // ret_count = 1 (GPR, FPR_SIMD, STACK)
  const parsedGpr = parseUsercallSignature(
    'int64_t __userpurge custom_fn@<x0>(void *ctx@<x20>, double v@<d1>, uint64_t key@<0x10[sp]>) __purge(0x10)',
    arm64
  );
  assert.equal(parsedGpr.ok, true);
  assert.equal(parsedGpr.spec.abiFlags & ABI_FLAGS.USERPURGE, ABI_FLAGS.USERPURGE);
  assert.equal(exportCustomAbiWasm192(parsedGpr.spec)[0x0f], 1);

  const parsedStackRet = parseUsercallSignature('uint64_t __usercall f_stk@<0x0[sp]>(uint64_t a@<x0>)', arm64);
  assert.equal(parsedStackRet.ok, true);
  assert.equal(exportCustomAbiWasm192(parsedStackRet.spec)[0x0f], 1);

  // ret_count = 2 (GPR_PAIR and FPR_PAIR)
  const parsedPair = parseUsercallSignature('__int128 __usercall f_pair@<x0:x1>(uint64_t a@<x2>)', arm64);
  assert.equal(parsedPair.ok, true);
  assert.equal(parsedPair.spec.retLoc.locKind, ABI_LOC_KIND.GPR_PAIR);
  assert.equal(exportCustomAbiWasm192(parsedPair.spec)[0x0f], 2);

  const parsedFpPair = parseUsercallSignature('double2 __usercall f_fpair@<d0:d1>(uint64_t a@<x0>)', arm64);
  assert.equal(parsedFpPair.ok, true);
  assert.equal(parsedFpPair.spec.retLoc.locKind, ABI_LOC_KIND.FPR_PAIR);
  assert.equal(exportCustomAbiWasm192(parsedFpPair.spec)[0x0f], 2);

  assert.equal(store.set(0x2000n, parsedGpr.spec).ok, true);
  const proj = store.validateAndProject(0x2000n, {}, 0);
  assert.equal(proj.ok, true);
  assert.equal(proj.pinMask, CUSTOM_ABI_PIN_MASK);
  assert.equal(proj.sig16.fpArgMask, 1 << 1);

  const dup = validateCustomAbiSpec({
    argCount: 2,
    spPurgeBytes: 0,
    argLocs: [
      { locKind: ABI_LOC_KIND.GPR, regId: 0, regIdHi: 0xff, byteWidth: 8, spOffset: 0, locFlags: 0 },
      { locKind: ABI_LOC_KIND.GPR, regId: 0, regIdHi: 0xff, byteWidth: 8, spOffset: 0, locFlags: 0 },
    ],
  }, arm64);
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /duplicate_register/);

  const badPurge = validateCustomAbiSpec({ argCount: 0, spPurgeBytes: 8, argLocs: [] }, arm64);
  assert.equal(badPurge.ok, false);
  assert.equal(badPurge.reason, 'sp_purge_not_16b_aligned');

  const spArg = parseUsercallSignature('void __usercall bad(void *s@<sp>)', arm64);
  assert.equal(spArg.ok, false);

  const pod192 = exportCustomAbiWasm192(store.get(0x2000n));
  assert.equal(pod192.byteLength, CUSTOM_ABI_SPEC_BYTES);
});

// ---------------------------------------------------------------------------
// 10. stack-slot-override.js
// ---------------------------------------------------------------------------
test('stack-slot-override: set, splitSlot, mergeSlots, querySlot & 24B POD export', () => {
  const reg = new StackSlotOverrideRegistry();
  assert.equal(reg.setOverride(0x3000n, { spOffset: 0x10, byteSize: 16, name: 'buf', typeName: 'uint8_t[16]' }).ok, true);

  const split = reg.splitSlot(0x3000n, 0x10, [
    { byteSize: 8, name: 'ptr', typeName: 'void *' },
    { byteSize: 8, name: 'len', typeName: 'size_t' },
  ]);
  assert.equal(split.ok, true);
  assert.equal(reg.getOverrides(0x3000n).length, 2);
  assert.ok((split.slots[0].slotFlags & STACK_SLOT_FLAGS.FORCE_SPLIT) !== 0);

  const hit = reg.querySlot(0x3000n, 0x1c);
  assert.equal(hit.entry.name, 'len');
  assert.equal(hit.innerOffset, 4);

  const merged = reg.mergeSlots(0x3000n, 0x10, 0x20, { name: 'slice', typeName: 'Slice' });
  assert.equal(merged.ok, true);
  assert.equal(reg.getOverrides(0x3000n).length, 1);
  assert.ok((merged.entry.slotFlags & STACK_SLOT_FLAGS.FORCE_MERGE) !== 0);

  const pod = reg.exportWasm24(0x3000n);
  assert.equal(pod.byteLength, STACK_SLOT_OVERRIDE_BYTES);
});

// ---------------------------------------------------------------------------
// 11. shifted-ptr-spec.js + ARM64 DI recognition
// ---------------------------------------------------------------------------
test('shifted-ptr-spec: __shifted parsing, member resolution, double-shift guard & 24B POD export', () => {
  const arm64 = createArm64RecoveryAdapter();
  const parsed = parseShiftedTypeAnnotation('Node *__shifted(Node, 0x18)');
  assert.equal(parsed.parentType, 'Node');
  assert.equal(parsed.shiftOffset, 0x18);
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('a'), 0xe40c292c);
  assert.equal(fnv1a32('arg:0'), 0x393cddb5);

  const reg = new ShiftedPtrRegistry({ archAdapter: arm64 });
  reg.register(0x4000n, {
    varKey: 'arg:0',
    parentTid: 0x8001,
    parentType: 'Node',
    shiftOffset: 0x18,
    specFlags: SHIFTED_PTR_FLAGS.FROM_CXX_THUNK | SHIFTED_PTR_FLAGS.ALLOW_NEG_OFFSET,
  });

  const nodeLayout = {
    members: [
      { kind: 'field', name: 'id', offset: 0, size: 8 },
      { kind: 'field', name: 'link', offset: 0x18, size: 16 },
    ],
  };

  const resolved = reg.resolveMemberAccess(0x4000n, 'arg:0', -0x18, nodeLayout, { varName: 'p' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.parentOffset, 0);
  assert.equal(resolved.pathAExpr, 'ADJ(p)->id');
  assert.equal(resolved.pathBC11Expr, 'HEX_CONTAINER_OF(p, Node, 0x18)->id');

  const noDouble = reg.resolveMemberAccess(0x4000n, 'arg:0', 0, nodeLayout, {
    varName: 'p',
    alreadyAdjustedByThunk: true,
  });
  assert.equal(noDouble.doubleShiftPrevented, true);
  assert.equal(noDouble.parentOffset, 0);

  const idioms = reg.recognizeFromInstructions([
    { va: 0x4004n, mnemonic: 'sub', operands: 'x8, x0, #0x18' },
    { va: 0x4008n, mnemonic: 'ldur', operands: 'x9, [x0, #-0x18]' },
  ]);
  assert.equal(idioms.length, 2);
  assert.equal(idioms[0].shiftDelta, 0x18);
  assert.equal(idioms[1].kind, 'neg_mem_access');

  const pod = reg.exportWasm24(0x4000n);
  assert.equal(pod.byteLength, SHIFTED_PTR_SPEC_BYTES);
});

// ---------------------------------------------------------------------------
// 12. arm64/recovery-adapter.js
// ---------------------------------------------------------------------------
test('arm64/recovery-adapter: ABI registers, C++ thunk detection & tail-call classification', () => {
  const arm64 = createArm64RecoveryAdapter();
  assert.equal(ARM64_GP_ARG_REGS.length, 8);
  assert.equal(ARM64_FP_ARG_REGS.length, 8);
  assert.equal(ARM64_SP_REG, 'sp');
  assert.equal(arm64.parseRegister('x7').regId, 7);
  assert.equal(arm64.parseRegister('v3').bank, 'fpr');
  assert.equal(arm64.parseRegister('sp').isSp, true);

  const thunk = arm64.detectTailCallOrThunk(
    [
      { mnemonic: 'sub', operands: 'x0, x0, #0x10' },
      { mnemonic: 'b', operands: '0x5000', targetVa: 0x5000n },
    ],
    { startVa: 0x4f00n, endVa: 0x4f08n }
  );
  assert.equal(thunk.isTailCall, true);
  assert.equal(thunk.isThunk, true);
  assert.equal(thunk.thunkDelta, -0x10);
  assert.equal(thunk.targetVa, 0x5000n);
});

// ---------------------------------------------------------------------------
// 13. jev-overlay.js + Round 1 VA normalization, strict Gate 1 & GlobalTypeMap guard
// ---------------------------------------------------------------------------
test('jev-overlay: 7 Fail-Closed gates, mixed VA normalization, strict Gate 1 & GlobalTypeMap USER_PINNED protection', () => {
  // Round 1 regression: toVaKey canonicalization & invalid number rejection
  assert.equal(toVaKey('0x00001000'), '0x1000');
  assert.equal(toVaKey('0X0000000000002000'), '0x2000');
  assert.equal(toVaKey(0x1000), '0x1000');
  assert.equal(toVaKey(0x1000n), '0x1000');
  assert.equal(toVaKey(NaN), null);
  assert.equal(toVaKey(Infinity), null);
  assert.equal(toVaKey(-1), null);
  assert.equal(toVaKey(-16n), null);
  assert.equal(toVaKey('-0x10'), null);

  const segMap = new ManualSegmentMap();
  segMap.add({ startVa: 0x8000n, byteLen: 16, kind: MANUAL_SEG_KIND.DATA_U64 });

  const promoter = new SafeTypePromoter();
  promoter.promote('0x1000', { type: 'Player *', confidence: TYPE_CONFIDENCE.USER_PINNED });

  const gmap = new GlobalTypeMap();
  gmap.set(0x9000n, {
    name: 'g_pinned_config',
    typeName: 'Config',
    byteSize: 32,
    confidence: TYPE_CONFIDENCE.USER_PINNED,
  });

  const structLayouts = new Map([
    [1, { members: [{ kind: 'field', name: 'hp', offset: 0x10, size: 4, type: 'int32_t' }] }],
  ]);

  // Mix zero-padded hex, BigInt, and Number keys across stores
  const overlay = new JevQueryOverlay({
    userRenames: new Map([['0x00001000', 'Player_getHealth']]),
    structLayouts,
    manualSegmentMap: segMap,
    safeTypePromoter: promoter,
    globalTypeMap: gmap,
    hexSigScores: new Map([[0x2000n, 900]]),
  });

  // Gate 2 with mixed BigInt query vs zero-padded hex userRenames key
  const rUser = overlay.applyToSymbolAnswer(
    { va: 0x1000n, name: 'sub_1000', structId: 1 },
    { name: 'jev_guess', confidence: 0.95 }
  );
  assert.equal(rUser.displayName, 'Player_getHealth');
  assert.equal(rUser.nameAuthority, AUTHORITY_LEVEL.USER_MANUAL);
  assert.equal(rUser.effectiveType, 'Player *');
  assert.equal(rUser.structFields[0].name, 'hp');

  // Gate 4 with zero-padded hex query vs BigInt hexSigScores key
  const rHexSig = overlay.applyToSymbolAnswer(
    { va: '0x00002000', name: 'memcpy_fast' },
    { name: 'jev_copy', confidence: 0.99 }
  );
  assert.equal(rHexSig.displayName, 'memcpy_fast');
  assert.equal(rHexSig.jevGateResult.failedGate, 4);

  // GlobalTypeMap USER_PINNED blocks Jev naming at Gate 2
  const rGlobalPinned = overlay.applyToSymbolAnswer(
    { va: '0x00009000', name: 'g_pinned_config' },
    { name: 'jev_global_guess', confidence: 0.99 }
  );
  assert.equal(rGlobalPinned.displayName, 'g_pinned_config');
  assert.equal(rGlobalPinned.jevGateResult.failedGate, 2);
  assert.equal(rGlobalPinned.effectiveConfidence, TYPE_CONFIDENCE.USER_PINNED);

  // Gate 5: manual non-code segment blocks Jev naming
  const rData = overlay.applyToSymbolAnswer(
    { va: 0x8000n, name: 'unk_8000' },
    { name: 'jev_fn', confidence: 0.95 }
  );
  assert.equal(rData.jevGateResult.failedGate, 5);
  assert.equal(rData.manualSegment.kind, MANUAL_SEG_KIND.DATA_U64);

  // Valid Jev suggestion passes all 7 gates (including C++ namespace::method)
  const rOk = overlay.applyToSymbolAnswer(
    { va: 0x3000n, name: 'sub_3000' },
    { name: 'Audio::Mixer_update', confidence: 0.88 }
  );
  assert.equal(rOk.displayName, 'Audio::Mixer_update');
  assert.equal(rOk.nameSource, 'jev_overlay');
  assert.equal(rOk.provenancePreserved, true);

  // Round 1 regression: strict Gate 1 rejections
  for (const badName of [
    '123bad',
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'valueOf',
    'return',
    'struct',
    '_Bool',
    'foo bar',
    'foo*bar',
    'foo-bar',
    'ns::return',
  ]) {
    assert.equal(
      evaluateJevNamingGates({ name: badName, confidence: 0.95 }).failedGate,
      1,
      `Gate 1 must reject "${badName}"`
    );
  }
  assert.equal(evaluateJevNamingGates({ name: 'good_fn', confidence: 0.2 }).failedGate, 6);
  assert.equal(evaluateJevNamingGates({ name: 'good_fn', confidence: 0.9, mutateProvenanceKeys: true }).failedGate, 7);
});

// ---------------------------------------------------------------------------
// 14. Static INV-005 Boundary Check
// ---------------------------------------------------------------------------
test('INV-005 static check: zero imports of js/targets/architecture/ in types/core, recovery, and query', () => {
  const genericFiles = [
    'js/analysis/types/core/struct-recovery.js',
    'js/analysis/types/core/post-emit-overlay.js',
    'js/analysis/types/core/dirty-cone.js',
    'js/analysis/types/core/type-transaction.js',
    'js/analysis/types/core/safe-type-promote.js',
    'js/analysis/types/core/global-type-map.js',
    'js/analysis/recovery/manual-segment-map.js',
    'js/analysis/recovery/func-chunk-table.js',
    'js/analysis/recovery/custom-abi-spec.js',
    'js/analysis/recovery/stack-slot-override.js',
    'js/analysis/recovery/shifted-ptr-spec.js',
    'js/analysis/query/jev-overlay.js',
  ];

  const importRe = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  for (const rel of genericFiles) {
    const abs = path.join(ROOT, rel);
    const src = fs.readFileSync(abs, 'utf8');
    let m;
    importRe.lastIndex = 0;
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1];
      const resolved = spec.startsWith('.')
        ? path.relative(ROOT, path.resolve(path.dirname(abs), spec)).split(path.sep).join('/')
        : spec;
      assert.ok(
        !resolved.includes('targets/architecture') && !resolved.includes('js/architecture'),
        `INV-005 violation in ${rel}: forbidden import "${spec}" (resolved: "${resolved}")`
      );
      assert.ok(
        !resolved.includes('targets/abi') && !resolved.includes('js/abi'),
        `INV-005 violation in ${rel}: forbidden ABI import "${spec}"`
      );
    }
  }

  const adapterPath = path.join(ROOT, 'js/targets/architecture/arm64/recovery-adapter.js');
  const adapterSrc = fs.readFileSync(adapterPath, 'utf8');
  let m;
  importRe.lastIndex = 0;
  while ((m = importRe.exec(adapterSrc)) !== null) {
    assert.ok(
      !m[1].includes('abi'),
      `INV-005 violation in arm64/recovery-adapter.js: forbidden ABI import "${m[1]}"`
    );
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}
console.log(`\nTrack 7 summary: ${passed}/${tests.length} tests passed.`);
if (passed !== tests.length) process.exit(1);
