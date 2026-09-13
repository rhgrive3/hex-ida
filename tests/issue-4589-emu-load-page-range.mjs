// Regression for #4589: load() must resolve every page a multi-page range
// crosses. Ensuring only the first and last page made a fully backed 3-page
// read fail with a false unmapped-memory and hid the interior page from the
// backing io.read() contract.
import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';

const PAGE = 4096;
const START = 0x100000n;
const P0 = '100000';
const P1 = '101000';
const P2 = '102000';

function build(unmapped = new Set()) {
  const reads = [];
  const emu = new Emulator({
    read(page, size) {
      const key = BigInt(page).toString(16);
      reads.push(key);
      if (unmapped.has(key)) return new Uint8Array(0);
      return new Uint8Array(size);
    },
  });
  return { emu, reads };
}

function isUnmapped(error) {
  assert.equal(error.code, 'unmapped-memory', `expected unmapped-memory, got ${error.code}`);
  return true;
}

// Counterexample 1: every page is backed, so the read must succeed and the
// interior page must actually be resolved through io.read().
{
  const { emu, reads } = build();
  const value = await emu.load(START, PAGE * 3);
  assert.equal(value, 0n, 'fully backed 3-page range reads without fault');
  assert.ok(reads.includes(P0) && reads.includes(P1) && reads.includes(P2),
    `every crossed page must be resolved, saw ${JSON.stringify(reads)}`);
}

// Interior page without backing stays fail-closed.
{
  const { emu } = build(new Set([P1]));
  await assert.rejects(() => emu.load(START, PAGE * 3), isUnmapped,
    'unmapped interior page must not read as success');
}

// Unaligned ranges resolve both interior pages they touch.
{
  const { emu, reads } = build();
  await emu.load(START + BigInt(PAGE - 1), PAGE * 2 + 2);
  assert.ok(reads.includes(P0) && reads.includes(P1) && reads.includes(P2),
    `unaligned 3-page span must resolve every page, saw ${JSON.stringify(reads)}`);
}

// store() keeps the same all-page resolution (#7968) for the same span.
{
  const { emu, reads } = build(new Set([P1]));
  await assert.rejects(() => emu.store(START, PAGE * 3, 0n), isUnmapped,
    'unmapped interior page must not accept a write');
  assert.ok(reads.includes(P1), `store resolves the interior page, saw ${JSON.stringify(reads)}`);
}
