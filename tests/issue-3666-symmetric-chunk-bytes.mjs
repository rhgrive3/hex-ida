import assert from 'node:assert/strict';
import { createSymmetricCodeFunctionSet } from '../js/diff/symmetric-function-set.js';

function fixture(chunkBytes) {
  const lengths = [];
  const backend = {
    async readAt(_address, length) {
      lengths.push(length);
      assert.equal(Number.isSafeInteger(length), true, 'backend read length must be a safe integer');
      assert.ok(length > 0);
      return { found:true, bytes:new Uint8Array(length) };
    },
  };
  const symbols = {
    funcs:[0n],
    functionStartsComplete:true,
    nameAt() { return null; },
  };
  const regions = [{ id:'text', exec:true, vmAddr:0n, size:4n }];
  return createSymmetricCodeFunctionSet({ backend, symbols, regions, architecture:'arm64', chunkBytes })
    .then((result) => ({ result, lengths }));
}

for (const chunkBytes of [65536.5, NaN, Infinity, -1, 0]) {
  const { result, lengths } = await fixture(chunkBytes);
  assert.equal(result.complete, true);
  assert.deepEqual(lengths, [4]);
}

for (const chunkBytes of [65536, '65536', 8 * 1024 * 1024]) {
  const { result, lengths } = await fixture(chunkBytes);
  assert.equal(result.complete, true);
  assert.deepEqual(lengths, [4]);
}

console.log('issue-3666 symmetric chunkBytes integer contract: PASS');
