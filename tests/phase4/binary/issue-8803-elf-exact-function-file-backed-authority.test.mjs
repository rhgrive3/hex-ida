import test from 'node:test';
import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';
import { parseEhFrameHeader } from '../../../js/binary/elf-unwind.js';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { makeElf64Fixture } from '../../universal-binary.mjs';
import { makeSectionlessElf64Fixture } from '../../universal-binary-sectionless.mjs';

const EM_AARCH64 = 183;
const EM_X86_64 = 62;
const STT_FUNC = 2;
const STT_GNU_IFUNC = 10;
const SHT_PROGBITS = 1;
const SHT_NOBITS = 8;
const PH_RX = 0x40;
const TEXT_SEC = 0x280 + 64;
const SYM_ENTRY = 0x190;

function sectionBacked({
  machine = EM_AARCH64,
  elfType = 3,
  segmentFilesz = 0x10n,
  segmentMemsz = 0x100n,
  segmentVaddr = 0x401000n,
  textType = SHT_PROGBITS,
  textAddr = 0x401000n,
  value = 0x401000n,
  size = 4n,
  symbolType = STT_FUNC,
  entry = 0x401000n,
  shndx = null,
} = {}) {
  const bytes = makeElf64Fixture();
  const view = new DataView(bytes.buffer);
  view.setUint16(16, elfType, true);
  view.setUint16(18, machine, true);
  view.setBigUint64(24, entry, true);
  view.setBigUint64(PH_RX + 16, segmentVaddr, true);
  view.setBigUint64(PH_RX + 24, segmentVaddr, true);
  view.setBigUint64(PH_RX + 32, segmentFilesz, true);
  view.setBigUint64(PH_RX + 40, segmentMemsz, true);
  view.setUint32(TEXT_SEC + 4, textType, true);
  view.setBigUint64(TEXT_SEC + 16, textAddr, true);
  bytes[SYM_ENTRY + 4] = (1 << 4) | symbolType;
  if (shndx != null) view.setUint16(SYM_ENTRY + 6, shndx, true);
  view.setBigUint64(SYM_ENTRY + 8, value, true);
  view.setBigUint64(SYM_ENTRY + 16, size, true);
  return bytes;
}

function functionSeedAt(image, address, source = 'symbol') {
  return image.functions.find((fn) => fn.address === address && fn.source === source) ?? null;
}

function exactSeedsAt(image, address) {
  return image.functions.filter((fn) => fn.address === address && fn.exactFunctionStart === true);
}

function sectionlessCodeAt({ filesz = 0x10n, size = 4n, symbolType = STT_FUNC, value = 0x401000n } = {}) {
  const bytes = makeSectionlessElf64Fixture();
  const view = new DataView(bytes.buffer);
  view.setUint16(18, EM_AARCH64, true);
  view.setUint16(56, 3, true);
  const third = PH_RX + 112;
  view.setUint32(third, 1, true);
  view.setUint32(third + 4, 5, true);
  view.setBigUint64(third + 8, 0x184n, true);
  view.setBigUint64(third + 16, value, true);
  view.setBigUint64(third + 24, value, true);
  view.setBigUint64(third + 32, filesz, true);
  view.setBigUint64(third + 40, 0x100n, true);
  view.setBigUint64(third + 48, 4n, true);
  // The shared sectionless fixture carries an x86-64 JUMP_SLOT; AArch64 needs
  // R_AARCH64_JUMP_SLOT to stay structurally valid.
  view.setBigUint64(0x3a8, (1n << 32n) | 1026n, true);
  bytes[0x35c] = (1 << 4) | symbolType;
  view.setUint16(0x35e, 0xfff1, true);
  view.setBigUint64(0x360, value, true);
  view.setBigUint64(0x368, size, true);
  return bytes;
}

const HDR_ADDR = 0x3000n;
const CODE_ADDR = 0x1000n;
const EH_ADDR = 0x2000n;
const EH_OFF = 0x100;
const PERSONALITY_ADDR = 0x4000n;
const PERSONALITY_OFF = 0x280;

