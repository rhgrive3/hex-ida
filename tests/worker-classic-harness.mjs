import assert from 'node:assert/strict';
import { NodeBackend } from './harness.mjs';

const bytes = new Uint8Array(32);
const file = {
  name: 'worker-harness.bin',
  size: bytes.length,
  slice(start, end) {
    const part = bytes.subarray(start, end);
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  },
};

const backend = new NodeBackend();
const info = await backend.open(file);
assert.equal(info.format, 'Raw binary');
assert.ok(info.raw?.id, 'raw region must be available');
const xrefs = await backend.xrefs({ regionId: info.raw.id, target: 0n, limit: 4 });
assert.ok(Array.isArray(xrefs.results));
assert.equal(xrefs.cancelled, false);
console.log('classic worker harness regression passed');

// #1661: a direct BL target is a future provenance boundary even when
// function-start metadata is missing, but the immediate call fallthrough must
// retain callee-saved address provenance.
{
  const K = { CALL: 1, INDCALL: 2, CONDBR: 3, BRANCH: 4, RET: 5, TRAP: 6 };
  const words = {
    KIND: K,
    branchImm26() { return 0x1010n; },
    condBranchTarget() { return null; },
  };
  const provenance = globalThis.AddressProvenance.create({
    words,
    functionStarts: [],
    rangeStart: 0x1000n,
    rangeEnd: 0x1100n,
    pairWindow: 16,
  });
  provenance.note(0, 0x3000n, 0);
  provenance.note(19, 0x4000n, 0);
  provenance.note(30, 0x5000n, 0);
  const call = provenance.control(0, 0x1004n, K.CALL);
  assert.equal(call.call, true, 'direct BL must retain call classification while reserving its target boundary');
  assert.equal(call.target, 0x1010n);
  assert.equal(provenance.base(0, 1), null, 'CALL must still kill caller-saved provenance');
  assert.equal(provenance.base(30, 1), null, 'BL must still kill link-register provenance');
  assert.equal(provenance.base(19, 1), 0x4000n, 'callee-saved provenance must survive call fallthrough');
  assert.equal(provenance.pendingEntries, 1, 'forward direct call target must be reserved as a boundary');
  assert.equal(provenance.enter(0x1008n), false, 'ordinary call fallthrough is not a function boundary');
  assert.equal(provenance.base(19, 2), 0x4000n);
  assert.equal(provenance.enter(0x1010n), true, 'direct call target must become a boundary without metadata');
  assert.equal(provenance.pendingEntries, 0, 'entered direct call target must consume its pending boundary');
  assert.equal(provenance.base(19, 3), null, 'caller provenance must not leak into the direct callee');

  const nonForwardWords = {
    KIND: K,
    branchImm26(_word, pc) { return pc - 4n; },
    condBranchTarget() { return null; },
  };
  const nonForward = globalThis.AddressProvenance.create({
    words: nonForwardWords,
    functionStarts: [],
    rangeStart: 0x1000n,
    rangeEnd: 0x1100n,
  });
  nonForward.control(0, 0x1010n, K.CALL);
  assert.equal(nonForward.pendingEntries, 0, 'backward call targets must not create future scan boundaries');

  const outOfRangeWords = {
    KIND: K,
    branchImm26() { return 0x1200n; },
    condBranchTarget() { return null; },
  };
  const outOfRange = globalThis.AddressProvenance.create({
    words: outOfRangeWords,
    functionStarts: [],
    rangeStart: 0x1000n,
    rangeEnd: 0x1100n,
  });
  outOfRange.control(0, 0x1004n, K.CALL);
  assert.equal(outOfRange.pendingEntries, 0, 'out-of-range call targets must not create local scan boundaries');

  // #1900: a prepass seeds only registers clobbered on a backward loop path.
  const loopSafe = globalThis.AddressProvenance.create({
    words,
    functionStarts: [],
    entryKills: [[0x1008n, [0]], [0x1200n, [19]]],
    rangeStart: 0x1000n,
    rangeEnd: 0x1100n,
    pairWindow: 16,
  });
  loopSafe.note(0, 0x6000n, 0);
  loopSafe.note(19, 0x7000n, 0);
  assert.equal(loopSafe.pendingEntries, 1, 'only in-range preloaded loop kills are retained');
  assert.equal(loopSafe.enter(0x1008n), true, 'preloaded backward target must be a first-visit provenance boundary');
  assert.equal(loopSafe.base(0, 1), null, 'loop-clobbered base provenance must be invalidated');
  assert.equal(loopSafe.base(19, 1), 0x7000n, 'unmodified base provenance must survive the loop merge');
}

