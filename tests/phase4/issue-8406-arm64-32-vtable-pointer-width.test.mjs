import test from 'node:test';
import assert from 'node:assert/strict';
import { readVtable, rttiPointerContextForSlice } from '../../js/rtti.js';

// #8406 — C++ vtable / RTTI components are native-pointer words. arm64_32
// (watchOS) is AArch64 with an ILP32 pointer ABI, so Clang emits 4-byte vtable
// components. A fixed 8-byte read concatenates adjacent 32-bit slots into
// fabricated 64-bit targets that the fallback resolver then accepts.

// The exact shape from the issue: 8 little-endian 32-bit words whose
// concatenated 64-bit pairs are still below the user-address ceiling.
const WORDS = [0x00000000, 0x00003000, 0x00004000, 0x00005000, 0x00006000, 0x00007000, 0x00008000, 0x00009000];

function ilp32Vtable() {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  WORDS.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}

function lp64Vtable(offsetToTop, typeinfo, ...slots) {
  const bytes = new Uint8Array((slots.length + 2) * 8);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, BigInt(offsetToTop), true);
  view.setBigUint64(8, BigInt(typeinfo), true);
  slots.forEach((slot, index) => view.setBigUint64((index + 2) * 8, BigInt(slot), true));
  return bytes;
}

const readOf = (bytes, log) => async (address, length) => {
  log?.push({ address, length });
  return bytes.slice(0, length);
};

test('#8406 arm64_32 decodes 4-byte vtable components without concatenation', async () => {
  const reads = [];
  const pointerContext = rttiPointerContextForSlice({
    info: { architecture: 'arm64_32', pointerBits: 32 },
    capability: { architecture: 'arm64_32', pointerBits: 32 },
  });
  const table = await readVtable(readOf(ilp32Vtable(), reads), 0x1000n, null, 2, pointerContext);
  assert.equal(table.pointerBytes, 4);
  assert.equal(table.offsetToTop, 0n, 'offset-to-top is a 32-bit ptrdiff_t');
  assert.equal(table.typeinfoRaw, 0x3000n);
  assert.equal(table.typeinfo, 0x3000n);
  assert.equal(table.slots.length, 2);
  assert.deepEqual(table.slots.map((slot) => slot.raw), [0x4000n, 0x5000n]);
  assert.deepEqual(table.slots.map((slot) => slot.addr), [0x4000n, 0x5000n]);
  assert.equal(table.slots.every((slot) => slot.unresolved === false), true);
  // The read window and the slot stride both follow the 4-byte ABI.
  assert.deepEqual(reads, [{ address: 0x1000n, length: 16 }]);
});

test('#8406 canonical slice pointerBits and explicit pointerSize agree', async () => {
  const byOption = await readVtable(readOf(ilp32Vtable()), 0x1000n, null, 2, { pointerSize: 4 });
  const byArch = await readVtable(readOf(ilp32Vtable()), 0x1000n, null, 2, { architecture: 'arm64_32', pointerBits: 32 });
  assert.deepEqual(byOption, byArch);
});

test('#8406 negative offset-to-top is the 32-bit signed value', async () => {
  const bytes = ilp32Vtable();
  new DataView(bytes.buffer).setUint32(0, 0xfffffffe, true);
  const table = await readVtable(readOf(bytes), 0x1000n, null, 1, { pointerBits: 32 });
  assert.equal(table.offsetToTop, -2n);
});

test('#8406 ILP32 never yields a target above the 32-bit address space', async () => {
  const bytes = ilp32Vtable();
  // A genuinely encoded 64-bit value in the first slot pair would be > 4 GiB.
  new DataView(bytes.buffer).setUint32(8, 0xffffffff, true);
  new DataView(bytes.buffer).setUint32(12, 0x0000000f, true);
  const table = await readVtable(readOf(bytes), 0x1000n, null, 2, { pointerSize: 4 });
  assert.equal(table.slots[0].raw, 0xffffffffn, 'slot 0 is one 4-byte component');
  assert.equal(table.slots[1].raw, 0x0000000fn, 'slot 1 is the next 4-byte component');
  assert.equal(table.slots.every((slot) => slot.addr == null || slot.addr <= 0xffffffffn), true,
    'no fabricated 64-bit target may survive the ILP32 ceiling');
});

