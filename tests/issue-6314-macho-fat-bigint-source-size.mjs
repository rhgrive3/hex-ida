import test from 'node:test';
import assert from 'node:assert/strict';

import { ByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/source-loaders.js';

const CPU_X86_64 = 0x01000007;

class SparseByteSource extends ByteSource {
  constructor(size, segments) {
    super(size);
    this.segments = segments.map(({ offset, data }) => ({ offset: BigInt(offset), data }));
  }

  async read(offset, length) {
    const range = this.validateRange(offset, length);
    const out = new Uint8Array(range.length);
    const requestEnd = range.offset + BigInt(range.length);
    for (const segment of this.segments) {
      const segmentEnd = segment.offset + BigInt(segment.data.length);
      const start = range.offset > segment.offset ? range.offset : segment.offset;
      const end = requestEnd < segmentEnd ? requestEnd : segmentEnd;
      if (start >= end) continue;
      out.set(
        segment.data.subarray(Number(start - segment.offset), Number(end - segment.offset)),
        Number(start - range.offset),
      );
    }
    return out;
  }
}

function makeThinObject() {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64 LE
  view.setInt32(4, CPU_X86_64, true);
  view.setInt32(8, 3, true);
  view.setUint32(12, 1, true); // MH_OBJECT: no final-image page-alignment requirement
  view.setUint32(16, 0, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);
  return bytes;
}

function makeHugeFat64Source() {
  const totalSize = 9007199254740993n; // Number.MAX_SAFE_INTEGER + 2
  const thin = makeThinObject();
  const sliceOffset = totalSize - BigInt(thin.length);
  const header = new Uint8Array(40);
  const view = new DataView(header.buffer);
  header.set([0xca, 0xfe, 0xba, 0xbf], 0); // FAT_MAGIC_64 BE
  view.setUint32(4, 1, false);
  view.setInt32(8, CPU_X86_64, false);
  view.setInt32(12, 3, false);
  view.setBigUint64(16, sliceOffset, false);
  view.setBigUint64(24, BigInt(thin.length), false);
  view.setUint32(32, 0, false);
  view.setUint32(36, 0, false);
  return {
    source: new SparseByteSource(totalSize, [
      { offset: 0n, data: header },
      { offset: sliceOffset, data: thin },
    ]),
    sliceOffset,
    totalSize,
  };
}

test('#6314 source-backed FAT64 retains exact bounds above Number.MAX_SAFE_INTEGER', async () => {
  const { source, sliceOffset, totalSize } = makeHugeFat64Source();
  assert.equal(source.size, totalSize);

  const image = await parseMachOSource(source);
  assert.equal(image.metadata.fat.selected.offset, sliceOffset);
  assert.equal(image.metadata.fat.selected.size, 64n);
  assert.equal(image.arch, 'x86_64');
});
