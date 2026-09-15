// Issue #8870 regression: sparse ByteView.cstring() must scan strictly
// forward from the string start. Rounding back to a read-ahead boundary
// demands bytes before the string and fabricates budget failures for fully
// cached inputs.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../js/binary/reader.js';
import { SparseByteBuffer } from '../js/binary/source-reader.js';

const HIGH = (1n << 53n) + 1n;

test('#8870 cstring reads a fully cached string without its pre-gap', () => {
  const sparse = new SparseByteBuffer(HIGH + 4n);
  sparse.readAheadSize = 64 * 1024;
  sparse.add(HIGH, Uint8Array.of(0x48, 0x69, 0x00));
  const view = new ByteView(sparse);
  assert.equal(view.cstring(HIGH, 8), 'Hi');
});

test('#8870 cstring at a read-ahead boundary needs no prior block', () => {
  // start one past a 64 KiB boundary with nothing cached before it.
  const start = 0x10000n + 1n;
  const sparse = new SparseByteBuffer(start + 4n);
  sparse.readAheadSize = 64 * 1024;
  sparse.add(start, Uint8Array.of(0x41, 0x00));
  const view = new ByteView(sparse);
  assert.equal(view.cstring(start, 8), 'A');
});
