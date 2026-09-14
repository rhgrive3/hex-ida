import assert from 'node:assert/strict';
import { SparseByteBuffer } from '../js/binary/source-reader.js';

const PAGE = 4096;
const PAGES = 256;

const RealUint8Array = globalThis.Uint8Array;
let allocatedBytes = 0;
class CountingUint8Array extends RealUint8Array {
  constructor(...args) {
    super(...args);
    if (typeof args[0] === 'number') allocatedBytes += args[0];
  }
}

const sparse = new SparseByteBuffer(BigInt(PAGE * PAGES));
const pages = [];
for (let i = 0; i < PAGES; i += 1) {
  const page = new CountingUint8Array(PAGE);
  page.fill((i % 251) + 1);
  pages.push(page);
}

globalThis.Uint8Array = CountingUint8Array;
allocatedBytes = 0;
for (let i = 0; i < PAGES; i += 1) {
  sparse.add(BigInt(i * PAGE), pages[i]);
}
const copiedBytes = allocatedBytes;
globalThis.Uint8Array = RealUint8Array;

const totalData = PAGE * PAGES;
assert.ok(
  copiedBytes <= 4 * totalData,
  `sequential adjacent-page add must stay near-linear, copied ${copiedBytes} bytes for ${totalData} bytes of data`,
);
assert.equal(sparse.chunks.length, PAGES, 'adjacent pages must remain independent segments');

for (let i = 0; i < PAGES; i += 1) {
  assert.equal(sparse.chunks[i].bytes.length, PAGE, 'no segment may balloon to the whole prefix');
}

for (let i = 0; i < PAGES; i += 1) {
  const view = sparse.subarray(BigInt(i * PAGE), BigInt((i + 1) * PAGE));
  assert.deepEqual([...view], [...pages[i]], `page ${i} byte-exact`);
}

const span = sparse.subarray(0n, BigInt(PAGE * PAGES));
assert.equal(span.length, totalData);
for (let i = 0; i < PAGES; i += 1) {
  for (let j = 0; j < PAGE; j += 4) {
    assert.equal(span[i * PAGE + j], pages[i][j], `cross-chunk byte ${i}:${j}`);
  }
}

const over = new SparseByteBuffer(64n);
assert.equal(over.add(0n, Uint8Array.of(1, 2, 3, 4)), 4);
assert.equal(over.add(2n, Uint8Array.of(9, 9, 9, 9)), 2);
assert.equal(over.chunks.length, 1, 'overlapping ranges must still coalesce (last-write-wins)');
assert.deepEqual([...over.subarray(0n, 6n)], [1, 2, 9, 9, 9, 9]);

const disjoint = new SparseByteBuffer(1000n);
disjoint.add(100n, new Uint8Array(10).fill(7));
disjoint.add(900n, new Uint8Array(10).fill(8));
assert.equal(disjoint.chunks.length, 2, 'disjoint ranges must be retained independently');
assert.deepEqual([...disjoint.subarray(100n, 110n)], new Array(10).fill(7));
assert.deepEqual([...disjoint.subarray(900n, 910n)], new Array(10).fill(8));

console.log(`issue-3948-sparse-buffer-linear-copy: PASS (copied ${copiedBytes} bytes, linear bound ${4 * totalData})`);
