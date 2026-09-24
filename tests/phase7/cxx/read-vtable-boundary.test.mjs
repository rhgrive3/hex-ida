import test from 'node:test';
import assert from 'node:assert/strict';
import { readVtable } from '../../../js/rtti.js';

test('readVtable stops at structural vtable boundary and non-executable data', async () => {
  // Construct simulated memory where vtable A has 2 slots, followed by vtable B header
  // [offset-to-top=0, typeinfo=0x2000, slot0=0x1000, slot1=0x1008, offset-to-top=0, typeinfo=0x3000, ...]
  const buffer = new ArrayBuffer(64);
  const dv = new DataView(buffer);

  // Vtable A
  dv.setBigInt64(0, 0n, true); // offsetToTop
  dv.setBigUint64(8, 0x2000n, true); // typeinfo A
  dv.setBigUint64(16, 0x1000n, true); // slot 0 (code)
  dv.setBigUint64(24, 0x1008n, true); // slot 1 (code)

  // Vtable B header (adjacent in rodata)
  dv.setBigInt64(32, 0n, true); // offsetToTop of B
  dv.setBigUint64(40, 0x3000n, true); // typeinfo B
  dv.setBigUint64(48, 0x1010n, true); // slot 0 of B

  const symbols = {
    nameAt(addr) {
      if (addr === 0x2000n) return '_ZTI7ClassA';
      if (addr === 0x3000n) return '_ZTI7ClassB';
      if (addr === 0x1000n) return '_ZN7ClassA4fooEv';
      if (addr === 0x1008n) return '_ZN7ClassA4barEv';
      if (addr === 0x1010n) return '_ZN7ClassB4bazEv';
      return null;
    },
    label(addr) { return this.nameAt(addr); }
  };

  const read = async (addr, size) => {
    const offset = Number(addr);
    if (offset < 0 || offset >= buffer.byteLength) return null;
    const available = Math.min(size, buffer.byteLength - offset);
    return new Uint8Array(buffer, offset, available);
  };

  const isExecutable = (addr) => addr >= 0x1000n && addr < 0x2000n;

  // In non-exact mode (default maxSlots=64), reading vtable A at 0 must stop after slot 1
  const vtA = await readVtable(read, 0n, symbols, 64, { isExecutable });
  assert.equal(vtA.slots.length, 2);
  assert.equal(vtA.slots[0].addr, 0x1000n);
  assert.equal(vtA.slots[1].addr, 0x1008n);

  // If a slot points to non-executable data (e.g. data address 0x5000), it must stop
  dv.setBigUint64(24, 0x5000n, true);
  const vtStopNonExec = await readVtable(read, 0n, symbols, 64, { isExecutable });
  assert.equal(vtStopNonExec.slots.length, 1);
  assert.equal(vtStopNonExec.slots[0].addr, 0x1000n);

  // Exact slotCount mode must still be preserved
  const vtExact = await readVtable(read, 0n, symbols, { slotCount: 3 });
  assert.equal(vtExact.slots.length, 3);
});
