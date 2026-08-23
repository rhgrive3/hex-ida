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
  assert.equal(call.target, 0x1010n);
  assert.equal(provenance.base(0, 1), null, 'CALL must still kill caller-saved provenance');
  assert.equal(provenance.base(30, 1), null, 'BL must still kill link-register provenance');
  assert.equal(provenance.base(19, 1), 0x4000n, 'callee-saved provenance must survive call fallthrough');
  assert.equal(provenance.pendingEntries, 1, 'forward direct call target must be reserved as a boundary');
  assert.equal(provenance.enter(0x1008n), false, 'ordinary call fallthrough is not a function boundary');
  assert.equal(provenance.base(19, 2), 0x4000n);
  assert.equal(provenance.enter(0x1010n), true, 'direct call target must become a boundary without metadata');
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

// issues-814-816 ARM64 memory E2E
