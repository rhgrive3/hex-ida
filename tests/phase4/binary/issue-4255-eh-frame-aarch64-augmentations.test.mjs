import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ByteView } from '../../../js/binary/reader.js';
import { BinaryImage } from '../../../js/binary/model.js';
import { openBinary } from '../../../js/binary/index.js';
import { parseEhFrameHeader } from '../../../js/binary/elf-unwind.js';

// Issue #4255: parseCie()'s CIE augmentation allowlist covered only the
// standard L/R/P/S letters, so a GNU AArch64 `.cfi_b_key_frame` CIE
// (augmentation `zRB`, PAC B-key) was rejected as unsupported and its FDEs
// were dropped. GAS also emits `G` for `.cfi_mte_tagged_frame`; both are
// AArch64 target-specific markers with no augmentation data. Other targets
// keep failing closed on them.

const HEADER_ADDR = 0x3000n;
const TEXT_ADDR = 0x1000n;
const EH_FRAME_ADDR = 0x2000n;
const EH_FRAME_OFFSET = 0x100;

function makeFixture({ augmentation, arch }) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  const u8 = (o, x) => view.setUint8(o, x);
  const u32 = (o, x) => view.setUint32(o, Number(BigInt(x) & 0xffffffffn), true);

  // .eh_frame_hdr: version, eh_frame_ptr_enc, fde_count_enc, table_enc,
  // eh_frame_ptr, fde_count, one (initial, fde) row.
  let p = 0;
  u8(p++, 1); u8(p++, 0x03); u8(p++, 0x03); u8(p++, 0x03);
  u32(p, EH_FRAME_ADDR); p += 4;
  u32(p, 1); p += 4;
  u32(p, 0x1010); p += 4;
  u32(p, EH_FRAME_ADDR + 0x20n); p += 4;

  // CIE: version 1, `z<R><markers>`, uleb(1) code align, sleb(-8) data align,
  // uleb(30) return-address register, augLength=1 holding the R encoding 0x03.
  p = EH_FRAME_OFFSET;
  const cieAug = [...augmentation].map((c) => c.charCodeAt(0));
  const cieBody = [0x01, ...cieAug, 0x00, 0x01, 0x78, 30, 0x01, 0x03];
  u32(p, cieBody.length + 4); p += 4;
  u32(p, 0); p += 4;
  for (const b of cieBody) u8(p++, b);

  // FDE at EH_FRAME offset 0x20: CIE pointer (backwards from the field),
  // initial location 0x1010, range 0x20, one no-op CFA advance.
  const fdeOff = EH_FRAME_OFFSET + 0x20;
  p = fdeOff;
  u32(p, 13); p += 4;
  u32(p, fdeOff + 4 - EH_FRAME_OFFSET); p += 4;
  u32(p, 0x1010); p += 4;
  u32(p, 0x20); p += 4;
  u8(p++, 0);

  const image = new BinaryImage(bytes, { format: 'elf', arch, bits: 64, metadata: {} });
  image.addSection({ name: '.text', address: TEXT_ADDR, size: 0x80n, fileOffset: 0x80n, fileSize: 0x80n, perms: { read: true, execute: true } });
  image.addSection({ name: '.eh_frame', address: EH_FRAME_ADDR, size: 0x100n, fileOffset: BigInt(EH_FRAME_OFFSET), fileSize: 0x100n, perms: { read: true } });
  return {
    r: new ByteView(bytes, { littleEndian: true }),
    image,
    header: { name: '.eh_frame_hdr', addr: HEADER_ADDR, offset: 0n, size: 0x40n },
  };
}

function parse(options) {
  const fixture = makeFixture(options);
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, null);
  return fixture.image;
}

// B-key PAC frames recover their verified FDE seeds on arm64.
{
  for (const augmentation of ['zRB', 'zRG', 'zRBG', 'zBR', 'zR']) {
    const image = parse({ augmentation, arch: 'arm64' });
    assert.equal(image.functions.length, 1, `${augmentation}: B/G CIE must recover its FDE`);
    assert.equal(image.functions[0].address, 0x1010n);
    assert.equal(image.functions[0].source, 'unwind');
    assert.equal(image.functions[0].functionStartEvidence?.verified, true);
    assert.equal(image.metadata.ehFrameHeader.validation, 'verified');
    assert.equal(image.metadata.ehFrameHeader.validatedEntries, 1);
  }
}

// Unknown and non-AArch64 target-specific augmentations still fail closed.
{
  const unknown = parse({ augmentation: 'zRX', arch: 'arm64' });
  assert.equal(unknown.functions.length, 0);
  assert.equal(unknown.metadata.ehFrameHeader.validation, 'partial');
  assert.match(unknown.warnings[0], /unsupported CIE augmentation 'X'/);
}

{
  const x86 = parse({ augmentation: 'zRB', arch: 'x86_64' });
  assert.equal(x86.functions.length, 0, 'B stays unsupported off AArch64');
  assert.match(x86.warnings[0], /unsupported CIE augmentation 'B'/);

  const riscv = parse({ augmentation: 'zRG', arch: 'riscv64' });
  assert.equal(riscv.functions.length, 0, 'G stays unsupported off AArch64');
  assert.match(riscv.warnings[0], /unsupported CIE augmentation 'G'/);
}

// Real GNU-toolchain fixture: binutils 2.38 aarch64-linux-gnu-as + ld
// --eh-frame-hdr over a `.cfi_b_key_frame` CIE (`zRB`, PAC B-key). The
// checked-in binary carries a real `.eh_frame_hdr` table; provenance and the
// regeneration recipe live next to it in
// fixtures/issue-4255-gnu-b-key-cfi.s. Pre-fix, the CIE was rejected and the
// FDE dropped, so the hdr table validated zero entries and the function lost
// its unwind corroboration.
{
  const elfBytes = readFileSync(fileURLToPath(new URL(
    './fixtures/issue-4255-gnu-b-key-cfi.elf',
    import.meta.url,
  )));
  const image = openBinary(elfBytes);
  assert.equal(image.format, 'elf');
  assert.equal(image.arch, 'arm64');
  const hdr = image.metadata.ehFrameHeader;
  assert.equal(hdr.version, 1);
  assert.equal(hdr.declaredFunctions, 1);
  assert.equal(hdr.recoveredFunctions, 1, 'B-key CIE FDE must seed the hdr table');
  assert.equal(hdr.validatedEntries, 1);
  assert.equal(hdr.invalidEntries, 0);
  assert.equal(hdr.tableComplete, true);
  assert.equal(hdr.validation, 'verified');
  const fn = image.functions.find((candidate) => candidate.address === 0x4000b0n);
  assert.ok(fn, 'verified function seed at the FDE initial location');
  assert.ok(
    fn.sources.includes('unwind'),
    'unwind must corroborate the function recovered through .eh_frame_hdr',
  );
}

console.log('issue #4255 AArch64 CIE B/G augmentations regression: PASS');
