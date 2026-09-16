/**
 * #8962 — a file-backed Mach-O section must not claim different physical bytes
 * than its parent segment maps at the same virtual address. Independent
 * containment (section VM within segment VM AND section file within segment
 * file) let a contradictory section shadow the segment via BinaryImage's
 * narrower-mapping precedence (#970), so `addressToOffset()` / `LC_MAIN`
 * resolved to bytes the format did not assign there. The canonical parser must
 * fail closed (exclude the contradictory section from mapping authority with an
 * explicit incomplete status) instead of publishing the contradiction.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMachO } from '../../../js/binary/macho.js';

const SEG_VM = 0x100000000n;
const SEG_FILEOFF = 0n;
const SECTION_ADDR = SEG_VM + 0x40n; // parent maps this VM to file byte 0x40.

// __TEXT vmaddr/size = SEG_VM/0x1000, fileoff/filesize = 0/0x200, one S_REGULAR
// __text section whose (addr, fileOffset) pair is supplied by the caller.
function buildMachO({ sectionAddr, sectionFileOffset }) {
  const bytes = new Uint8Array(0x220);
  const view = new DataView(bytes.buffer);
  const u32 = (o, v) => view.setUint32(o, v >>> 0, true);
  const u64 = (o, v) => view.setBigUint64(o, BigInt(v), true);
  const put = (o, text) => bytes.set(new TextEncoder().encode(text), o);

  u32(0, 0xfeedfacf); // mach_header_64 (ARM64)
  u32(4, 0x0100000c);
  u32(8, 0);
  u32(12, 2); // MH_DYLIB
  u32(16, 1); // ncmds
  u32(20, 152); // sizeofcmds: LC_SEGMENT_64 (72) + one section (80)
  u32(24, 0);
  u32(28, 0);

  let p = 32; // LC_SEGMENT_64
  u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__TEXT');
  u64(p + 24, SEG_VM); u64(p + 32, 0x1000);
  u64(p + 40, SEG_FILEOFF); u64(p + 48, 0x200);
  u32(p + 56, 5); u32(p + 60, 5); u32(p + 64, 1);
  const section = p + 72;
  put(section, '__text'); put(section + 16, '__TEXT');
  u64(section + 32, sectionAddr); u64(section + 40, 4);
  u32(section + 48, sectionFileOffset);
  u32(section + 64, 0x80000400); // S_REGULAR | S_ATTR_PURE_INSTRUCTIONS
  return bytes;
}

test('#8962 delta-consistent file-backed section is published complete', () => {
  // Parent maps SECTION_ADDR -> 0x40; the section agrees (fileOffset 0x40).
  const image = parseMachO(buildMachO({ sectionAddr: SECTION_ADDR, sectionFileOffset: 0x40 }));
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.sections.length, 1);
  assert.equal(image.sections[0].fileOffset, 0x40n);
  assert.equal(image.addressToOffset(SECTION_ADDR), 0x40n);
});

test('#8962 section claiming different bytes than its parent segment is failed closed', () => {
  // Parent maps SECTION_ADDR -> 0x40, but the section claims fileOffset 0x100.
  const image = parseMachO(buildMachO({ sectionAddr: SECTION_ADDR, sectionFileOffset: 0x100 }));
  // Contradiction is explicit, not laundered into a complete artifact.
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(image.warnings.some((w) => /contradicts parent segment/.test(w)));
  // The contradictory section is excluded from canonical mapping authority.
  assert.equal(image.sections.length, 0);
  // Virtual reads resolve via the parent segment's provenance, NOT the section's
  // claimed bytes: this is the security property #8962 requires.
  assert.equal(image.addressToOffset(SECTION_ADDR), 0x40n);
});

test('#8962 zero-fill section is exempt from the parent-delta proof', () => {
  const bytes = new Uint8Array(0x200);
  const view = new DataView(bytes.buffer);
  const u32 = (o, v) => view.setUint32(o, v >>> 0, true);
  const u64 = (o, v) => view.setBigUint64(o, BigInt(v), true);
  const put = (o, text) => bytes.set(new TextEncoder().encode(text), o);
  u32(0, 0xfeedfacf); u32(4, 0x0100000c); u32(8, 0); u32(12, 2);
  u32(16, 1); u32(20, 152); u32(24, 0); u32(28, 0);
  let p = 32;
  u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__DATA');
  u64(p + 24, SEG_VM); u64(p + 32, 0x1000); u64(p + 40, 0); u64(p + 48, 0);
  u32(p + 56, 6); u32(p + 60, 3); u32(p + 64, 1);
  const section = p + 72;
  put(section, '__bss'); put(section + 16, '__DATA');
  u64(section + 32, SECTION_ADDR); u64(section + 40, 8);
  u32(section + 48, 0);
  u32(section + 64, 0x01); // S_ZEROFILL
  const image = parseMachO(bytes);
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.ok(!image.warnings.some((w) => /contradicts parent segment/.test(w)));
});
