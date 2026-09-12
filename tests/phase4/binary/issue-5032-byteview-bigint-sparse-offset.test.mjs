import assert from 'node:assert/strict';
import { ByteSource } from '../../../js/binary/source.js';
import { ByteView, BinaryReadError } from '../../../js/binary/reader.js';
import { SparseByteBuffer, parseSourceRanges } from '../../../js/binary/source-reader.js';

const HIGH = (1n << 53n) + 1n;
const payload = Uint8Array.of(
  0x7f,
  0x34, 0x12,
  0xef, 0xcd, 0xab, 0x89,
  0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
  0x48, 0x69, 0x00,
  0xac, 0x02,
  0x7e,
);

function sparseFixture() {
  const sparse = new SparseByteBuffer(HIGH + BigInt(payload.length));
  sparse.add(HIGH, payload);
  return { sparse, view: new ByteView(sparse, { littleEndian: true }) };
}

{
  const { sparse, view } = sparseFixture();
  assert.deepEqual([...sparse.subarray(HIGH, HIGH + 4n)], [0x7f, 0x34, 0x12, 0xef], 'SparseByteBuffer control must retain the high range exactly');
  assert.equal(view.check(HIGH, 1), HIGH, 'ByteView must preserve a high sparse coordinate');
  assert.equal(view.u8(HIGH), 0x7f);
  assert.equal(view.u16(HIGH + 1n), 0x1234);
  assert.equal(view.u32(HIGH + 3n), 0x89abcdef);
  assert.equal(view.u64(HIGH + 7n), 0x0102030405060708n);
  assert.deepEqual([...view.slice(HIGH + 1n, 2)], [0x34, 0x12]);

  const child = view.subview(HIGH + 3n, 4);
  assert.equal(child.base, HIGH + 3n);
  assert.equal(child.u32(0), 0x89abcdef);
  assert.equal(view.cstring(HIGH + 15n, 8), 'Hi');

  const uleb = view.uleb(HIGH + 18n, 10, HIGH + 20n);
  assert.deepEqual(uleb, { value: 300n, next: HIGH + 20n, bytes: 2 });
  const sleb = view.sleb(HIGH + 20n, 10, HIGH + 21n);
  assert.deepEqual(sleb, { value: -2n, next: HIGH + 21n, bytes: 1 });
}

{
  const safeEdge = BigInt(Number.MAX_SAFE_INTEGER);
  const sparse = new SparseByteBuffer(safeEdge + 1n);
  sparse.add(safeEdge, Uint8Array.of(0x5a));
  const view = new ByteView(sparse);
  assert.equal(view.u8(safeEdge), 0x5a, 'a read starting at MAX_SAFE_INTEGER may end above the Number-safe coordinate domain');
  assert.deepEqual([...view.slice(safeEdge, 1)], [0x5a]);
  const child = view.subview(safeEdge);
  assert.equal(child.base, safeEdge);
  assert.equal(child.u8(0), 0x5a);
}

{
  const { view } = sparseFixture();
  const atEnd = HIGH + BigInt(payload.length);
  assert.throws(
    () => view.u8(atEnd),
    (error) => error instanceof BinaryReadError
      && error.offset === atEnd
      && error.message.includes(`0x${atEnd.toString(16)}`),
    'high sparse range failures must retain the true global offset',
  );

  const resident = new ByteView(Uint8Array.of(0x42));
  assert.throws(() => resident.u8(HIGH), BinaryReadError, 'resident backing must retain its bounded index contract');
  assert.equal(resident.u8(0), 0x42);

  const lowLeb = new ByteView(Uint8Array.of(0xac, 0x02, 0x7e));
  assert.deepEqual(lowLeb.uleb(0, 10, 2), { value: 300n, next: 2, bytes: 2 }, 'normal ULEB coordinates must stay numeric');
  assert.deepEqual(lowLeb.sleb(2, 10, 3), { value: -2n, next: 3, bytes: 1 }, 'normal SLEB coordinates must stay numeric');
}

{
  class HighOffsetSource extends ByteSource {
    constructor() {
      super(HIGH + 4n, { maxReadLength: 4 });
      this.reads = [];
    }
    async read(offset, length) {
      const range = this.validateRange(offset, length);
      this.reads.push({ offset: range.offset, length: range.length });
      if (range.offset === HIGH && range.length === 4) return Uint8Array.of(0x78, 0x56, 0x34, 0x12);
      return new Uint8Array(range.length);
    }
  }

  const source = new HighOffsetSource();
  const image = await parseSourceRanges(
    source,
    (backing) => {
      const reader = new ByteView(backing, { littleEndian: true });
      return {
        metadata: { marker: reader.u32(HIGH) },
        attachSource(attached) { this.source = attached; },
      };
    },
    {},
    { pageSize: 4, maxPageSize: 4, maxCachedBytes: 16, maxReads: 4 },
  );

  assert.equal(image.metadata.marker, 0x12345678);
  assert.deepEqual(source.reads, [{ offset: HIGH, length: 4 }], 'cache restart must request the true high source coordinate');
  assert.equal(image.metadata.sourceReads.requests, 1);
  assert.equal(image.metadata.sourceReads.cachedBytes, 4);
}

console.log('issue-5032-byteview-bigint-sparse-offset: PASS');
