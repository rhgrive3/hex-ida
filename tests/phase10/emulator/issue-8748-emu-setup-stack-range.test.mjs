// Regression for #8748: Emulator.setup() must not mint unmapped stack backing.
// Stack args beyond x0..x7 are placed at sp + (i-8)*8. Before the fix, setup()
// wrote them with the raw writeByte() (which mints a page before the authority
// check and only rejects bytes on an already-loaded page), so enough stack args
// walked past STACK_TOP and created pages that later byteAt()/load paths read
// back as real data — activating memory outside the declared stack window.
// setup() now admits every stack byte against [STACK_TOP-STACK_SIZE, STACK_TOP)
// before mutating any register or memory, then commits.
import assert from 'node:assert/strict';
import { Emulator, STACK_TOP } from '../../../js/emu.js';

const STACK_SIZE = 1 << 20;
const spOf = () => STACK_TOP - 0x400n;

// (A) The reported counterexample: 649 args (641 stack slots) fails closed and
//     mints nothing at/above STACK_TOP.
{
  const emu = new Emulator();
  let fault = null;
  try {
    emu.setup(0x1000n, Array.from({ length: 649 }, (_, i) => BigInt(i)));
  } catch (error) {
    fault = error;
  }
  assert.ok(fault, 'setup with out-of-range stack args must throw');
  assert.equal(fault.code, 'unmapped-memory', `expected unmapped-memory, got ${fault && fault.code}`);
  const mintedPastTop = [...emu.mem.keys()].some((k) => BigInt(k) >= STACK_TOP);
  assert.equal(mintedPastTop, false, 'no page may be minted at/above STACK_TOP');
  assert.equal(emu.pc, 0n, 'a rejected setup must not mutate pc');
  assert.equal(emu.get('x0'), 0n, 'a rejected setup must not mutate registers');
}

// (B) The exact boundary: 8 register args + the largest stack-arg count that
//     still fits below STACK_TOP must succeed and round-trip byte-for-byte.
{
  const emu = new Emulator();
  const sp = spOf();
  // Highest fitting stack slot starts at STACK_TOP - 8 (its 8 bytes end at STACK_TOP).
  const maxStackSlots = Number((STACK_TOP - 8n - sp) / 8n) + 1;
  const args = Array.from({ length: 8 + maxStackSlots }, (_, i) => BigInt(0x11 + i));
  emu.setup(0x1000n, args);
  assert.equal(emu.get('x0'), 0x11n, 'x0 still carries the first register arg');
  const lastSlot = sp + BigInt(maxStackSlots - 1) * 8n; // == STACK_TOP - 8n
  assert.equal(lastSlot, STACK_TOP - 8n, 'in-range test uses the top-most legal slot');
  // Low byte of the final in-range stack arg round-trips through the declared window.
  const lastValue = args[args.length - 1];
  assert.equal(emu.byteAt(lastSlot), Number(lastValue & 0xffn), 'in-range stack byte is readable');
}

// (C) One slot past the boundary (the last byte lands exactly at STACK_TOP + ...):
//     must reject, and no page past STACK_TOP is created.
{
  const emu = new Emulator();
  const sp = spOf();
  const maxStackSlots = Number((STACK_TOP - 8n - sp) / 8n) + 1;
  const args = Array.from({ length: 8 + maxStackSlots + 1 }, (_, i) => BigInt(i));
  let fault = null;
  try {
    emu.setup(0x1000n, args);
  } catch (error) {
    fault = error;
  }
  assert.ok(fault && fault.code === 'unmapped-memory', 'one slot over the top must fail closed');
  assert.equal([...emu.mem.keys()].some((k) => BigInt(k) >= STACK_TOP), false, 'still nothing minted past STACK_TOP');
}

// (D) A small in-range setup (a few stack args) keeps working unchanged.
{
  const emu = new Emulator();
  const args = [...Array(8).keys()].map(BigInt).concat([...Array(3).keys()].map((x) => BigInt(1000 + x)));
  emu.setup(0x1000n, args);
  assert.equal(emu.byteAt(spOf()), 1000 & 0xff, 'first stack arg low byte preserved');
  assert.equal(emu.byteAt(spOf() + 1n), (1000 >> 8) & 0xff, 'first stack arg high byte preserved');
}

console.log('issue-8748 emu-setup-stack-range: PASS');
