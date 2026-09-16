import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../../js/binary/reader.js';
import { BinaryImage, functionSeed } from '../../../js/binary/model.js';
import { parseEhFrameHeader } from '../../../js/binary/elf-unwind.js';
import { createELFMetadataBudget } from '../../../js/binary/elf-budget.js';

// Issue #8860: parseEhFrameHeader() budgeted only the binary-search-table
// decode. The recovery work that follows (unsorted/incomplete/domain-unresolved
// rows) called existingNonUnwindFunction() which did `image.functions.some(...)`
// per decoded row, making recovery Θ(rows × pre-existing functions); the sorted
// validation loop ran parseFde/parseCie/executable-range work per row with no
// charge, and every rejection appended an unaccounted warning. A ~1.3 MiB input
// could pin the canonical loader past its own wall-clock limit or OOM a
// constrained heap while elfMetadata.complete === true.

const HEADER_ADDR = 0x3000n;
const TEXT_ADDR = 0x1000n;
const EH_FRAME_ADDR = 0x2000n;

function unsortedHeaderBytes(rowCount, { base = 0x10000 } = {}) {
  const bytes = new Uint8Array(12 + rowCount * 8);
  const view = new DataView(bytes.buffer);
  let p = 0;
  view.setUint8(p++, 1);        // version
  view.setUint8(p++, 0x03);     // eh_frame_ptr enc: sdata4 absolute
  view.setUint8(p++, 0x03);     // fde_count enc: udata4
  view.setUint8(p++, 0x03);     // table enc: sdata4 absolute
  view.setUint32(p, Number(EH_FRAME_ADDR), true); p += 4;
  view.setUint32(p, rowCount, true); p += 4;
  for (let i = 0; i < rowCount; i++) {
    // Decreasing initial location forces tableSorted === false, which routes
    // through the unverified recovery loop exactly once per row.
    view.setInt32(p, base + (rowCount - i), true); p += 4;
    view.setInt32(p, 0x2000 + i * 8, true); p += 4;
  }
  return bytes;
}

function makeImage(bytes, preexisting, { base = 0x10000 } = {}) {
  const image = new BinaryImage(bytes, { format: 'elf', arch: 'x86_64', bits: 64, metadata: {} });
  image.addSection({ name: '.text', address: TEXT_ADDR, size: 0x80n, fileOffset: 0x80n, fileSize: 0x80n, perms: { read: true, execute: true } });
  for (let j = 0; j < preexisting; j++) {
    image.functions.push(functionSeed(BigInt(base + j), { source: 'symbol', confidence: 0.995, exactFunctionStart: true }));
  }
  return image;
}

function parseInto(image, bytes, budget) {
  const r = new ByteView(bytes, { littleEndian: true });
  parseEhFrameHeader(r, { name: '.eh_frame_hdr', addr: HEADER_ADDR, offset: 0n, size: BigInt(bytes.length) }, image, 64, budget);
  return image;
}

test('#8860 unverified recovery is near-linear in rows, not rows × functions', () => {
  // 24k recovered rows over 24k pre-existing symbol seeds was Θ(24k×24k) in the
  // old `image.functions.some(...)` scan; the precomputed address set makes it
  // Θ(rows). Assert preserved behaviour plus a hard time ceiling.
  const n = 24_000;
  const bytes = unsortedHeaderBytes(n);
  const image = makeImage(bytes, n);
  const t0 = Date.now();
  parseInto(image, bytes, null);
  const dt = Date.now() - t0;

  const unwindSeeds = image.functions.filter((f) => f.source === 'unwind').length;
  // Every row matched a pre-existing (non-unwind) function, so every row must
  // still be recovered as an unverified seed — the optimization is not allowed
  // to drop coverage.
  assert.equal(unwindSeeds, n - 1);
  assert.ok(dt < 4000, `24k-row recovery over 24k functions took ${dt}ms (expected near-linear, <4000ms)`);
});

test('#8860 recovery heap growth is charged to the shared metadata budget', () => {
  const n = 40_000;
  const bytes = unsortedHeaderBytes(n);
  const image = makeImage(bytes, n);
  const budget = createELFMetadataBudget(image, { limits: { estimatedHeapBytes: 1_000_000 } });
  parseInto(image, bytes, budget);
  const unwindSeeds = image.functions.filter((f) => f.source === 'unwind').length;
  // With a tiny heap ceiling the recovery must stop early and mark the
  // metadata partial instead of materializing all 40k recovery seeds.
  assert.ok(unwindSeeds < n, `expected budget-bounded recovery, got ${unwindSeeds} of ${n}`);
  assert.equal(image.metadata.elfMetadata.complete, false);
});

test('#8860 rejection warnings are routed through the output/heap accounting', () => {
  // On main each `.eh_frame_hdr:` warning was appended outside the budget, so
  // a hostile table could materialize hundreds of thousands of warning strings
  // while elfMetadata.complete === true. Now every variable-length warning is
  // charged to the same budget; once it is exhausted the warning is dropped
  // rather than growing the heap unbounded.
  const n = 20_000;
  const bytes = unsortedHeaderBytes(n);
  const image = makeImage(bytes, n);
  const budget = createELFMetadataBudget(image, { limits: { estimatedHeapBytes: 1_000_000 } });
  parseInto(image, bytes, budget);
  // The recovery loop is budget-charged and stops early; the terminal summary
  // warning is then also budget-gated (dropped once stopped), so total
  // `.eh_frame_hdr:` warnings stay tiny while metadata is marked partial.
  const ehWarnings = image.warnings.filter((w) => w.includes('.eh_frame_hdr')).length;
  assert.ok(ehWarnings <= 2, `expected bounded warning output, got ${ehWarnings}`);
  assert.equal(image.metadata.elfMetadata.complete, false);
});
