// Regression for #8755: Emulator.configureHeap({base,size}) accepts an arbitrary
// byte range but the pre-fix ensure() heap branch admitted any page whose
// FLOOR satisfies `page >= heapBase && page < heapBase + heapSize` and then set
// loadedValid = PAGE for the whole backing page. With an unaligned base the
// first declared heap bytes lived on a page whose floor was `< heapBase` and
// were therefore never backed (unmapped). With a non-page-multiple tail the
// final partial page was activated for its entire PAGE bytes, exposing backing
// past the declared end. This test locks the byte-range/page-backing parity:
//   * head bytes of an unaligned range are readable/writable;
//   * bytes past the declared end stay unmapped for both read and write;
//   * the fully-aligned case is bit-for-byte unchanged (issue-4137 parity);
//   * a single page wholly inside the range keeps the fast path (ungated).
import assert from 'node:assert/strict';
import { Emulator } from '../../../js/emu.js';

const PAGE = 4096n;
const HEAP_BASE = 0x0000600000000000n;

async function readAt(emu, address) {
  await emu.ensure(address);
  return emu.byteAt(address);
}
async function tryReadAt(emu, address) {
  try { return { ok: true, value: await readAt(emu, address) }; }
  catch (error) { return { ok: false, code: error?.code }; }
}
async function tryWriteAt(emu, address, byte) {
  try { await emu.ensure(address); await emu.store(address, 1, byte); return { ok: true }; }
  catch (error) { return { ok: false, code: error?.code }; }
}

// (A) Unaligned head + unaligned tail: exactly [base, base+size) is addressable.
{
  const emu = new Emulator();
  const base = HEAP_BASE + 1n;
  const size = PAGE + PAGE + 1n; // straddles three pages with an unaligned start and end
  emu.configureHeap({ base, size });
  const last = base + size - 1n;

  assert.equal(await readAt(emu, base), 0, 'first declared heap byte is readable');
  assert.equal(await readAt(emu, last), 0, 'last declared heap byte is readable');

  const before = await tryReadAt(emu, base - 1n);
  assert.equal(before.ok, false, 'byte before declared base must be unmapped');
  assert.equal(before.code, 'unmapped-memory');

  const pastEnd = await tryReadAt(emu, last + 1n);
  assert.equal(pastEnd.ok, false, 'byte past declared end must be unmapped');
  assert.equal(pastEnd.code, 'unmapped-memory');

  const writeBefore = await tryWriteAt(emu, base - 1n, 0xfe);
  assert.equal(writeBefore.ok, false, 'writing before the declared base must fail closed');
  assert.equal(writeBefore.code, 'unmapped-memory');
  const writePastEnd = await tryWriteAt(emu, last + 1n, 0xfe);
  assert.equal(writePastEnd.ok, false, 'writing past the declared end must fail closed');
  assert.equal(writePastEnd.code, 'unmapped-memory');

  // A write inside the declared range still lands on the page backing.
  await emu.ensure(base); await emu.store(base, 1, 0xab);
  assert.equal(emu.byteAt(base), 0xab, 'in-range write commits');
}

// (B) Fully-aligned range [base, base + 2*PAGE): whole-page fast path preserved
//     (no syntheticRangeGated marking, byte-for-byte identical to #4137).
{
  const emu = new Emulator();
  const base = HEAP_BASE;
  const size = 2n * PAGE;
  emu.configureHeap({ base, size });
  await emu.ensure(base);
  await emu.ensure(base + PAGE);
  assert.equal(emu.byteAt(base), 0, 'first page zero-backed');
  assert.equal(emu.byteAt(base + PAGE + PAGE - 1n), 0, 'last byte of the second page readable');
  assert.equal(emu.syntheticRangeGated.has(base.toString()), false, 'aligned page keeps the ungated fast path');
  assert.equal(emu.syntheticRangeGated.has((base + PAGE).toString()), false, 'second aligned page ungated too');
  const pastAligned = await tryReadAt(emu, base + size);
  assert.equal(pastAligned.ok, false, 'next page after an aligned range stays unmapped (#4137 parity)');
  assert.equal(pastAligned.code, 'unmapped-memory');
}

// (C) A single-page straddle: base inside page N, base+size still inside page N.
{
  const emu = new Emulator();
  const base = HEAP_BASE + 0x100n;
  const size = 0x80n;
  emu.configureHeap({ base, size });
  assert.equal(await readAt(emu, base), 0);
  assert.equal(await readAt(emu, base + size - 1n), 0);
  const lo = await tryReadAt(emu, base - 1n);
  const hi = await tryReadAt(emu, base + size);
  assert.equal(lo.ok, false, 'unaligned head on the single page is rejected');
  assert.equal(hi.ok, false, 'unaligned tail on the single page is rejected');
  // Page containing this heap is gated (not the whole-page fast path).
  assert.equal(emu.syntheticRangeGated.has(HEAP_BASE.toString()), true, 'boundary page is window-gated');
}

// (D) Idempotent ensure() after gating: same window reused, no duplicates.
{
  const emu = new Emulator();
  const base = HEAP_BASE + 2n, size = 4n;
  emu.configureHeap({ base, size });
  await emu.ensure(base);
  await emu.ensure(base);           // second call must return early (already loaded)
  const ranges = emu.syntheticRanges.get(HEAP_BASE.toString());
  assert.equal(ranges.length, 1, 'ensure() must not duplicate a heap window on the same page');
  assert.deepEqual(ranges[0], { lo: 2, hi: 6 });
}

console.log('issue-8755 emu-configure-heap-byte-range-backing-parity: PASS');
