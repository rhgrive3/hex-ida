import assert from 'node:assert/strict';
import { MemoryByteSource } from '../../js/binary/source.js';
import { hashByteSource, sha256TreeByteSource } from '../../js/platform/hash.js';

const bytes = Uint8Array.of(1, 2, 3, 4, 5);
const source = () => new MemoryByteSource(bytes, { maxReadLength: 2 });
const expectedFnv = await hashByteSource(source(), { chunkSize: 2 });
const expectedTree = await sha256TreeByteSource(source(), { chunkSize: 2 });

for (const onProgress of [undefined, null, true, {}, [], 1]) {
  assert.equal(await hashByteSource(source(), { chunkSize: 2, onProgress }), expectedFnv);
  assert.equal(await sha256TreeByteSource(source(), { chunkSize: 2, onProgress }), expectedTree);
}

const expectedProgress = [
  { done: 2n, total: 5n },
  { done: 4n, total: 5n },
  { done: 5n, total: 5n },
];

const fnvProgress = [];
assert.equal(
  await hashByteSource(source(), { chunkSize: 2, onProgress: (value) => fnvProgress.push(value) }),
  expectedFnv,
);
assert.deepEqual(fnvProgress, expectedProgress);

const treeProgress = [];
assert.equal(
  await sha256TreeByteSource(source(), { chunkSize: 2, onProgress: (value) => treeProgress.push(value) }),
  expectedTree,
);
assert.deepEqual(treeProgress, expectedProgress);

for (const hash of [hashByteSource, sha256TreeByteSource]) {
  await assert.rejects(
    hash(source(), { chunkSize: 0 }),
    /chunkSize must be a positive safe integer/,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    hash(source(), { chunkSize: 2, signal: controller.signal }),
    (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR',
  );
}

console.log('issue-3857-platform-hash-progress: PASS');
