import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';

// Issue #4136: Emulator.load() accepts sizes up to 1 MiB but only ensured the
// first and last page of the span, so a legal read across three or more pages
// faulted with unmapped-memory on interior pages that the backing store can
// serve. Every page of an accepted range must be ensured (and store() must not
// skip interior mapping validation), exactly like dump() already did.

const PAGE = 4096;

function backing(reads = []) {
  return {
    read(address, size) {
      if (reads) reads.push({ address: BigInt(address), size });
      const page = BigInt(address) / BigInt(PAGE) * BigInt(PAGE);
      if (page === 0x1000n && this.missingInterior) return new Uint8Array(0);
      if (size > PAGE) throw new Error(`single oversized read requested: ${size}`);
      return new Uint8Array(size).fill(0x41);
    },
    missingInterior: false,
  };
}

async function expectFault(code, fn, label) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code}`);
    return true;
  }, label);
}

// 1. load fully inside one page keeps its behavior.
{
  const emu = new Emulator(backing());
  assert.equal(await emu.load(0x100n, 4), 0x41414141n, 'single-page load');
}

// 2. load spanning exactly two pages keeps its behavior.
{
  const emu = new Emulator(backing());
  const value = await emu.load(0x0ff0n, 32);
  assert.equal(value, BigInt(`0x${'41'.repeat(32)}`), 'two-page boundary load');
}

// 3. the issue counterexample: 0x100..0x2100 covers pages 0, 1 and 2 and must
// read through with all page backing present.
{
  const emu = new Emulator(backing());
  const value = await emu.load(0x100n, 0x2100);
  assert.equal(value, BigInt(`0x${'41'.repeat(0x2100)}`), 'three-page read completes');
}

// 4. a missing interior page still fails closed at that page, not later.
{
  const io = backing();
  io.missingInterior = true;
  const emu = new Emulator(io);
  await assert.rejects(() => emu.load(0x100n, 0x2100), (error) => {
    assert.equal(error.code, 'unmapped-memory', `interior page must fault unmapped-memory, got ${error.code}`);
    assert.equal(String(error.details?.page), '4096', 'the fault must name the interior page');
    return true;
  }, 'interior page without backing fails closed');
}

// 5. a multi-page store must validate interior page mapping too: page 1 has no
// backing here, so the store fails closed before committing anything.
{
  const io = backing();
  io.missingInterior = true;
  const emu = new Emulator(io);
  await expectFault('unmapped-memory', () => emu.store(0x100n, 0x2100, 0n), 'three-page store skips no interior page');
  assert.equal(await emu.load(0x100n, 4), 0x41414141n, 'the already-backed prefix page is untouched by the rejected store');
  await expectFault('unmapped-memory', () => emu.load(0x1000n, 1), 'the unbacked interior page was not minted by the rejected store');
}

// 6. multi-page reads ensure every touched page individually and never ask
// the backing for more than one page at a time. A 1 MiB store and dump (the
// maximum accepted size) must also materialize every page incrementally.
{
  const reads = [];
  const emu = new Emulator(backing(reads));
  const value = await emu.load(0x4000n, 32768);
  assert.equal(value, BigInt(`0x${'41'.repeat(32768)}`), '32 KiB read completes');
  assert.ok(reads.length >= 8, `every touched page must be fetched individually, got ${reads.length} reads`);
  assert.ok(reads.every((entry) => entry.size === PAGE), 'no oversized single backing read is requested');
  const pages = new Set(reads.map((entry) => String(entry.address)));
  for (let page = 0x4000n; page < 0x4000n + 32768n; page += BigInt(PAGE)) {
    assert.ok(pages.has(String(page)), `page 0x${page.toString(16)} must be ensured`);
  }
}
{
  const reads = [];
  const emu = new Emulator(backing(reads));
  await emu.store(0x80000n, 1024 * 1024, new Uint8Array(1024 * 1024).fill(0x42));
  const dumped = await emu.dump(0x80000n, 1024 * 1024);
  assert.ok(dumped.every((byte) => byte === 0x42), '1 MiB store covers every page');
  assert.ok(reads.every((entry) => entry.size === PAGE), '1 MiB range never requests one oversized backing read');
}

// dump() keeps its full-range behavior across all pages.
{
  const emu = new Emulator(backing());
  const bytes = await emu.dump(0x100n, 0x2100);
  assert.equal(bytes.length, 0x2100);
  assert.ok(bytes.every((byte) => byte === 0x41), 'three-page dump unchanged');
}

console.log('issue-4136 load/store/dump ensure every page of an accepted range: ok');
