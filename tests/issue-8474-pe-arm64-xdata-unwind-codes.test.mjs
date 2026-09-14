import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import {
  createPEMetadataBudget,
  parseExceptionFunctions,
} from '../js/binary/pe-loader-core.js';

const IMAGE_BASE = 0x180000000n;
const SECTION_RVA = 0x1000;
const FILE_OFFSET = 0x100;
const PDATA_RVA = 0x1040;
const XDATA_RVA = 0x1080;
const BEGIN_RVA = 0x1100;
const ARM64 = 0xaa64;
const ARM64EC = 0xa641;

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(offset, value >>> 0, true);
}

function makeImage() {
  const section = {
    index: 1,
    address: IMAGE_BASE + BigInt(SECTION_RVA),
    size: 0x1000n,
    fileOffset: BigInt(FILE_OFFSET),
    fileSize: 0x500n,
    perms: { read: true, write: false, execute: true },
  };
  return {
    imageBase: IMAGE_BASE,
    bits: 64,
    sections: [section],
    segments: [],
    metadata: {},
    warnings: [],
    functions: [],
    imports: [],
    exports: [],
    relocations: [],
    libraries: [],
    sectionAt(address) {
      const a = BigInt(address);
      return a >= section.address && a < section.address + section.size ? section : null;
    },
  };
}

function fullHeader({ epilogCount = 0, codeWords = 1, packedEpilog = false } = {}) {
  return (
    4 |
    (packedEpilog ? (1 << 21) : 0) |
    ((epilogCount & 0x1f) << 22) |
    ((codeWords & 0x1f) << 27)
  ) >>> 0;
}

function scopeWord(epilogStartIndex, startOffset = 0) {
  return (((epilogStartIndex & 0x3ff) << 22) | (startOffset & 0x3ffff)) >>> 0;
}

function run({
  code = [0xe4],
  codeWords = Math.ceil(code.length / 4),
  epilogStarts = [],
  packedEpilogIndex = null,
  extension = false,
  machine = ARM64,
  metadataLimits = null,
  padding = [],
} = {}) {
  const bytes = new Uint8Array(FILE_OFFSET + 0x500);
  const at = (rva) => FILE_OFFSET + (rva - SECTION_RVA);
  writeU32(bytes, at(PDATA_RVA), BEGIN_RVA);
  writeU32(bytes, at(PDATA_RVA) + 4, XDATA_RVA);

  let p = at(XDATA_RVA);
  const packed = packedEpilogIndex != null;
  let header;
  if (extension) {
    header = (4 | (packed ? (1 << 21) : 0)) >>> 0;
  } else {
    const countOrIndex = packed ? packedEpilogIndex : epilogStarts.length;
    header = fullHeader({ epilogCount: countOrIndex, codeWords, packedEpilog: packed });
  }
  writeU32(bytes, p, header);
  p += 4;

  if (extension) {
    const countOrIndex = packed ? packedEpilogIndex : epilogStarts.length;
    writeU32(bytes, p, ((codeWords & 0xff) << 16) | (countOrIndex & 0xffff));
    p += 4;
  }

  if (!packed) {
    for (const index of epilogStarts) {
      writeU32(bytes, p, scopeWord(index));
      p += 4;
    }
  }

  const declaredBytes = codeWords * 4;
  if (code.length > declaredBytes) throw new Error('test fixture code exceeds declared Code Words');
  bytes.set(code, p);
  if (padding.length) bytes.set(padding.slice(0, declaredBytes - code.length), p + code.length);

  const image = makeImage();
  const budget = metadataLimits == null
    ? null
    : createPEMetadataBudget(image, { limits: metadataLimits });
  parseExceptionFunctions(
    new ByteView(bytes),
    { rva: PDATA_RVA, size: 8 },
    image,
    machine,
    budget,
  );
  return image;
}

function reasons(image) {
  return image.metadata.peMetadata?.reasons || [];
}

function assertValid(image, label) {
  assert.equal(image.functions.length, 1, `${label}: valid unwind must seed exactly one function`);
  assert.equal(image.functions[0].address, IMAGE_BASE + BigInt(BEGIN_RVA), `${label}: function address`);
  assert.equal(image.metadata.exceptionDirectory?.count, 1, `${label}: exception count`);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 0, `${label}: invalid record count`);
  assert.equal(image.metadata.peMetadata?.complete, true, `${label}: metadata completeness`);
}

