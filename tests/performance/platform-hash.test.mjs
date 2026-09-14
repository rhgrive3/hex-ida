import test from 'node:test';
import assert from 'node:assert/strict';
import * as current from '../../js/platform/hash.js';
import * as original from '../helpers/platform-hash-baseline-oracle.mjs';
import { MemoryByteSource, ByteSource } from '../../js/binary/source.js';

async function observed(hash, bytes, chunkSize, maxReadLength) {
  const source = new MemoryByteSource(bytes, { maxReadLength });
  const reads = [], progress = [];
  const read = source.readExactly.bind(source);
  source.readExactly = async (...args) => { reads.push(args.slice(0, 2)); return read(...args); };
  const options = { chunkSize, onProgress(event) { assert.equal(this, options); progress.push(event); } };
  return { result: await hash(source, options), reads, progress };
}

test('streaming FNV preserves every chunk boundary, read ceiling and progress event', async () => {
  for (const size of [0, 1, 31, 1025, 65539]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 137 + (i >>> 8)) & 255);
    for (const [chunk, max] of [[1, 1024], [31, 17], [1024, 333], [4096, 65536]]) {
      assert.deepEqual(await observed(current.hashByteSource, bytes, chunk, max),
        await observed(original.hashByteSource, bytes, chunk, max));
    }
  }
});

test('hash cancellation, invalid chunks and progress exceptions match the original boundary', async () => {
  for (const hash of [original.hashByteSource, current.hashByteSource]) {
    for (const chunkSize of [0, -1, 0.5, NaN, Infinity, '8']) {
      await assert.rejects(hash(new Uint8Array(8), { chunkSize }), { name: 'TypeError', message: 'chunkSize must be a positive safe integer' });
    }
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(hash(new Uint8Array(8), { signal: aborted.signal }), { name: 'AbortError', code: 'ABORT_ERR', message: 'hash cancelled' });
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(hash(new Uint8Array(8), { chunkSize: 2, signal: controller.signal,
      onProgress() { calls++; controller.abort(); } }), { name: 'AbortError' });
    assert.equal(calls, 1);
    const error = new Error('callback-error');
    await assert.rejects(hash(new Uint8Array(4), { onProgress() { throw error; } }), (observed) => observed === error);
  }
});

test('streaming reads ignore byte iterators; public hashBytes still honors them', async () => {
  const bytes = Uint8Array.of(1, 2, 3, 4);
  let iteratorReads = 0;
  bytes[Symbol.iterator] = function* () { iteratorReads++; yield 255; };
  class Source extends ByteSource {
    constructor() { super(4); }
    async read() { return bytes; }
  }
  const source = new Source();
  assert.equal(await current.hashByteSource(source), await original.hashByteSource(source));
  assert.equal(iteratorReads, 0);
  assert.equal(current.hashBytes(bytes), original.hashBytes(bytes));
  assert.equal(iteratorReads, 2);
});
