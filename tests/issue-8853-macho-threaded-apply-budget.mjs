/**
 * Issue #8853 regression: BIND_OPCODE_THREADED APPLY must charge the shared
 * Mach-O metadata budget once per chain node. Only isBind hops used to charge,
 * so a delta-only chain (no binds) walked up to 100,000 nodes — each of which
 * re-reads an 8-byte word and re-scans every section/segment mapping in
 * threadedPointerFileOffset() — while `used.operations` stayed frozen. The
 * budget's every-1024-op wall-clock check and its `signal.aborted` observation
 * therefore never fired, and a sub-megabyte accepted input monopolized the
 * worker past `wallClockMs` while still publishing `complete: true`.
 *
 * Deterministic counterexample uses an aggregate `operations` ceiling the
 * setup opcodes do not reach, so the ONLY thing that can exhaust it is the
 * per-node walk charge the fix adds. Pre-fix the chain runs to its delta-0
 * terminator and completes; post-fix it fails closed mid-chain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseClassicBindings } from '../js/binary/macho-dyld.js';
import { createMachOMetadataBudget } from '../js/binary/macho-budget.js';

const VM = 0x1000n;
const FILE = 0x100n;
const SEGMENT = { address: VM, size: 0x80n };

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    length: bytes.length,
    bytes,
    u8: (o) => view.getUint8(o),
    u64: (o) => view.getBigUint64(o, true),
    uleb: (p, _max, end) => {
      let value = 0n; let shift = 0n; const start = p;
      while (p < end && p - start < 10) {
        const b = bytes[p++]; value |= BigInt(b & 0x7f) << shift;
        if (!(b & 0x80)) return { value, next: p };
        shift += 7n;
      }
      throw new Error('truncated uleb');
    },
    sleb: (p, _max, end) => ({ value: 0n, next: end }),
    slice: (p, n) => bytes.slice(p, p + n),
  };
}

function makeImage() {
  return {
    bits: 64,
    metadata: {},
    warnings: [],
    imports: [],
    libraries: ['libA.dylib'],
    addressToOffset(address) {
      return address >= VM && address < VM + SEGMENT.size ? (address - VM) + FILE : null;
    },
  };
}

// SET_DYLIB_ORDINAL_IMM 1; SET_SYMBOL "_foo"; THREADED SET_BIND_ORDINAL_TABLE_SIZE 1;
// DO_BIND (-> ordinal-table template 0); SET_SEGMENT_AND_OFFSET_ULEB seg 0 off 0;
// THREADED APPLY; DONE. Consumes 6 operations before the chain walk begins.
const STREAM = Uint8Array.from([
  0x11,
  0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00,
  0xd0, 0x01,
  0x90,
  0x70, 0x00,
  0xd1,
  0x00,
]);

// Build `nodeCount` delta=1, non-bind chain words followed by one delta=0 word
// that terminates the walk. Each word advances by one 8-byte slot inside the
// segment, so all addresses stay in mapped file data.
function chainBytes(nodeCount) {
  const bytes = new Uint8Array(0x200);
  bytes.set(STREAM, 0);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < nodeCount; i++) view.setBigUint64(Number(FILE) + i * 8, 1n << 51n, true); // delta 1, isBind 0
  view.setBigUint64(Number(FILE) + nodeCount * 8, 0n, true); // delta 0 -> APPLY terminates
  return bytes;
}

function run(nodeCount, operations) {
  const image = makeImage();
  const limits = { operations, inputBytes: 1_000_000, records: 1_000_000, objects: 1_000_000, stringBytes: 1_000_000, warnings: 1_000_000, estimatedHeapBytes: 1_000_000_000, wallClockMs: 1_000_000 };
  const budget = createMachOMetadataBudget(image, { limits });
  const status = parseClassicBindings(reader(chainBytes(nodeCount)), { offset: 0, size: STREAM.length }, image, [SEGMENT], 'bind', budget);
  return { image, budget, status };
}

test('#8853 delta-only threaded chain fails closed once per-node budget is charged', () => {
  // 7 chain nodes past the 6 setup operations exceed the 10-operation ceiling
  // only when each node charges. Pre-fix the walk charges nothing and the chain
  // reaches its delta-0 terminator, falsely publishing complete:true.
  const { image, status } = run(7, 10);
  assert.equal(status.complete, false, 'budget exhaustion during the walk must make the stream partial');
  assert.equal(status.threadedApplies, 0, 'an unbudgeted chain must not claim a completed APPLY');
  assert.equal(image.imports.length, 0, 'a fail-closed walk must not mint any bind/import');
  assert.equal(image.metadata.machoMetadata.complete, false, 'shared metadata must be marked partial');
  assert.ok(
    image.metadata.machoMetadata.reasons.some((r) => r.includes('classic-bind-threaded-walk')),
    `expected a budget:${'classic-bind-threaded-walk'} partial reason, got ${JSON.stringify(image.metadata.machoMetadata.reasons)}`,
  );
  assert.ok(
    image.warnings.some((w) => w.includes('walking threaded bind chain')),
    'exhausted walk must record a fail-closed warning',
  );
});

test('#8853 control: the same chain completes under an adequate operation budget', () => {
  // Guards against over-charging: a valid short threaded chain must still
  // decode fully when the aggregate ceiling is not the binding constraint.
  const { image, status } = run(7, 1_000_000);
  assert.equal(status.complete, true, 'a within-budget walk must complete');
  assert.equal(status.threadedApplies, 1, 'the delta-0 terminator completes exactly one APPLY');
  assert.equal(image.imports.length, 0, 'a pure-delta chain mints no binds');
  assert.equal(image.metadata.machoMetadata.complete, true);
});

console.log('issue #8853 Mach-O threaded APPLY per-node budget regressions: PASS');
