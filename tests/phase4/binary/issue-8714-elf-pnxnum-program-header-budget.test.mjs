/**
 * #8714 — `PN_XNUM` program-header expansion must be bounded before it is decoded.
 *
 * `e_phnum = PN_XNUM` moves the real count into section header 0's `sh_info`, so
 * it is attacker-controlled up to the 1,000,000 admission ceiling. The expansion
 * used to run outside the ELF metadata budget, so a table of valid `PT_NULL`
 * entries materialized one retained object per declared row with no accounting,
 * and a declared count that outran the file was only a warning.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

const PN_XNUM = 0xffff;
const PHENTSIZE = 56;
const PHOFF = 64;
const SHENTSIZE = 64;

function buildELF({ size, phnum, extendedPhnum = null, phent = PHENTSIZE, phoff = PHOFF }) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const u16 = (p, v) => view.setUint16(p, v, true);
  const u32 = (p, v) => view.setUint32(p, v, true);
  const u64 = (p, v) => view.setBigUint64(p, BigInt(v), true);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  u16(16, 3);                 // ET_DYN
  u16(18, 62);
  u32(20, 1);
  u64(24, 0x401000);          // e_entry
  u64(32, phoff);             // e_phoff
  const shoff = size - SHENTSIZE;
  u64(40, shoff);
  u32(48, 0);
  u16(52, 64);                // e_ehsize
  u16(54, phent);             // e_phentsize
  u16(56, phnum);             // e_phnum
  u16(58, SHENTSIZE);         // e_shentsize
  u16(60, 1);                 // e_shnum
  u16(62, 0);                 // e_shstrndx
  // Section 0 is the canonical all-zero null section unless it carries the
  // extended program-header count.
  if (extendedPhnum != null) u32(shoff + 44, extendedPhnum);
  return { bytes, view, shoff };
}

function summarize(bytes, options) {
  const image = parseELF(bytes, options);
  return {
    image,
    metadata: image.metadata.elfMetadata,
    expanded: image.metadata.extendedProgramHeaderCount,
    segments: image.segments.length,
  };
}

test('#8714: a PN_XNUM count beyond the file is clamped to the readable prefix', () => {
  const { bytes } = buildELF({ size: 512 * 1024, phnum: PN_XNUM, extendedPhnum: 200000 });
  const capacity = Math.floor((bytes.length - PHOFF) / PHENTSIZE);
  const { metadata, expanded, segments } = summarize(bytes);
  assert.ok(capacity > 9000 && capacity < 200000, `unexpected capacity ${capacity}`);
  assert.equal(metadata.complete, false);
  assert.ok(metadata.reasons.includes('program-headers:truncated'), JSON.stringify(metadata.reasons));
  assert.equal(expanded, capacity);
  assert.equal(metadata.used.records, 1, 'program-header decoding must not consume the shared records budget (keeps the PT_DYNAMIC fallback reachable)');
  assert.equal(metadata.used.objects, capacity + 1);
  assert.equal(metadata.used.inputBytes, capacity * PHENTSIZE + SHENTSIZE);
  assert.equal(segments, 0);   // every readable entry is PT_NULL
});

test('#8714: program-header decoding is admitted through the metadata budget', () => {
  // 20,000 valid PT_NULL rows all fit the file, so only the budget may stop them.
  const { bytes } = buildELF({ size: PHOFF + 20000 * PHENTSIZE + SHENTSIZE, phnum: PN_XNUM, extendedPhnum: 20000 });
  const { metadata, expanded } = summarize(bytes, { metadataLimits: { objects: 500 } });
  assert.equal(metadata.complete, false);
  assert.ok(metadata.reasons.includes('budget:program-header:objects'), JSON.stringify(metadata.reasons));
  assert.equal(expanded, 500);
  assert.equal(metadata.used.objects, 500);
  assert.equal(metadata.used.inputBytes, 500 * PHENTSIZE);
});

test('#8714: a truncated non-extended table is partial metadata, not silence', () => {
  const { bytes } = buildELF({ size: PHOFF + 4 * PHENTSIZE + SHENTSIZE, phnum: 10 });
  const capacity = Math.floor((bytes.length - PHOFF) / PHENTSIZE);
  const { metadata, expanded } = summarize(bytes);
  assert.equal(metadata.complete, false);
  assert.ok(metadata.reasons.includes('program-headers:truncated'));
  assert.equal(metadata.used.objects, capacity + 1);
  assert.equal(expanded, null);   // no PN_XNUM expansion happened, so nothing to publish
});

test('#8714: an in-file PN_XNUM table stays complete and reports its real count', () => {
  const { bytes } = buildELF({ size: PHOFF + 1 * PHENTSIZE + SHENTSIZE, phnum: PN_XNUM, extendedPhnum: 1 });
  const { metadata, expanded } = summarize(bytes);
  assert.equal(expanded, 1);
  assert.equal(metadata.complete, true);
  assert.deepEqual(metadata.reasons, []);
});

test('#8714: an already-aborted signal consumes no header budget at all', () => {
  const controller = new AbortController();
  controller.abort();
  const { bytes } = buildELF({ size: PHOFF + 100 * PHENTSIZE + SHENTSIZE, phnum: PN_XNUM, extendedPhnum: 100 });
  const { metadata, expanded, segments } = summarize(bytes, { signal: controller.signal });
  assert.equal(expanded, 0);
  assert.equal(segments, 0);
  assert.equal(metadata.complete, false);
  assert.ok(metadata.reasons.includes('budget:aborted'));
  assert.deepEqual(metadata.used, {
    inputBytes: 0, records: 0, objects: 0, stringBytes: 0, operations: 0, estimatedHeapBytes: 0,
  });
});

test('#8714: PT_LOAD mapping authority survives the budget admission', () => {
  const { bytes, view } = buildELF({ size: PHOFF + 3 * PHENTSIZE + 0x2000, phnum: 3 });
  view.setUint32(PHOFF, 1, true);              // p_type = PT_LOAD
  view.setUint32(PHOFF + 4, 5, true);          // PF_R | PF_X
  view.setBigUint64(PHOFF + 8, 0x1000n, true); // p_offset
  view.setBigUint64(PHOFF + 16, 0x401000n, true); // p_vaddr
  view.setBigUint64(PHOFF + 32, 0x1000n, true);   // p_filesz
  view.setBigUint64(PHOFF + 40, 0x1000n, true);   // p_memsz
  view.setBigUint64(PHOFF + 48, 0x1000n, true);   // p_align
  const { metadata, segments } = summarize(bytes);
  assert.equal(segments, 1);
  assert.equal(metadata.used.objects, 3 + 1);
  assert.equal(metadata.used.inputBytes, 3 * PHENTSIZE + SHENTSIZE);
  assert.equal(metadata.complete, true);
  assert.deepEqual(metadata.reasons, []);
});
