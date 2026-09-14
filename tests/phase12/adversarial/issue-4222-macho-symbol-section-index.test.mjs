import assert from 'node:assert/strict';
import { parseMachO } from '../../../js/binary/macho.js';

function buildMachO(sectionIndex) {
  const symoff = 0x200;
  const stroff = 0x210;
  const stringBytes = Uint8Array.from([0, 0x66, 0x61, 0x6b, 0x65, 0]);
  const bytes = new Uint8Array(stroff + stringBytes.length);
  const view = new DataView(bytes.buffer);
  const u32 = (offset, value) => view.setUint32(offset, value >>> 0, true);
  const u64 = (offset, value) => view.setBigUint64(offset, BigInt(value), true);
  const put = (offset, text) => bytes.set(new TextEncoder().encode(text), offset);

  // mach_header_64: one real section plus one symbol-table command.
  u32(0, 0xfeedfacf);
  u32(4, 0x0100000c); // ARM64
  u32(8, 0);
  u32(12, 2); // MH_EXECUTE
  u32(16, 2); // ncmds
  u32(20, 176); // sizeofcmds: LC_SEGMENT_64 (152) + LC_SYMTAB (24)
  u32(24, 0);
  u32(28, 0);

  let p = 32;
  u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__TEXT');
  u64(p + 24, 0x1000); u64(p + 32, 0x1000);
  u64(p + 40, 0); u64(p + 48, 0x200);
  u32(p + 56, 5); u32(p + 60, 5); u32(p + 64, 1);
  const section = p + 72;
  put(section, '__text'); put(section + 16, '__TEXT');
  u64(section + 32, 0x1000); u64(section + 40, 4);
  u32(section + 48, 0x180); u32(section + 52, 2);
  u32(section + 64, 0x80000400); // S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS

  p += 152;
  u32(p, 0x2); u32(p + 4, 24);
  u32(p + 8, symoff); u32(p + 12, 1);
  u32(p + 16, stroff); u32(p + 20, stringBytes.length);

  bytes.set([0xc0, 0x03, 0x5f, 0xd6], 0x180); // ret
  u32(symoff, 1); // n_strx
  bytes[symoff + 4] = 0x0f; // N_SECT | N_EXT
  bytes[symoff + 5] = sectionIndex;
  u64(symoff + 8, 0x1000);
  bytes.set(stringBytes, stroff);
  return bytes;
}

{
  const image = parseMachO(buildMachO(1));
  assert.equal(image.symbols[0].name, 'fake');
  assert.equal(image.symbols[0].defined, true);
  assert.equal(image.exports[0].name, 'fake');
  assert.equal(image.metadata.machoMetadata.complete, true);
}

for (const sectionIndex of [0, 2, 0xff]) {
  const image = parseMachO(buildMachO(sectionIndex));
  assert.equal(image.symbols.length, 0);
  assert.equal(image.exports.length, 0);
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.metadata.machoMetadata.reasons.includes('symbol-section-index-out-of-range'));
  assert.ok(image.warnings.some((warning) => /n_sect .*parsed section/.test(warning)));
}

console.log('issue #4222 Mach-O symbol section-index validation: PASS');
