import assert from 'node:assert/strict';
import test from 'node:test';

import { NodeFileByteSource } from '../js/bytesource/node.js';

test('NodeFileByteSource preserves bigint file positions beyond Number.MAX_SAFE_INTEGER', async () => {
  const target = (1n << 53n) + 1n;
  const positions = [];
  const handle = {
    async read(buffer, offset, length, position) {
      positions.push(position);
      buffer[offset] = 0x41 + positions.length - 1;
      return { bytesRead: 1, buffer };
    },
    async close() {},
  };

  const source = new NodeFileByteSource(handle, target + 3n, { maxReadLength: 3 });
  const bytes = await source.read(target, 3);

  assert.deepEqual([...bytes], [0x41, 0x42, 0x43]);
  assert.deepEqual(positions, [target, target + 1n, target + 2n]);
  assert.ok(positions.every((position) => typeof position === 'bigint'));
});

test('NodeFileByteSource keeps ordinary positions lossless and enforces read-size bounds', async () => {
  const positions = [];
  const handle = {
    async read(buffer, offset, length, position) {
      positions.push(position);
      buffer.fill(0x5a, offset, offset + length);
      return { bytesRead: length, buffer };
    },
    async close() {},
  };

  const source = new NodeFileByteSource(handle, 64n, { maxReadLength: 4 });
  assert.deepEqual([...await source.read(7, 4)], [0x5a, 0x5a, 0x5a, 0x5a]);
  assert.deepEqual(positions, [7n]);
  assert.throws(() => source.validateRange(7, 5), /exceeds the 4-byte limit/);
  assert.throws(() => source.validateRange(-1, 1), /must be non-negative/);
  assert.throws(() => source.validateRange(63, 2), /read outside source/);
});
