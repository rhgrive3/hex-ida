import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { BinaryImage } from '../js/binary/model.js';
import { parseEhFrameHeader } from '../js/binary/elf-unwind.js';

// Issue #4249: the .eh_frame_hdr function-seed promotion gate pinned RISC-V
// instruction alignment to 2 bytes even when exact ISA evidence
// (Tag_RISCV_arch without a compressed-instruction extension) says the
// target is 4-byte IALIGN. A 2-byte-only FDE initial location was promoted
// to a verified exact function start.

const HEADER_ADDR = 0x3000n;
const TEXT_ADDR = 0x1000n;
const EH_FRAME_ADDR = 0x2000n;
const EH_FRAME_OFFSET = 0x100;

function fileIsa({ compressed }) {
  return {
    canonical:compressed ? 'rv64imc2p1' : 'rv64i2p1',
    xlen:64,
    compressedInstructions:compressed,
    instructionAlignment:compressed ? 2 : 4,
    evidence:'elf-attribute',
  };
}

function makeFixture({ initial, riscvIsa }) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  const u8 = (o, x) => view.setUint8(o, x);
  const u32 = (o, x) => view.setUint32(o, Number(BigInt(x) & 0xffffffffn), true);

  let p = 0;
  u8(p++, 1); u8(p++, 0x03); u8(p++, 0x03); u8(p++, 0x03);
  u32(p, EH_FRAME_ADDR); p += 4;
  u32(p, 1); p += 4;
  u32(p, initial); p += 4;
  u32(p, EH_FRAME_ADDR + 0x20n); p += 4;

  p = EH_FRAME_OFFSET;
  const cieBody = [0x01, 0x7a, 0x52, 0x00, 0x01, 0x78, 30, 0x01, 0x03];
  u32(p, cieBody.length + 4); p += 4;
  u32(p, 0); p += 4;
  for (const b of cieBody) u8(p++, b);

  const fdeOff = EH_FRAME_OFFSET + 0x20;
  p = fdeOff;
  u32(p, 13); p += 4;
  u32(p, fdeOff + 4 - EH_FRAME_OFFSET); p += 4;
  u32(p, initial); p += 4;
  u32(p, 4); p += 4;
  u8(p++, 0);

  const image = new BinaryImage(bytes, { format:'elf', arch:'riscv64', bits:64, metadata:{} });
  if (riscvIsa !== undefined) image.metadata.riscvIsa = riscvIsa;
  image.addSection({ name:'.text', address:TEXT_ADDR, size:0x100n, fileOffset:0x80n, fileSize:0x100n, perms:{ read:true, execute:true } });
  image.addSection({ name:'.eh_frame', address:EH_FRAME_ADDR, size:0x100n, fileOffset:BigInt(EH_FRAME_OFFSET), fileSize:0x100n, perms:{ read:true } });
  return {
    r:new ByteView(bytes, { littleEndian:true }),
    image,
    header:{ name:'.eh_frame_hdr', addr:HEADER_ADDR, offset:0n, size:0x40n },
  };
}

function parse(options) {
  const fixture = makeFixture(options);
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, null);
  return fixture.image;
}

{
  const image = parse({ initial:0x1002, riscvIsa:{ file:fileIsa({ compressed:false }), mappings:[], sections:[], evidence:'elf-attribute' } });
  assert.equal(image.functions.length, 0, 'a 2-byte-only FDE must not be promoted on a 4-byte IALIGN RISC-V target');
  assert.equal(image.metadata.ehFrameHeader.recoveredFunctions, 0);
  assert.equal(image.metadata.ehFrameHeader.invalidEntries, 1);
  assert.ok(image.warnings.some((w) => /violates target instruction alignment/.test(w)), image.warnings.join('\n'));
}

{
  const image = parse({ initial:0x1004, riscvIsa:{ file:fileIsa({ compressed:false }), mappings:[], sections:[], evidence:'elf-attribute' } });
  assert.equal(image.functions.length, 1, 'a 4-byte-aligned FDE still seeds on a 4-byte IALIGN target');
  assert.equal(image.functions[0].address, 0x1004n);
  assert.equal(image.functions[0].functionStartEvidence?.verified, true);
}

{
  const image = parse({ initial:0x1002, riscvIsa:{ file:fileIsa({ compressed:true }), mappings:[], sections:[], evidence:'elf-attribute' } });
  assert.equal(image.functions.length, 1, 'a compressed RISC-V ISA keeps the 2-byte gate');
  assert.equal(image.functions[0].address, 0x1002n);
}

{
  const image = parse({ initial:0x1002 });
  assert.equal(image.functions.length, 1, 'without ISA evidence the assumed-rv64imc 2-byte fallback is preserved');
  assert.equal(image.functions[0].address, 0x1002n);
}

console.log('issue-4249: ok');
