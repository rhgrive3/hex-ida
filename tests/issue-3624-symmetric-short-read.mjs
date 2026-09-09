import assert from 'node:assert/strict';
import { createSymmetricCodeFunctionSet } from '../js/diff/symmetric-function-set.js';

const region = (size) => [{ id:'text', vmAddr:0n, size:BigInt(size), exec:true }];
const symbols = (funcs) => ({ funcs:funcs.map(BigInt), functionStartsComplete:true, nameAt(){ return null; } });

{
  const set = await createSymmetricCodeFunctionSet({
    symbols:symbols([0]), regions:region(4), architecture:'arm64',
    backend:{ async readAt(){ return { found:true, bytes:Uint8Array.from([0xaa,0xbb]) }; } },
  });
  assert.equal(set[0].size, 4);
  assert.equal(set[0].evidenceCompleteness, 'partial');
  assert.equal(set[0].exactBytesHash, null);
  assert.equal(set.complete, false);
  assert.equal(set.missingEvidence, 1);
}

{
  const set = await createSymmetricCodeFunctionSet({
    symbols:symbols([0, 2]), regions:region(4), architecture:'arm64',
    backend:{ async readAt(){ return { found:true, bytes:Uint8Array.from([0xaa,0xbb]) }; } },
  });
  assert.equal(set[0].evidenceCompleteness, 'complete', 'fully observed prefix function remains exact');
  assert.ok(set[0].exactBytesHash);
  assert.equal(set[1].evidenceCompleteness, 'partial', 'function touching short-read suffix is partial');
  assert.equal(set[1].exactBytesHash, null);
  assert.equal(set.missingEvidence, 1);
}

{
  const bytes = Uint8Array.from([1,2,3,4]);
  const set = await createSymmetricCodeFunctionSet({
    symbols:symbols([0]), regions:region(4), architecture:'arm64',
    backend:{ async readAt(_addr, length){ return { found:true, bytes:bytes.subarray(0,length) }; } },
  });
  assert.equal(set[0].evidenceCompleteness, 'complete');
  assert.ok(set[0].exactBytesHash);
  assert.equal(set.complete, true);
}

{
  const size = 65538;
  const bytes = new Uint8Array(size); bytes[0]=1; bytes[size-1]=2;
  const set = await createSymmetricCodeFunctionSet({
    symbols:symbols([0]), regions:region(size), architecture:'arm64', chunkBytes:65536,
    backend:{ async readAt(addr, length){ const start=Number(addr); return { found:true, bytes:bytes.subarray(start,start+length) }; } },
  });
  assert.equal(set[0].evidenceCompleteness, 'complete', 'multi-chunk complete accumulation stays exact');
  assert.equal(set[0].byteSample.length > 0, true);
  assert.equal(set.complete, true);
}

console.log('issue-3624 symmetric short-read completeness: PASS');
