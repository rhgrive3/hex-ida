import assert from 'node:assert/strict';
import { openBinary, openBinarySource } from '../../../js/binary/index.js';
import { parseAarch64GnuProperty } from '../../../js/binary/elf-gnu-property.js';
import { parseSourceRanges } from '../../../js/binary/source-reader.js';
import { parseELF } from '../../../js/binary/elf-loader.js';

// Issue #5006: parseSourceRanges() hands parsers a SparseByteBuffer
// (`__binaryByteBacking`) input, but parseAarch64GnuProperty() only accepted
// Uint8Array/typed views/ArrayBuffer. The core ELF parser read the same
// backing fine, so every source-backed AArch64 ELF parse lost its BTI/PAC
// GNU-property evidence (`unavailable`) purely because of the input type.

const PT_GNU_PROPERTY = 0x6474e553;
const NT_GNU_PROPERTY_TYPE_0 = 5;
const FEATURE_1_AND = 0xc0000000;
const FEATURE_1_BTI = 1;
const FEATURE_1_PAC = 2;

function makeAarch64PropertyElf({ featureBits = FEATURE_1_BTI } = {}) {
  const noteOffset = 0x100;
  const noteSize = 32;
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, x >>> 0, true);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 3, true);
  view.setUint16(18, 183, true); // EM_AARCH64
  view.setUint32(20, 1, true);
  view.setUint16(52, 64, true);
  view.setBigUint64(32, 0x40n, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 1, true);
  u32(0x40, PT_GNU_PROPERTY);
  view.setBigUint64(0x48, BigInt(noteOffset), true);
  view.setBigUint64(0x60, BigInt(noteSize), true);
  view.setBigUint64(0x70, 8n, true); // p_align: ELF64_GNU_PROPERTY_ALIGN
  u32(noteOffset, 4);
  u32(noteOffset + 4, 16);
  u32(noteOffset + 8, NT_GNU_PROPERTY_TYPE_0);
  bytes.set([0x47, 0x4e, 0x55, 0x00], noteOffset + 12);
  u32(noteOffset + 16, FEATURE_1_AND);
  u32(noteOffset + 20, 4);
  u32(noteOffset + 24, featureBits);
  return bytes;
}

class StubSource {
  constructor(bytes) {
    this.bytes = bytes;
    this.size = BigInt(bytes.length);
  }
  async read(offset, length) {
    const start = Number(offset);
    return this.bytes.subarray(start, start + length);
  }
}

const elfBytes = makeAarch64PropertyElf();

// Reference: the dense path keeps working and mints the BTI evidence.
{
  const image = openBinary(elfBytes);
  assert.equal(image.format, 'elf');
  assert.equal(image.arch, 'arm64');
  assert.equal(image.metadata.arm64Bti.loaderPolicy, 'bti-requested');
  assert.equal(image.metadata.arm64Bti.btiRequested, true);
}

// A direct sparse backing must be parsed, not rejected as unavailable.
{
  const image = await openBinarySource(new StubSource(elfBytes), { ranges: { pageSize: 128 } });
  assert.equal(image.metadata.sourceBacked, true);
  assert.equal(image.metadata.arm64Bti.loaderPolicy, 'bti-requested');
  assert.equal(image.metadata.arm64Bti.btiRequested, true);
  assert.equal(image.metadata.arm64Bti.evidence.length, 1);
}

// PAC-bit parity: the issue requires the source-backed path to carry the
// PAC request through exactly like the dense path. The property note sets
// FEATURE_1_PAC only, so both paths must agree on `pacRequested` while BTI
// stays unset.
{
  const pacBytes = makeAarch64PropertyElf({ featureBits: FEATURE_1_BTI | FEATURE_1_PAC });
  const dense = openBinary(pacBytes);
  assert.equal(dense.metadata.arm64Bti.loaderPolicy, 'bti-requested');
  assert.equal(dense.metadata.arm64Bti.btiRequested, true);
  assert.equal(dense.metadata.arm64Bti.pacRequested, true);

  const sparse = await openBinarySource(new StubSource(pacBytes), { ranges: { pageSize: 128 } });
  assert.equal(sparse.metadata.sourceBacked, true);
  assert.equal(sparse.metadata.arm64Bti.loaderPolicy, dense.metadata.arm64Bti.loaderPolicy);
  assert.equal(sparse.metadata.arm64Bti.btiRequested, true);
  assert.equal(sparse.metadata.arm64Bti.pacRequested, true);
  assert.equal(sparse.metadata.arm64Bti.featureBits, dense.metadata.arm64Bti.featureBits);
  assert.deepEqual(sparse.metadata.arm64Bti.evidence, dense.metadata.arm64Bti.evidence);
}

// The sparse path must stay bounded: only ranges the parser actually needs
// are cached; a fixture whose property note sits past the first page forces
// a refetch, and the result must match the dense parse.
{
  let sparse = null;
  let passes = 0;
  const image = await parseSourceRanges(
    {
      size: BigInt(elfBytes.length),
      maxReadLength: 4096,
      async read(offset, length) {
        const start = Number(offset);
        return elfBytes.subarray(start, start + length);
      },
      async readExactly(offset, length) {
        return this.read(offset, length);
      },
    },
    (backing) => {
      passes++;
      sparse = backing;
      const firstPage = backing.subarray(0n, 128n);
      assert.equal(firstPage.length, 128);
      return parseELF(backing);
    },
    {},
    { pageSize: 128, maxPageSize: 128, maxCachedBytes: 64 * 1024 },
  );
  assert.ok(passes >= 2, 'property note past the first page must trigger a bounded refetch');
  const result = parseAarch64GnuProperty(sparse);
  assert.equal(result.loaderPolicy, 'bti-requested');
  assert.equal(result.btiRequested, true);
  assert.equal(result.evidence[0].fileOffset, 0x110);
  assert.equal(image.metadata.arm64Bti.btiRequested, true);
}

console.log('issue #5006 source-backed AArch64 GNU property regression: PASS');