function unwindFixture({ executableCodeInFile = true } = {}) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const u8 = (off, value) => view.setUint8(off, value);
  const u32 = (off, value) => view.setUint32(off, Number(BigInt(value) & 0xffffffffn), true);

  u8(0, 1);
  u8(1, 0x03);
  u8(2, 0x03);
  u8(3, 0x03);
  u32(4, EH_ADDR);
  u32(8, 1);
  u32(12, 0x1010);
  u32(16, 0x2020);

  let p = EH_OFF;
  u32(p, 19); p += 4;
  u32(p, 0); p += 4;
  u8(p++, 1);
  u8(p++, 0x7a); u8(p++, 0x50); u8(p++, 0x52); u8(p++, 0);
  u8(p++, 1); u8(p++, 0x78); u8(p++, 30);
  u8(p++, 6);
  u8(p++, 0x83);
  u32(p, PERSONALITY_ADDR); p += 4;
  u8(p++, 0x03);

  p = EH_OFF + 0x20;
  u32(p, 13); p += 4;
  u32(p, 0x24); p += 4;
  u32(p, 0x1010n); p += 4;
  u32(p, 0x20n); p += 4;
  u8(p, 0);
  view.setBigUint64(PERSONALITY_OFF, 0x12345678n, true);

  const image = new BinaryImage(bytes, { format:'elf', arch:'x86_64', bits:64, endian:'little' });
  image.addSection({
    name:'.eh_frame_hdr', address:HDR_ADDR, size:0x40n, fileOffset:0n, fileSize:0x40n,
    perms:{ read:true, write:false, execute:false }, source:'ELF-section',
  });
  if (executableCodeInFile) {
    image.addSection({
      name:'.text', address:CODE_ADDR, size:0x80n, fileOffset:0x80n, fileSize:0x80n,
      perms:{ read:true, write:false, execute:true }, source:'ELF-section',
    });
  } else {
    image.addSegment({
      name:'LOAD-zero-fill', address:CODE_ADDR, size:0x80n, fileOffset:0x80n, fileSize:0n,
      perms:{ read:true, write:false, execute:true }, source:'PT_LOAD',
    });
  }
  image.addSection({
    name:'.eh_frame', address:EH_ADDR, size:0x100n, fileOffset:BigInt(EH_OFF), fileSize:0x100n,
    perms:{ read:true, write:false, execute:false }, source:'ELF-section',
  });
  image.addSegment({
    name:'LOAD-personality', address:PERSONALITY_ADDR, size:0x10n,
    fileOffset:BigInt(PERSONALITY_OFF), fileSize:0x10n,
    perms:{ read:true, write:false, execute:false }, source:'PT_LOAD',
  });
  parseEhFrameHeader(new ByteView(bytes, { littleEndian:true }),
    { addr:HDR_ADDR, offset:0n, size:0x40n }, image, 64, null);
  return { bytes, image };
}

function unwindSeedAt(image, address) {
  return image.functions.find((fn) => fn.address === address && fn.source === 'unwind') ?? null;
}

test('AArch64 section-backed STT_FUNC with a complete file-backed instruction keeps exact authority', () => {
  const image = parseELF(sectionBacked());
  const seed = functionSeedAt(image, 0x401000n);
  assert.ok(seed, 'canonical file-backed code still promotes');
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(seed.confidence, 0.995);
  assert.equal(seed.size, 4n);
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.deepEqual(image.metadata.elfMetadata.reasons, []);
});

test('AArch64 STT_FUNC whose first instruction is only partially file-backed cannot mint exact truth', () => {
  for (const backedBytes of [1n, 2n, 3n]) {
    const address = 0x401008n;
    const image = parseELF(sectionBacked({
      segmentFilesz: 8n + backedBytes,
      value: address,
      shndx: 0xfff1,
    }));
    assert.equal(image.symbols.find((symbol) => symbol.name === 'myfunc')?.address, address,
      'raw symbol stays in metadata');
    assert.deepEqual(exactSeedsAt(image, address), [], `${backedBytes} file-backed byte(s) must not promote`);
    assert.equal(image.metadata.elfMetadata.complete, false);
    assert.ok(image.metadata.elfMetadata.reasons.includes('symbols:3:function-authority'));
    assert.ok(image.warnings.some((warning) => warning.includes('myfunc') && warning.includes('not fully file-backed')),
      `expected a file-backing diagnostic for ${backedBytes} byte(s)`);
  }
});

test('executable SHT_NOBITS STT_FUNC keeps the raw symbol but never a 0.995 exact seed', () => {
  const image = parseELF(sectionBacked({ segmentFilesz: 0n, textType: SHT_NOBITS }));
  assert.equal(image.symbols.find((symbol) => symbol.name === 'myfunc')?.address, 0x401000n);
  assert.deepEqual(exactSeedsAt(image, 0x401000n), []);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('symbols:3:function-authority'));
});

test('STT_GNU_IFUNC resolver in a zero-fill extent cannot mint exact resolver truth', () => {
  const image = parseELF(sectionBacked({ segmentFilesz: 0n, textType: SHT_NOBITS, symbolType: STT_GNU_IFUNC }));
  assert.equal(image.symbols.find((symbol) => symbol.name === 'myfunc')?.kind, 'indirect-function');
  assert.deepEqual(exactSeedsAt(image, 0x401000n), []);
  assert.equal(image.metadata.elfMetadata.complete, false);
});