function assertInvalid(image, expectedReason, label) {
  assert.equal(image.functions.length, 0, `${label}: invalid unwind must not seed a function`);
  assert.equal(image.metadata.exceptionDirectory?.count, 0, `${label}: invalid record must not increment count`);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1, `${label}: invalid record count`);
  assert.equal(image.metadata.peMetadata?.complete, false, `${label}: metadata must be partial`);
  assert.equal(reasons(image).includes(`exception:${expectedReason}`), true,
    `${label}: missing reason exception:${expectedReason}; got ${JSON.stringify(reasons(image))}`);
}

// Ordinary terminator remains authoritative, and padding after the first
// reachable real `end` is not interpreted as extra unwind operations.
assertValid(run({ code: [0xe4], padding: [0xfd, 0xfe, 0xff] }), 'end + reserved-looking padding');

// Multi-byte opcodes must advance by their architecture-defined widths.
assertValid(run({ code: [0xc0, 0x00, 0xe4] }), 'alloc_m + end');
assertValid(run({ code: [0xe0, 0x00, 0x00, 0x00, 0xe4] }), 'alloc_l + end');
assertValid(run({ code: [0xe7, 0x00, 0x00, 0xe4] }), 'save_any_xreg + end');

// Architecturally reserved opcodes may never mint 0.995 exception evidence.
for (const opcode of [0xed, 0xee, 0xef, 0xf0, 0xf4, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfd, 0xfe, 0xff]) {
  assertInvalid(run({ code: [opcode] }), 'arm64-xdata-unwind-reserved', `reserved opcode 0x${opcode.toString(16)}`);
}

// save_any with bit 7 set in its second byte is explicitly reserved.
assertInvalid(run({ code: [0xe7, 0x80, 0x00, 0xe4] }), 'arm64-xdata-unwind-reserved', 'reserved save_any operand');

// A reachable multi-byte opcode cannot run past the declared code-word pool.
assertInvalid(run({ code: [0xe3, 0xe3, 0xe3, 0xe2] }), 'arm64-xdata-unwind-truncated', 'truncated add_fp');

// A declared code sequence must eventually reach a real `end`. `end_c` alone
// is not enough: it requires a following sequence that ultimately ends.
assertInvalid(run({ code: [0xe3, 0xe3, 0xe3, 0xe3] }), 'arm64-xdata-unwind-unterminated', 'missing end');
assertInvalid(run({ code: [0xe5, 0xe3, 0xe3, 0xe3] }), 'arm64-xdata-unwind-unterminated', 'end_c without real end');
assertValid(run({ code: [0xe5, 0xe3, 0xe4] }), 'end_c followed by real end');

// Scope indices are byte indices into the shared code pool and must name an
// opcode boundary. Index 1 below points into the payload byte of alloc_m.
assertInvalid(
  run({ code: [0xc0, 0x00, 0xe4], epilogStarts: [1] }),
  'arm64-xdata-unwind-index',
  'scope index in middle of opcode',
);
assertInvalid(
  run({ code: [0xe4], epilogStarts: [4] }),
  'arm64-xdata-unwind-index',
  'scope index outside pool',
);
assertValid(run({ code: [0xc0, 0x00, 0xe4], epilogStarts: [2] }), 'scope index at end opcode boundary');

// E=1 reuses the Epilog Count field as the sole epilog byte index and follows
// the same boundary/range contract without a scope-word array.
assertInvalid(
  run({ code: [0xc0, 0x00, 0xe4], packedEpilogIndex: 1 }),
  'arm64-xdata-unwind-index',
  'packed epilog index in middle of opcode',
);
assertValid(run({ code: [0xc0, 0x00, 0xe4], packedEpilogIndex: 2 }), 'packed epilog valid index');

// Extension-header form shares exactly the same code-stream authority.
assertInvalid(
  run({ code: [0xfd], extension: true }),
  'arm64-xdata-unwind-reserved',
  'extended-header reserved opcode',
);

// ARM64EC consumes the same Windows ARM64 unwind-code grammar.
assertInvalid(
  run({ code: [0xff], machine: ARM64EC }),
  'arm64-xdata-unwind-reserved',
  'ARM64EC reserved opcode',
);
assertValid(run({ code: [0xe4], machine: ARM64EC }), 'ARM64EC end');

// Semantic code-stream reads participate in the shared PE metadata budget.
{
  const image = run({
    code: [0xe4],
    metadataLimits: { inputBytes: 12 }, // 8-byte .pdata + 4-byte .xdata header only.
  });
  assert.equal(image.functions.length, 0, 'code-pool read must stop when input budget is exhausted');
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.equal(reasons(image).includes('budget:arm64-xdata-unwind-codes:inputBytes'), true,
    `missing unwind-code budget reason: ${JSON.stringify(reasons(image))}`);
}

console.log('issue #8474 PE ARM64 .xdata unwind-code validation regression: PASS');