function fileFromWords(name, words) {
  const raw = new Uint8Array(words.length * 4);
  const dv = new DataView(raw.buffer);
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i] >>> 0, true);
  return {
    name, size: raw.length,
    slice(start, end) {
      const part = raw.subarray(start, end);
      return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
    },
  };
}

// #814: ADR establishes x2 provenance; LDPSW #4 must reference +4 (not +8)
// and expose the real 8-byte pair width through the worker field scanner.
{
  const b = new NodeBackend();
  const opened = await b.open(fileFromWords('ldpsw-worker.bin', [0x10000002, 0x69408440]));
  const id = opened.raw.id;
  const scan = await b.scanProgram(id);
  assert.equal(scan.kinds[1], globalThis.Words.KIND.LOAD);
  const ref = Array.from({ length: scan.refCount }, (_, i) => ({ from: scan.refFrom[i], to: scan.refTo[i], kind: scan.refKind[i] }))
    .find((x) => x.from === 4n);
  assert.deepEqual(ref, { from: 4n, to: 4n, kind: 1 });
  const fields = await b.fieldAccess({ regionId: id, offset: 4n, size: 8, limit: 8 });
  assert.equal(fields.results.length, 1);
  assert.equal(fields.results[0].size, 8);
  assert.equal(fields.results[0].kind, 'load');
  const xrefs2 = await b.xrefs({ regionId: id, target: 4n, limit: 8 });
  assert.ok(xrefs2.results.some((x) => x.addr === 4n && x.kind === 'load'));
}

// #815: pair exclusives stay atomic, keep total pair width, and do not become
// fabricated scalar value-shape mutations.
{
  const b = new NodeBackend();
  const opened = await b.open(fileFromWords('exclusive-pair-worker.bin', [0xc87f0440, 0xc8230440]));
  const id = opened.raw.id;
  const scan = await b.scanProgram(id);
  assert.deepEqual(Array.from(scan.kinds.slice(0, 2)), [globalThis.Words.KIND.ATOMIC, globalThis.Words.KIND.ATOMIC]);
  const fields = await b.fieldAccess({ regionId: id, offset: 0n, size: 16, limit: 8 });
  assert.deepEqual(fields.results.map((x) => x.kind), ['load', 'store']);
  assert.ok(fields.results.every((x) => x.size === 16 && x.atomic === true));
  const shapes = await b.valueShapes(id);
  assert.equal(shapes.count, 0);
}

// #816: every RMW reaches worker consumers as both read and write, while
// valueShapes records a neutral atomic mutation instead of choosing one side.
{
  const b = new NodeBackend();
  const opened = await b.open(fileFromWords('lse-rmw-worker.bin', [0xc8a07c41, 0xf8200041]));
  const id = opened.raw.id;
  const scan = await b.scanProgram(id);
  assert.deepEqual(Array.from(scan.kinds.slice(0, 2)), [globalThis.Words.KIND.ATOMIC, globalThis.Words.KIND.ATOMIC]);
  const fields = await b.fieldAccess({ regionId: id, offset: 0n, size: 8, limit: 8 });
  assert.deepEqual(fields.results.map((x) => x.kind), ['load', 'store', 'load', 'store']);
  assert.ok(fields.results.every((x) => x.atomic === true && x.rmw === true));
  const shapes = await b.valueShapes(id);
  assert.equal(shapes.count, 2);
  assert.ok(Array.from(shapes.flags).every((f) => (f & 32) !== 0));
}

