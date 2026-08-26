import assert from 'node:assert/strict';
import { PagedArtifactReader } from '../js/core/artifacts/paging/index.js';

let aborted = false;
const signal = {
  get aborted() { return aborted; },
  addEventListener(type) {
    assert.equal(type, 'abort');
    aborted = true; // simulate abort after the pre-check but before subscription becomes observable
  },
  removeEventListener() {},
};

const source = {
  size: 1n,
  maxReadLength: 1,
  async readExactly() { return Uint8Array.of(0x41); },
};

const reader = new PagedArtifactReader(source, {
  sourceId: 'abort-race',
  pageSize: 1,
  maxRangeBytes: 1,
  maxRetainedPageBytes: 1,
});

await assert.rejects(
  () => reader.readPage(0n, { signal }),
  (error) => error?.name === 'ByteSourceCancelledError',
);
assert.equal(reader.metrics().cancelledRequests, 1);
console.log('paged-artifact-abort-subscribe-race: PASS');
