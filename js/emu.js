/*
 * #8755 coexistence guard.
 *
 * Keep the reviewed emulator implementation byte-for-byte in emu-base.js and
 * compose configured heap authority into an already-loaded range-gated
 * synthetic page before the legacy ensure() early-return can fire. This is
 * additive authority only: existing backing is preserved, ungated real/stack/
 * file pages are untouched, and unrelated bytes stay outside the declared
 * synthetic ranges.
 */
import { Emulator } from './emu-base.js';

const PAGE_BYTES = 4096n;
const originalEnsure = Emulator.prototype.ensure;

Emulator.prototype.ensure = async function ensureWithHeapRangeComposition(addr, faultAddress = addr) {
  const address = BigInt(addr);
  const page = (address / PAGE_BYTES) * PAGE_BYTES;
  const key = page.toString();

  if ((this.mem.has(key) || this.loaded.has(key)) && this.syntheticRangeGated.has(key)) {
    this._syncHeapBase();
    const heapEnd = this.heapBase + this.heapSize;
    if (page < heapEnd && page + PAGE_BYTES > this.heapBase) {
      const lo = this.heapBase > page ? Number(this.heapBase - page) : 0;
      const hi = heapEnd - page >= PAGE_BYTES ? Number(PAGE_BYTES) : Number(heapEnd - page);
      let ranges = this.syntheticRanges.get(key);
      if (!ranges) {
        ranges = [];
        this.syntheticRanges.set(key, ranges);
      }
      if (!ranges.some((range) => range.lo === lo && range.hi === hi)) ranges.push({ lo, hi });
    }
  }

  return originalEnsure.call(this, addr, faultAddress);
};

export * from './emu-base.js';
