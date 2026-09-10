// Regression for #7968: mapZero() window authority must also bound the write
// path on pre-backed pages. A store beyond the backing prefix AND outside
// every declared window used to succeed, and byteAt()'s mem-mask precedence
// then served the out-of-authority byte back — the write created readable
// state the mapping never declared.
import assert from 'node:assert/strict';
import { Emulator } from '../../../js/emu.js';

async function rejectsUnmapped(run) {
  await assert.rejects(run, (error) => error?.code === 'unmapped-memory');
}

// The issue's minimal counterexample: 16-byte IO prefix, disjoint synthetic
// window on the same page.
{
  const emu = new Emulator({ read: () => new Uint8Array(16).fill(0x5a) });
  assert.equal(await emu.load(0x2001n, 1), 0x5an, 'IO-backed prefix byte is readable');
  emu.mapZero(0x2020n, 1);
  assert.equal(await emu.load(0x2001n, 1), 0x5an, 'prefix authority survives the disjoint window');
  await rejectsUnmapped(() => emu.store(0x2011n, 1, 0x41n));
  await rejectsUnmapped(() => emu.load(0x2011n, 1));
  await emu.store(0x2020n, 1, 0x11n);
  assert.equal(await emu.load(0x2020n, 1), 0x11n, 'in-window writes still work');
  await emu.store(0x2002n, 1, 0x7en);
  assert.equal(await emu.load(0x2002n, 1), 0x7en, 'in-prefix writes still work');
}

// Prefix boundary: the last prefix byte is writable, the first byte past it
// is not (unless a window covers it).
{
  const emu = new Emulator({ read: () => new Uint8Array(16).fill(0x5a) });
  assert.equal(await emu.load(0x2001n, 1), 0x5an, 'the page is IO-backed before the mapping arrives');
  emu.mapZero(0x2020n, 1);
  await emu.store(0x200fn, 1, 0x22n);
  assert.equal(await emu.load(0x200fn, 1), 0x22n);
  await rejectsUnmapped(() => emu.store(0x2010n, 1, 0x33n));
}

// An explicit write that already existed before the window was declared keeps
// its authority (matching the canonical "existing explicit write" semantics).
{
  const emu = new Emulator({ read: () => new Uint8Array(16).fill(0x5a) });
  await emu.store(0x2011n, 1, 0x44n);
  emu.mapZero(0x2020n, 1);
  await emu.store(0x2011n, 1, 0x45n);
  assert.equal(await emu.load(0x2011n, 1), 0x45n, 'pre-existing explicit write authority is preserved');
}

// mapZero-created pages stay fully range-gated for writes.
{
  const emu = new Emulator({});
  emu.mapZero(0x1003n, 1);
  await rejectsUnmapped(() => emu.store(0x1002n, 1, 0x1n));
  await rejectsUnmapped(() => emu.store(0x1004n, 1, 0x1n));
  await emu.store(0x1003n, 1, 0x41n);
  assert.equal(await emu.load(0x1003n, 1), 0x41n);
}

console.log('issue #7968 write-path window authority regression: PASS');
