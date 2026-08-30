import assert from 'node:assert/strict';
import { ByteSource } from '../../js/binary/source.js';
import { PagedArtifactReader } from '../../js/core/artifacts/paging/index.js';

// Regression for #2701: clear() is a publication barrier even for non-cooperative sources.
class DeferredNonCooperativeSource extends ByteSource {
  constructor() {
    super(4n, { maxReadLength:4 });
    this.pending = [];
  }

  async readExactly() {
    return new Promise((resolve) => {
      this.pending.push(() => resolve(new Uint8Array([1, 2, 3, 4])));
    });
  }

  resolveNext() {
    const resolve = this.pending.shift();
    assert.ok(resolve, 'expected a pending source read');
    resolve();
  }
}

const source = new DeferredNonCooperativeSource();
const reader = new PagedArtifactReader(source, {
  sourceId:'issue-2701',
  pageSize:4,
  maxRangeBytes:4,
  maxRetainedPageBytes:4,
  maxPrefetchPages:0,
});

const oldRead = reader.readPage(0n);
await Promise.resolve();
assert.equal(source.pending.length, 1);

reader.clear();
assert.equal(reader.metrics().retainedPages, 0);
assert.equal(reader.metrics().pendingRequests, 0);

const newRead = reader.readPage(0n);
await Promise.resolve();
assert.equal(source.pending.length, 2);
assert.equal(reader.metrics().pendingRequests, 1);

source.resolveNext();
await oldRead;
await Promise.resolve();
assert.equal(reader.metrics().retainedPages, 0, 'pre-clear completion must not republish its page');
assert.equal(reader.metrics().retainedPageBytes, 0, 'pre-clear completion must not restore retained bytes');
assert.equal(reader.metrics().pendingRequests, 1, 'old finally must not remove the post-clear in-flight entry');

source.resolveNext();
await newRead;
assert.equal(reader.metrics().retainedPages, 1, 'post-clear request may populate the cache normally');
assert.equal(reader.metrics().retainedPageBytes, 4);

console.log('paged artifact clear race: PASS');
