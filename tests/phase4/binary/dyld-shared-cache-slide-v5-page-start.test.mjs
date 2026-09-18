import assert from 'node:assert/strict';
import test from 'node:test';

import { walkSlideInfo5Source } from '../../../js/binary/dyld-shared-cache-slide-v5.js';

test('dyld slide-info v5 page_starts entries are byte offsets', async () => {
  const mapping = {
    address: 0x180000000n,
    size: 0x4000n,
    fileOffset: 0x2000n,
  };
  const info = {
    pageSize: 0x4000,
    starts: [0x58],
    valueAdd: mapping.address,
  };
  const reads = [];
  const read64 = async (offset) => {
    reads.push(offset);
    return 0n;
  };

  const records = await walkSlideInfo5Source(read64, mapping, info, 0n, [mapping], 4);

  assert.deepEqual(reads, [mapping.fileOffset + 0x58n]);
  assert.equal(records.length, 1);
  assert.equal(records[0].storageAddress, mapping.address + 0x58n);
  assert.equal(records[0].targetAddress, mapping.address);
});
