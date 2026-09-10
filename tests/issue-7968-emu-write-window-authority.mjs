// Regression for #7968: on a page with pre-existing backing, the write
// authority must match byteAt()'s read authority — the backing prefix plus
// the additive mapZero windows. A store beyond the prefix and outside every
// declared window must fail closed (unmapped-memory) instead of succeeding
// and becoming readable back through mem-mask precedence.
import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';

const PAGE = 4096;

async function expectUnmapped(fn, label) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, 'unmapped-memory', `${label}: expected unmapped-memory, got ${error.code}`);
    return true;
  }, label);
}

// Issue counterexample: 16-byte IO prefix on page 0x2000, a disjoint
// mapZero window at 0x2020. The store at 0x2011 (beyond the prefix, outside
// the window) used to succeed and read back through mem precedence.
{
  const emu = new Emulator({ read: () => new Uint8Array(16).fill(0x5a) });
  assert.equal(await emu.load(0x2001n, 1), 0x5an, 'prefix authority reads');
  emu.mapZero(0x2020n, 1);
  await expectUnmapped(() => emu.store(0x2011n, 1, 0x41n), 'store beyond prefix and outside window');
  await expectUnmapped(() => emu.load(0x2011n, 1), 'rejected store leaves no readable byte');
  assert.equal(await emu.load(0x2020n, 1), 0n, 'the synthetic window still backs its own bytes');
}

// In-prefix stores keep their authority, including the last prefix byte.
{
  const emu = new Emulator({ read: () => new Uint8Array(16).fill(0x5a) });
  assert.equal(await emu.load(0x2001n, 1), 0x5an, 'prefix materialized before the mapping');
  emu.mapZero(0x2020n, 1);
  await emu.store(0x2005n, 1, 0x41n);
  assert.equal(await emu.load(0x2005n, 1), 0x41n, 'in-prefix store reads back');
  await emu.store(0x200fn, 1, 0x7en);
  assert.equal(await emu.load(0x200fn, 1), 0x7en, 'last prefix byte stays writable');
  await expectUnmapped(() => emu.store(0x2010n, 1, 1n), 'first byte past the prefix is not writable');
  await emu.store(0x2020n, 1, 0x42n);
  assert.equal(await emu.load(0x2020n, 1), 0x42n, 'in-window store reads back');
}

// One window never grants page-wide authority.
{
  const emu = new Emulator({ read: () => new Uint8Array(16).fill(0x5a) });
  assert.equal(await emu.load(0x2000n, 1), 0x5an);
  emu.mapZero(0x2020n, 1);
  await emu.store(0x2020n, 1, 0x42n);
  await expectUnmapped(() => emu.store(0x2021n, 1, 1n), 'byte past the window end');
  await expectUnmapped(() => emu.store(0x201fn, 1, 1n), 'byte before the window start');
  await expectUnmapped(() => emu.store(0x2000n + BigInt(PAGE - 1), 1, 1n), 'page tail stays unauthorized');
}

// Multi-byte stores that straddle the authority boundary fail closed without
// partially committing bytes inside the prefix.
{
  const emu = new Emulator({ read: () => new Uint8Array(16).fill(0x5a) });
  assert.equal(await emu.load(0x2000n, 1), 0x5an);
  emu.mapZero(0x2020n, 1);
  await expectUnmapped(() => emu.store(0x200en, 4, 0x01020304n), 'store crossing the prefix end');
  assert.equal(await emu.load(0x200en, 1), 0x5an, 'in-prefix byte of the rejected store is unmodified');
  assert.equal(await emu.load(0x200fn, 1), 0x5an, 'boundary byte of the rejected store is unmodified');
}

// Cross-page mapZero: each page gates its own window slice; the backing
// prefix of the tail page keeps its own authority.
{
  const emu = new Emulator({ read: (p) => new Uint8Array(16).fill(p === 0xb000n ? 0x5a : 0x5b) });
  assert.equal(await emu.load(0xb004n, 1), 0x5an, 'tail page prefix materialized');
  emu.mapZero(0xbffen, 4); // windows on page 0xb000 tail and page 0xc000 head
  assert.equal(await emu.load(0xbffen, 1), 0n, 'tail window is backed');
  assert.equal(await emu.load(0xc000n, 1), 0n, 'head window is backed');
  await emu.store(0xbfffn, 1, 0x11n);
  await emu.store(0xc000n, 1, 0x22n);
  assert.equal(await emu.load(0xbfffn, 1), 0x11n, 'in-window tail write reads back');
  assert.equal(await emu.load(0xc000n, 1), 0x22n, 'in-window head write reads back');
  await emu.store(0xb005n, 1, 0x33n);
  assert.equal(await emu.load(0xb005n, 1), 0x33n, 'in-prefix write keeps its authority');
  await expectUnmapped(() => emu.store(0xb020n, 1, 1n), 'tail page gap beyond prefix and window');
  await expectUnmapped(() => emu.store(0xc004n, 1, 1n), 'above the head window');
}

// Stack and heap pages keep their whole-page write authority (#7968 must not
// revoke existing backing).
{
  const emu = new Emulator({});
  const sp = emu.sp;
  await emu.store(sp - 8n, 4, 0xdeadbeefn);
  assert.equal(await emu.load(sp - 8n, 4), 0xdeadbeefn, 'stack backing stays writable');
  const heap = emu.heapBase ?? emu.heap;
  await emu.store(BigInt(heap), 4, 0x41424344n);
  assert.equal(await emu.load(BigInt(heap), 4), 0x41424344n, 'heap backing stays writable');
}

// mapZero-created pages (no other backing) keep their exact-window authority
// on the write path, as pinned by #5685.
{
  const emu = new Emulator({});
  emu.mapZero(0x3003n, 1);
  await emu.store(0x3003n, 1, 0x9an);
  assert.equal(await emu.load(0x3003n, 1), 0x9an);
  await expectUnmapped(() => emu.store(0x3002n, 1, 1n), 'write below the synthetic window');
  await expectUnmapped(() => emu.store(0x3004n, 1, 1n), 'write above the synthetic window');
}

console.log('issue-7968 emu write-path window authority: ok');