test('#8406 arm64 / arm64e remain 8-byte', async () => {
  for (const architecture of ['arm64', 'arm64e']) {
    const table = await readVtable(readOf(lp64Vtable(-16, 0x3000, 0x4000, 0x5000)), 0x1000n, null, 2, { architecture, pointerBits: 64 });
    assert.equal(table.pointerBytes, 8, `${architecture} stays LP64`);
    assert.equal(table.offsetToTop, -16n);
    assert.equal(table.typeinfo, 0x3000n);
    assert.deepEqual(table.slots.map((slot) => slot.addr), [0x4000n, 0x5000n]);
  }
  // An unknown 64-bit x86 spelling stays 8-byte too.
  const plain = await readVtable(readOf(lp64Vtable(0, 0x3000, 0x4000)), 0x1000n, null, 1);
  assert.equal(plain.pointerBytes, 8);
  assert.equal(plain.offsetToTop, 0n);
});

test('#8406 unsupported or widthless declared pointer ABI fails closed', async () => {
  for (const options of [
    { architecture: 'mips64' },
    { architecture: 'arm64_32' },
    { architecture: 'sparc' },
    { pointerSize: 3 },
    { pointerSize: 16 },
    { pointerBytes: '8' },
    { pointerBits: 32, pointerSize: 8 },
  ]) {
    const table = await readVtable(readOf(ilp32Vtable()), 0x1000n, null, 2, options);
    assert.deepEqual(table.slots, [], `${JSON.stringify(options)} must not mint slots`);
    assert.equal(table.typeinfo, null);
    assert.equal(table.reason, 'unknown-pointer-abi');
    assert.equal(table.typeinfoUnresolved, true);
  }
});

test('#8406 an ILP32 table is not decoded through 64-bit chained-pointer formats', async () => {
  const table = await readVtable(readOf(ilp32Vtable()), 0x1000n, null, 2, {
    architecture: 'arm64_32', pointerBits: 32, pointerFormat: 2, imageBase: 0x100000000n,
  });
  assert.deepEqual(table.slots, []);
  assert.equal(table.reason, 'ilp32-chained-pointer-format-unsupported');
});

test('#8406 the resolver receives the 4-byte raw component and the 4-byte stride', async () => {
  const seen = [];
  const table = await readVtable(
    readOf(ilp32Vtable()),
    0x1000n,
    null,
    2,
    {
      pointerSize: 4,
      resolvePointer: async (raw, context) => {
        seen.push({ raw, address: context.address });
        return { address: raw + 0x1000n };
      },
    },
  );
  assert.deepEqual(seen.map((entry) => entry.raw), [0x3000n, 0x4000n, 0x5000n]);
  assert.deepEqual(seen.map((entry) => entry.address), [0x1004n, 0x1008n, 0x100cn]);
  assert.deepEqual(table.slots.map((slot) => slot.addr), [0x5000n, 0x6000n]);
});

test('#8406 exactSlotCount keeps the 4-byte stride and window', async () => {
  const reads = [];
  const table = await readVtable(readOf(ilp32Vtable(), reads), 0x1000n, null, 64, { pointerSize: 4, slotCount: 2 });
  assert.equal(table.slots.length, 2);
  assert.deepEqual(table.slots.map((slot) => slot.addr), [0x4000n, 0x5000n]);
  assert.deepEqual(reads, [{ address: 0x1000n, length: 16 }], '(slotCount + 2) * 4 bytes');
});

test('#8406 symbol naming still resolves on the ILP32 path', async () => {
  const symbols = { nameAt: (address) => (address === 0x4000n ? '_ZN1B1fEv' : null), label: () => null };
  const table = await readVtable(readOf(ilp32Vtable()), 0x1000n, symbols, 2, { pointerSize: 4 });
  assert.equal(table.slots[0].name, '_ZN1B1fEv');
  assert.equal(table.slots[0].readable, 'B::f()');
  assert.equal(table.slots[1].name, null);
});
