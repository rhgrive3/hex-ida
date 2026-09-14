import assert from 'node:assert/strict';
import { BinaryImage, MAX_VIRTUAL_READ_BYTES } from '../../../js/binary/model.js';

const huge = BigInt(Number.MAX_SAFE_INTEGER);
const resident = new BinaryImage(new Uint8Array([0]));
resident.addSegment({
  name: 'huge-bss',
  address: 0n,
  size: huge,
  fileOffset: 0n,
  fileSize: 0n,
  perms: { read: true, write: true },
});

assert.equal(resident.readVirtual(0n, huge), null);
assert.equal(resident.readVirtual(0n, BigInt(MAX_VIRTUAL_READ_BYTES) + 1n), null);

const source = {
  size: 1n,
  async readExactly() {
    throw new Error('zero-fill guard should prevent source reads');
  },
};
const streamed = new BinaryImage(null, { source, fileSize: 1n });
streamed.addSegment({
  name: 'huge-bss',
  address: 0n,
  size: huge,
  fileOffset: 0n,
  fileSize: 0n,
  perms: { read: true, write: true },
});
assert.equal(await streamed.readVirtualAsync(0n, huge), null);

const normal = new BinaryImage(new Uint8Array([1, 2, 3]));
normal.addSegment({ address: 0n, size: 3n, fileOffset: 0n, fileSize: 3n, perms: { read: true } });
assert.deepEqual([...normal.readVirtual(0n, 3n)], [1, 2, 3]);

console.log('issue #3987 BinaryImage virtual-read materialization limit: PASS');