test('x86_64 byte-granular function starts remain compatible with a one-byte file-backed start', () => {
  const image = parseELF(sectionBacked({ machine: EM_X86_64, value: 0x40100bn, size: 4n }));
  const seed = functionSeedAt(image, 0x40100bn);
  assert.ok(seed);
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(image.metadata.elfMetadata.complete, true);
});

test('a published st_size crossing loader zero-fill loses extent authority but keeps its proven start', () => {
  const image = parseELF(sectionlessCodeAt({ filesz: 4n, size: 0x10n }));
  const seed = functionSeedAt(image, 0x401000n);
  assert.ok(seed, 'the four instruction-start bytes are file-backed, so the start claim survives');
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(seed.size, null, 'the zero-filled remainder must not be a validated body');
  assert.match(seed.functionStartEvidence, /st_size is not file-backed/);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics?.some((message) =>
    message.includes('puts') && message.includes('published function extent is not fully file-backed')));
});

test('sectionless PT_DYNAMIC STT_FUNC with only the first instruction byte file-backed is rejected', () => {
  const image = parseELF(sectionlessCodeAt({ filesz: 1n, size: 4n }));
  assert.equal(image.arch, 'arm64');
  assert.equal(image.symbols.find((symbol) => symbol.name === 'puts')?.address, 0x401000n);
  assert.deepEqual(exactSeedsAt(image, 0x401000n), []);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics?.some((message) =>
    message.includes('puts') && message.includes('not fully file-backed')));
});

test('sectionless PT_DYNAMIC STT_FUNC with a complete file-backed instruction keeps existing success', () => {
  const image = parseELF(sectionlessCodeAt({ filesz: 0x10n, size: 4n }));
  const seed = functionSeedAt(image, 0x401000n);
  assert.ok(seed);
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(seed.size, 4n);
  assert.equal(image.metadata.programDynamicPartial, undefined);
});

test('zero-address repair does not grant an address the shared policy rejects as zero-fill', () => {
  const bytes = sectionBacked({
    segmentFilesz: 0n,
    segmentMemsz: 0x10n,
    segmentVaddr: 0n,
    textType: SHT_NOBITS,
    textAddr: 0n,
    value: 0n,
    entry: 0n,
  });
  const image = parseELF(bytes);
  assert.equal(image.symbols.find((symbol) => symbol.name === 'myfunc')?.address, 0n);
  assert.deepEqual(exactSeedsAt(image, 0n), []);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('function-authority:va0-repair'));
  assert.ok(image.warnings.some((warning) => warning.includes('zero-address') && warning.includes('not fully file-backed')));
});

test('zero-address repair still recovers a genuinely file-backed VA 0 function', () => {
  const bytes = sectionBacked({
    segmentFilesz: 0x10n,
    segmentMemsz: 0x10n,
    segmentVaddr: 0n,
    textAddr: 0n,
    value: 0n,
    entry: 0n,
  });
  const image = parseELF(bytes);
  const seed = functionSeedAt(image, 0n);
  assert.ok(seed, 'file-backed VA 0 code remains recoverable');
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(image.metadata.elfMetadata.reasons.filter((reason) => reason.includes('va0-repair')).length, 0);
});

test('.eh_frame_hdr FDE pointing into loader zero-fill becomes a typed partial entry, not verified truth', () => {
  const zeroFill = unwindFixture({ executableCodeInFile:false });
  assert.notEqual(zeroFill.image.metadata.ehFrameHeader.validation, 'verified');
  assert.equal(zeroFill.image.metadata.ehFrameHeader.recoveredFunctions, 0);
  assert.equal(zeroFill.image.metadata.ehFrameHeader.invalidEntries, 1);
  assert.equal(unwindSeedAt(zeroFill.image, 0x1010n), null);
  assert.ok(zeroFill.image.warnings.some((warning) => warning.includes('not fully file-backed')));

  const fileBacked = unwindFixture({ executableCodeInFile:true });
  const seed = unwindSeedAt(fileBacked.image, 0x1010n);
  assert.ok(seed, 'a fully file-backed FDE target keeps its provenance');
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(seed.functionStartEvidence.verified, true);
  assert.equal(fileBacked.image.metadata.ehFrameHeader.validation, 'verified');
  assert.equal(fileBacked.image.metadata.ehFrameHeader.recoveredFunctions, 1);
});