// #1900: a backward B.cond target is a merge point. Provenance from the
// preheader survives only when the source GP register is unchanged by the loop.
{
  const straight = new NodeBackend();
  const straightInfo = await straight.open(fileFromWords('straight-adrp-add.bin', [
    0x90000000, // adrp x0, page(0)
    0x91008001, // add x1, x0, #0x20
    0xd503201f, // nop
  ]));
  const straightScan = await straight.scanProgram(straightInfo.raw.id);
  assert.ok(
    Array.from({ length: straightScan.refCount }, (_, i) => ({ from:straightScan.refFrom[i], to:straightScan.refTo[i] }))
      .some((x) => x.from === 4n && x.to === 0x20n),
    'straight-line ADRP+ADD must keep its exact reference',
  );
  const straightXrefs = await straight.xrefs({ regionId:straightInfo.raw.id, target:0x20n, limit:8 });
  assert.ok(straightXrefs.results.some((x) => x.addr === 4n && x.kind === 'address'));

  const unchangedLoop = new NodeBackend();
  const unchangedInfo = await unchangedLoop.open(fileFromWords('loop-unchanged-base.bin', [
    0x90000000, // adrp x0, page(0)
    0xd503201f, // nop
    0x91008001, // loop: add x1, x0, #0x20
    0x54ffffe1, // b.ne loop (pc - 4); x0 is unchanged
  ]));
  const unchangedScan = await unchangedLoop.scanProgram(unchangedInfo.raw.id);
  assert.ok(
    Array.from({ length: unchangedScan.refCount }, (_, i) => ({ from:unchangedScan.refFrom[i], to:unchangedScan.refTo[i] }))
      .some((x) => x.from === 8n && x.to === 0x20n),
    'loop must preserve an address base that no back-edge path redefines',
  );

  const rematerializedLoop = new NodeBackend();
  const rematerializedInfo = await rematerializedLoop.open(fileFromWords('loop-rematerialized-base.bin', [
    0x90000000, // adrp x0, page(0) — preheader state
    0x91008000, // add x0, x0, #0x20
    0x91004001, // loop: add x1, x0, #0x10
    0x90000000, // adrp x0, page(0) — same value on the back-edge path
    0x91008000, // add x0, x0, #0x20
    0x54ffffa1, // b.ne loop (pc - 12)
  ]));
  const rematerializedScan = await rematerializedLoop.scanProgram(rematerializedInfo.raw.id);
  assert.ok(
    Array.from({ length: rematerializedScan.refCount }, (_, i) => ({ from:rematerializedScan.refFrom[i], to:rematerializedScan.refTo[i] }))
      .some((x) => x.from === 8n && x.to === 0x30n),
    'same-value ADRP rematerialization must preserve the loop-entry reference',
  );

  const reestablishedLoop = new NodeBackend();
  const reestablishedInfo = await reestablishedLoop.open(fileFromWords('loop-reestablished-base.bin', [
    0x90000000, // adrp x0, page(0) — preheader state
    0x91008000, // add x0, x0, #0x20 — exact base immediately before target
    0x91004001, // loop: add x1, x0, #0x10
    0xaa0203e0, // mov x0, x2 — the back-edge path clobbers x0
    0x54ffffc1, // b.ne loop (pc - 8)
  ]));
  const reestablishedScan = await reestablishedLoop.scanProgram(reestablishedInfo.raw.id);
  assert.ok(
    Array.from({ length: reestablishedScan.refCount }, (_, i) => ({ from:reestablishedScan.refFrom[i], to:reestablishedScan.refTo[i] }))
      .some((x) => x.from === 8n && x.to === 0x30n),
    'a complete exact chain immediately before a loop target must keep its first-visit reference',
  );

  const loop = new NodeBackend();
  const loopInfo = await loop.open(fileFromWords('loop-clobbered-base.bin', [
    0x90000000, // adrp x0, page(0) — preheader state
    0xd503201f, // nop
    0x91008001, // loop: add x1, x0, #0x20
    0xaa0203e0, // mov x0, x2 — redefines the base on the back-edge path
    0x54ffffc1, // b.ne loop (pc - 8)
  ]));
  const loopScan = await loop.scanProgram(loopInfo.raw.id);
  assert.ok(
    !Array.from({ length: loopScan.refCount }, (_, i) => ({ from:loopScan.refFrom[i], to:loopScan.refTo[i] }))
      .some((x) => x.from === 8n && x.to === 0x20n),
    'scanProgram must not carry clobbered preheader ADRP provenance into the loop merge',
  );
  const loopXrefs = await loop.xrefs({ regionId:loopInfo.raw.id, target:0x20n, limit:8 });
  assert.ok(
    !loopXrefs.results.some((x) => x.addr === 8n && x.kind === 'address'),
    'findXrefs must not report stale ADRP+ADD xrefs after a loop-carried base clobber',
  );
}

// issues-814-816 ARM64 memory E2E
