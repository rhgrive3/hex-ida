import assert from 'node:assert/strict';
import { MemoryByteSource } from '../js/binary/source.js';
import { hashByteSource, sha256TreeByteSource } from '../js/platform/hash.js';

const bytes = Uint8Array.of(1, 2, 3, 4, 5);
const source = () => new MemoryByteSource(bytes, { maxReadLength: 2 });
const expectedFnv = await hashByteSource(source(), { chunkSize: 2 });
const expectedTree = await sha256TreeByteSource(source(), { chunkSize: 2 });

for (const onProgress of [true, {}, [], 1]) {
  assert.equal(await hashByteSource(source(), { chunkSize: 2, onProgress }), expectedFnv);
  assert.equal(await sha256TreeByteSource(source(), { chunkSize: 2, onProgress }), expectedTree);
}

const fnvProgress = [];
assert.equal(await hashByteSource(source(), { chunkSize: 2, onProgress: (value) => fnvProgress.push(value) }), expectedFnv);
assert.deepEqual(fnvProgress, [
  { done: 2n, total: 5n },
  { done: 4n, total: 5n },
  { done: 5n, total: 5n },
]);

const treeProgress = [];
assert.equal(await sha256TreeByteSource(source(), { chunkSize: 2, onProgress: (value) => treeProgress.push(value) }), expectedTree);
assert.deepEqual(treeProgress, fnvProgress);
console.log('issue-3857-platform-hash-progress: PASS');
