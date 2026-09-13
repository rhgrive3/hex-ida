import assert from 'node:assert/strict';
import test from 'node:test';
import { auditBinary } from '../../../js/binary/audit.js';

function makeMockImage({ segments = [], sections = [], functions = [] }) {
  return {
    segments,
    sections,
    functions,
    imports: [],
    exports: [],
    symbols: [],
    relocations: [],
    libraries: [],
    entrypoint: null,
    fileSize: 0x1000n,
    format: 'raw',
    arch: 'arm64',
    endian: 'little',
    bits: 64,
    sectionAt(addr) {
      return sections.find((s) => addr >= s.address && addr < s.address + s.size) || null;
    },
    segmentAt(addr) {
      return segments.find((s) => addr >= s.address && addr < s.address + s.size) || null;
    },
    addressToOffset(addr) {
      const seg = this.segmentAt(addr);
      return seg ? seg.fileOffset + (addr - seg.address) : null;
    },
    offsetToAddress(offset) {
      const seg = segments.find((s) => offset >= s.fileOffset && offset < s.fileOffset + s.fileSize);
      return seg ? seg.address + (offset - seg.fileOffset) : null;
    },
  };
}

test('issue #5407: auditBinary checks full extent of known-size functions', () => {
  const textSeg = {
    name: 'TEXT',
    address: 0x1000n,
    size: 0x10n,
    fileOffset: 0n,
    fileSize: 0x10n,
    perms: { read: true, write: false, execute: true },
  };

  // 1. Function start is in exec, but extent (size 0x20) crosses past end of textSeg into unmapped space
  const image1 = makeMockImage({
    segments: [textSeg],
    functions: [{ address: 0x1008n, size: 0x20n, source: 'symbol' }],
  });
  const audit1 = auditBinary(image1);
  assert.equal(audit1.stats.executableFunctions, 0, 'partially unmapped function must not count as executable');
  assert.equal(audit1.stats.unmappedFunctions, 1);
  assert.ok(audit1.issues.some((i) => i.code === 'function-outside-exec'), 'must emit function-outside-exec warning');

  // 2. Function is completely inside textSeg -> valid
  const image2 = makeMockImage({
    segments: [textSeg],
    functions: [{ address: 0x1000n, size: 0x10n, source: 'symbol' }],
  });
  const audit2 = auditBinary(image2);
  assert.equal(audit2.stats.executableFunctions, 1);
  assert.equal(audit2.stats.unmappedFunctions, 0);
  assert.ok(!audit2.issues.some((i) => i.code === 'function-outside-exec'));

  // 3. Two adjacent executable segments continuously cover the function -> valid
  const textSeg2 = {
    name: 'TEXT2',
    address: 0x1010n,
    size: 0x10n,
    fileOffset: 0x10n,
    fileSize: 0x10n,
    perms: { read: true, write: false, execute: true },
  };
  const image3 = makeMockImage({
    segments: [textSeg, textSeg2],
    functions: [{ address: 0x1008n, size: 0x10n, source: 'symbol' }],
  });
  const audit3 = auditBinary(image3);
  assert.equal(audit3.stats.executableFunctions, 1);
  assert.equal(audit3.stats.unmappedFunctions, 0);
  assert.ok(!audit3.issues.some((i) => i.code === 'function-outside-exec'));

  // 4. Function start in exec, but second half crosses into non-executable data segment -> invalid
  const dataSeg = {
    name: 'DATA',
    address: 0x1010n,
    size: 0x10n,
    fileOffset: 0x10n,
    fileSize: 0x10n,
    perms: { read: true, write: true, execute: false },
  };
  const image4 = makeMockImage({
    segments: [textSeg, dataSeg],
    functions: [{ address: 0x1008n, size: 0x10n, source: 'symbol' }],
  });
  const audit4 = auditBinary(image4);
  assert.equal(audit4.stats.executableFunctions, 0);
  assert.equal(audit4.stats.unmappedFunctions, 1);
  assert.ok(audit4.issues.some((i) => i.code === 'function-outside-exec'));

  // 5. Function with size === null -> falls back to checking start address
  const image5 = makeMockImage({
    segments: [textSeg],
    functions: [{ address: 0x1008n, size: null, source: 'symbol' }],
  });
  const audit5 = auditBinary(image5);
  assert.equal(audit5.stats.executableFunctions, 1);
  assert.equal(audit5.stats.unmappedFunctions, 0);
});
