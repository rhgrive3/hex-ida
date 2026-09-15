import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

const PT_LOAD = 1, PT_DYNAMIC = 2, PF_R = 4;
const MAX_PT_DYNAMIC_ENTRIES = 100_000;

function oversizedDynamicElf(neededCount) {
  const ehsize = 64, phentsize = 56, dynoff = 0x200;
  const dynEntries = 2 + neededCount + 1;
  const dynSize = dynEntries * 16;
  const strOff = dynoff + dynSize;
  const str = Buffer.from('\0x\0', 'latin1');
  const fileLen = strOff + str.length;
  const b = Buffer.alloc(fileLen);
  b.set([0x7f, 0x45, 0x4c, 0x46], 0);
  b.writeUInt8(2, 4); b.writeUInt8(1, 5); b.writeUInt8(1, 6);
  b.writeUInt16LE(3, 16); b.writeUInt16LE(62, 18); b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(0n, 24); b.writeBigUInt64LE(BigInt(ehsize), 32); b.writeBigUInt64LE(0n, 40);
  b.writeUInt32LE(0, 48); b.writeUInt16LE(ehsize, 52); b.writeUInt16LE(phentsize, 54); b.writeUInt16LE(2, 56);

  const p0 = ehsize;
  b.writeUInt32LE(PT_LOAD, p0); b.writeUInt32LE(PF_R, p0 + 4);
  b.writeBigUInt64LE(0n, p0 + 8); b.writeBigUInt64LE(0x400000n, p0 + 16); b.writeBigUInt64LE(0x400000n, p0 + 24);
  b.writeBigUInt64LE(BigInt(fileLen), p0 + 32); b.writeBigUInt64LE(BigInt(fileLen), p0 + 40); b.writeBigUInt64LE(1n, p0 + 48);

  const p1 = ehsize + phentsize;
  b.writeUInt32LE(PT_DYNAMIC, p1); b.writeUInt32LE(PF_R, p1 + 4);
  b.writeBigUInt64LE(BigInt(dynoff), p1 + 8); b.writeBigUInt64LE(0x400000n + BigInt(dynoff), p1 + 16); b.writeBigUInt64LE(0x400000n + BigInt(dynoff), p1 + 24);
  b.writeBigUInt64LE(BigInt(dynSize), p1 + 32); b.writeBigUInt64LE(BigInt(dynSize), p1 + 40); b.writeBigUInt64LE(1n, p1 + 48);

  b.set(str, strOff);
  let d = dynoff;
  const writeDyn = (tag, value) => {
    b.writeBigUInt64LE(BigInt(tag), d);
    b.writeBigUInt64LE(BigInt(value), d + 8);
    d += 16;
  };
  writeDyn(5, 0x400000 + strOff); // DT_STRTAB
  writeDyn(10, str.length);        // DT_STRSZ
  for (let i = 0; i < neededCount; i++) writeDyn(1, 1); // DT_NEEDED
  writeDyn(0, 0);                  // DT_NULL lies beyond the pre-budget prefix
  return b;
}

test('#8688 PT_DYNAMIC tag materialization is bounded before string budgets exist', () => {
  const img = parseELF(oversizedDynamicElf(MAX_PT_DYNAMIC_ENTRIES + 1));

  assert.equal(img.metadata.programDynamicPreBudgetPartial, true);
  assert.equal(img.metadata.programDynamicPartial, true);
  assert.ok(img.libraries.length <= MAX_PT_DYNAMIC_ENTRIES);
  assert.ok(img.warnings.some((warning) => warning.includes('PT_DYNAMIC entry materialization bounded')));
});
