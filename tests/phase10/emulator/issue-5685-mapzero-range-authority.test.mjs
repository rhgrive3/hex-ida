// Regression for #5685: mapZero() must authorize exactly the declared
// [start, start+size) mapping, not the whole touched page. Page-granular
// buffers stay, but reads/writes outside the mapping span fail closed.
import assert from 'node:assert/strict';
import { Emulator } from '../../../js/emu.js';

async function rejectsUnmapped(run) {
  await assert.rejects(run, (error) => error?.code === 'unmapped-memory');
}

// The issue's minimal counterexample: a 1-byte mapping at a page offset.
{
  const emu = new Emulator({});
  emu.mapZero(0x1003n, 1);
  assert.equal(await emu.load(0x1003n, 1), 0n, 'the declared byte is backed');
  await rejectsUnmapped(() => emu.load(0x1002n, 1));
  await rejectsUnmapped(() => emu.load(0x1004n, 1));
  await rejectsUnmapped(() => emu.store(0x1fffn, 1, 0x41n));
  await emu.store(0x1003n, 1, 0x41n);
  assert.equal(await emu.load(0x1003n, 1), 0x41n, 'in-range writes still work');
}

// A mapping that crosses a page boundary gates both pages.
{
  const emu = new Emulator({});
  emu.mapZero(0x2fffn, 2);
  assert.equal(await emu.load(0x2fffn, 1), 0n);
  assert.equal(await emu.load(0x3000n, 1), 0n);
  await rejectsUnmapped(() => emu.load(0x2ffen, 1));
  await rejectsUnmapped(() => emu.load(0x3001n, 1));
}

// Two disjoint mappings on the same page keep their gap unmapped.
{
  const emu = new Emulator({});
  emu.mapZero(0x5000n, 4);
  emu.mapZero(0x5008n, 4);
  assert.equal(await emu.load(0x5000n, 1), 0n);
  assert.equal(await emu.load(0x5008n, 1), 0n);
  await rejectsUnmapped(() => emu.load(0x5004n, 1));
  await rejectsUnmapped(() => emu.load(0x5007n, 1));
}

// Aligned whole-page mapping boundaries stay exact.
{
  const emu = new Emulator({});
  emu.mapZero(0x100000n, 0x1000n);
  assert.equal(await emu.load(0x100000n, 1), 0n);
  assert.equal(await emu.load(0x100fffn, 1), 0n);
  await rejectsUnmapped(() => emu.load(0x101000n, 1));
  await rejectsUnmapped(() => emu.load(0xfffffn, 1));
}

// Non-mapped legacy paths keep their existing authority: stack pages created
// by ensure() remain page-granular and writes there still work.
{
  const emu = new Emulator({});
  emu.setup(0x1000n, [1n, 2n]);
  assert.equal(emu.get('x0'), 1n, 'register setup unchanged');
  await emu.store(0x0000700000000ff0n, 8, 0x42n);
  assert.equal(await emu.load(0x0000700000000ff0n, 8), 0x42n, 'stack memory keeps whole-page authority');
}

console.log('issue #5685 mapZero mapping-scoped authority regression: PASS');
