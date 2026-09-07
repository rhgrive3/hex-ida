/**
 * Issue #6303 regression: classic bind symbol C-strings (variable length) must
 * be charged to the shared metadata budget — inputBytes for the raw bytes,
 * stringBytes for the decoded retained symbol — so a crafted stream cannot
 * route resident metadata past the declared stringBytes ceiling while still
 * publishing `complete: true`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseClassicBindings } from '../js/binary/macho-dyld.js';
import { createMachOMetadataBudget } from '../js/binary/macho-budget.js';

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const leb = (p, end) => {
    let value = 0n;
    let shift = 0n;
    const start = p;
    while (p < end && p - start < 10) {
      const b = bytes[p++];
      value |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return { value, next: p };
      shift += 7n;
    }
    throw new Error('truncated uleb');
  };
  return {
    length: bytes.length,
    bytes,
    u8: (o) => view.getUint8(o),
    u64: (o) => view.getBigUint64(o, true),
    uleb: (p, _max, end) => leb(p, end),
    sleb: (p, _max, end) => leb(p, end),
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
      return address >= 0x1000n && address < 0x1080n ? address - 0x1000n : null;
    },
  };
}

const SEGMENT = { address: 0x1000n, size: 0x80n };

// SET_SYMBOL_TRAILING_FLAGS_IMM "ab"; SET_SEGMENT_AND_OFFSET_ULEB seg=0 off=0; DO_BIND; DONE
const STREAM_AB = Uint8Array.from([0x40, 0x61, 0x62, 0x00, 0x70, 0x00, 0x90, 0x00]);

test('#6303 symbol string under a 1-byte stringBytes budget fails closed', () => {
  const image = makeImage();
  const budget = createMachOMetadataBudget(image, { limits: { stringBytes: 1, inputBytes: 1024, records: 100, objects: 100, operations: 100, warnings: 100, estimatedHeapBytes: 1024 * 1024, wallClockMs: 1000 } });
  const status = parseClassicBindings(reader(Uint8Array.from(STREAM_AB)), { offset: 0, size: STREAM_AB.length }, image, [SEGMENT], 'bind', budget);
  assert.equal(status.complete, false, 'stream must not publish as complete past the string budget');
  assert.equal(image.metadata.dyldBindings.complete, false);
  assert.ok(image.metadata.machoMetadata.complete === false);
  assert.ok(image.warnings.some((w) => w.includes('budget exhausted while decoding bind symbol')));
});

test('#6303 adequate budget keeps the existing bind result', () => {
  const image = makeImage();
  const budget = createMachOMetadataBudget(image, { limits: { stringBytes: 1024, inputBytes: 1024, records: 100, objects: 100, operations: 100, warnings: 100, estimatedHeapBytes: 1024 * 1024, wallClockMs: 1000 } });
  const status = parseClassicBindings(reader(Uint8Array.from(STREAM_AB)), { offset: 0, size: STREAM_AB.length }, image, [SEGMENT], 'bind', budget);
  assert.equal(status.complete, true);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].name, 'ab');
  // 4 raw stream bytes for the C-string (2 chars + NUL + opcode byte already
  // counted) plus the decoded string cost show up in the accounting.
  assert.ok(budget.used.inputBytes >= 4, 'symbol C-string bytes are charged to inputBytes');
  assert.ok(budget.used.stringBytes >= 4, 'decoded symbol is charged to stringBytes');
});

test('#6303 retained import name is charged again on bind output', () => {
  const image = makeImage();
  const budget = createMachOMetadataBudget(image, { limits: { stringBytes: 9, inputBytes: 1024, records: 100, objects: 100, operations: 100, warnings: 100, estimatedHeapBytes: 1024 * 1024, wallClockMs: 1000 } });
  // symbol "ab" decode charges 4; the retained import name charges 4 more —
  // total 8 fits; a second bind of the same symbol would exceed 9.
  const stream = Uint8Array.from([0x40, 0x61, 0x62, 0x00, 0x70, 0x00, 0x90, 0x40, 0x61, 0x62, 0x00, 0x90, 0x00]);
  const status = parseClassicBindings(reader(stream), { offset: 0, size: stream.length }, image, [SEGMENT], 'bind', budget);
  assert.equal(status.complete, false, 'second retained name must exhaust the 9-byte string budget');
});

test('#6303 long symbol is bounded before resident retention', () => {
  const image = makeImage();
  const budget = createMachOMetadataBudget(image, { limits: { stringBytes: 16, inputBytes: 1024, records: 100, objects: 100, operations: 100, warnings: 100, estimatedHeapBytes: 1024 * 1024, wallClockMs: 1000 } });
  const name = '_sym'.repeat(10); // 40 chars
  const stream = new Uint8Array(1 + name.length + 1 + 2 + 1 + 1);
  stream[0] = 0x40;
  stream.set(Buffer.from(name, 'utf8'), 1);
  stream[1 + name.length] = 0x00;
  stream[2 + name.length] = 0x70;
  stream[3 + name.length] = 0x00;
  stream[4 + name.length] = 0x90;
  stream[5 + name.length] = 0x00;
  const status = parseClassicBindings(reader(stream), { offset: 0, size: stream.length }, image, [SEGMENT], 'bind', budget);
  assert.equal(status.complete, false);
  assert.equal(image.imports.length, 0, 'no resident metadata is retained past the ceiling');
});

test('#6303 shared accounting applies to lazy-bind streams too', () => {
  const image = makeImage();
  const budget = createMachOMetadataBudget(image, { limits: { stringBytes: 1, inputBytes: 1024, records: 100, objects: 100, operations: 100, warnings: 100, estimatedHeapBytes: 1024 * 1024, wallClockMs: 1000 } });
  const status = parseClassicBindings(reader(Uint8Array.from(STREAM_AB)), { offset: 0, size: STREAM_AB.length }, image, [SEGMENT], 'lazy-bind', budget);
  assert.equal(status.complete, false);
});
