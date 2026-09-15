import assert from 'node:assert/strict';
import { analyzeFunction } from '../js/analyze.js';

function backend(lines) {
  const mn = lines.map((l) => l[0]);
  const ops = lines.map((l) => l[1] || '');
  return { async fetchChunk() { return { mn, ops, bytes: null }; } };
}

async function frameBytes(lines) {
  const region = { id: 'issue-3913', vmAddr: 0x100000n, size: BigInt(lines.length * 4) };
  const res = await analyzeFunction(backend(lines), region, 0, lines.length - 1, null, null, { texts: false });
  return res.frameBytes;
}

// 1. Repeated allocate/free of the same depth is a max, not a sum.
assert.equal(await frameBytes([
  ['sub', 'sp, sp, #32'], ['add', 'sp, sp, #32'],
  ['sub', 'sp, sp, #32'], ['add', 'sp, sp, #32'],
  ['ret'],
]), 32, 'oscillating sub/add must report max depth 32');

// 2. Repeated pre/post-index pair spill/reload must not accumulate.
assert.equal(await frameBytes([
  ['stp', 'x29, x30, [sp, #-16]!'], ['ldp', 'x29, x30, [sp], #16'],
  ['stp', 'x19, x20, [sp, #-16]!'], ['ldp', 'x19, x20, [sp], #16'],
  ['ret'],
]), 16, 'two reuse cycles of a 16-byte slot must report 16');

// 3. Nested allocation is the true peak.
assert.equal(await frameBytes([
  ['sub', 'sp, sp, #16'], ['sub', 'sp, sp, #32'], ['ret'],
]), 48, 'nested 16 + 32 is a 48-byte peak');

// 4. Mutually-exclusive branch arms must not be summed.
assert.equal(await frameBytes([
  ['cbz', 'x0, #0x100010'],
  ['sub', 'sp, sp, #16'], ['add', 'sp, sp, #16'], ['b', '#0x100014'],
  ['sub', 'sp, sp, #32'], ['add', 'sp, sp, #32'],
  ['ret'],
]), 32, 'exclusive 16/32 arms must report max 32, not 48');


// 5. Equal-depth CFG predecessors must merge without double-counting.
assert.equal(await frameBytes([
  ['cbz', 'x0, #0x10000c'],
  ['sub', 'sp, sp, #32'],
  ['b', '#0x100010'],
  ['sub', 'sp, sp, #32'],
  ['add', 'sp, sp, #32'],
  ['ret'],
]), 32, 'equal-depth diamond predecessors must not sum to 64');

// 6. Unproven SP rebase must not be mixed into exact depth.
assert.equal(await frameBytes([
  ['sub', 'sp, x28, #32'], ['ret'],
]), 0, 'SUB SP,Xn,#imm is not a provable allocation');

// 7. LSL #12 effective immediate is preserved.
assert.equal(await frameBytes([
  ['sub', 'sp, sp, #1, lsl #12'], ['ret'],
]), 4096, 'LSL #12 effective immediate still counts');

console.log('issue #3913 frameBytes max stack depth: PASS');
