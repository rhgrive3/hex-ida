import assert from 'node:assert/strict';
import './issue-4512-diff-abort-registration-race.mjs';
import { compareFingerprints, diffFunctions, fingerprintFunction } from '../js/diff/index.js';
import { createSymmetricCodeFunctionSet } from '../js/diff/symmetric-function-set.js';

// #3666: byte-count options must reach the backend as integral chunks.
for (const [chunkBytes, expectedChunk] of [
  [65536.5, 65536],
  [65537, 65537],
  [12, 65536],
  [9 * 1024 * 1024, 8 * 1024 * 1024],
  [undefined, 2 * 1024 * 1024],
]) {
  const reads = [];
  const start = 0x1000n;
  const result = await createSymmetricCodeFunctionSet({
    backend: {
      readAt(address, length) {
        reads.push({ address, length });
        assert.ok(Number.isSafeInteger(length) && length > 0);
        return Promise.resolve({ found:false });
      },
    },
    symbols: { funcs:[start], functionStartsComplete:true },
    regions: [{ id:'text', exec:true, vmAddr:start, size:BigInt(expectedChunk + 4) }],
    chunkBytes,
  });
  assert.deepEqual(reads, [
    { address:start, length:expectedChunk },
    { address:start + BigInt(expectedChunk), length:4 },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result.complete, false, 'unavailable bytes remain incomplete');
}

const base = { address: 0x1000n, bytes: Uint8Array.from([1,2,3,4,5,6,7,8]), cfg: { blocks: 2, edges: 1, exits: 1 }, strings: ['coins'], imports: ['memcpy'], calls: ['helper'], constants: [100] };
let diff = diffFunctions([base], [{ ...base }]);
assert.equal(diff.matches[0].status, 'identical');

diff = diffFunctions([base], [{ ...base, address: 0x781000n }]);
assert.equal(diff.matches[0].status, 'moved');
assert.ok(diff.matches[0].confidence > 0.9);

diff = diffFunctions([base], [{ ...base, address: 0x781000n, bytes: Uint8Array.from([1,2,3,4,5,6,9,8]), constants: [101] }]);
assert.equal(diff.matches[0].status, 'rewritten');
assert.equal(diff.matches[0].changeType, 'rewritten');
assert.ok(diff.matches[0].confidence >= 0.62);

// #3890: general operation-set changes must not disappear from the summary.
{
  const summarize = (before, after) => {
    const result = diffFunctions([{ ...base, ...before }], [{ ...base, ...after }]);
    assert.equal(result.matches.length, 1);
    return result.matches[0].semanticChange;
  };
  for (const [before, after] of [
    [['add'], ['sub']], [['and'], ['xor']], [[], ['add']], [['sub'], []],
  ]) {
    const change = summarize({ semantic:{ operations:before } }, { semantic:{ operations:after } });
    assert.equal(change.changed, true, `${before} -> ${after} must be a semantic change`);
    assert.deepEqual(change.addedOperations, after);
    assert.deepEqual(change.removedOperations, before);
    assert.deepEqual(change.tags, ['operations-changed']);
  }
  for (const [before, after] of [
    [{}, {}],
    [{ operations:['add', 'xor', 'add'] }, { operations:['xor', 'add'] }],
  ]) {
    const same = summarize({ semantic:before }, { semantic:after });
    assert.equal(same.changed, false, 'operation order and duplicates are not set changes');
    assert.deepEqual(same.addedOperations, []);
    assert.deepEqual(same.removedOperations, []);
    assert.deepEqual(same.tags, []);
  }
  for (const operation of ['clamp', 'min', 'max', 'saturate']) {
    const introduced = summarize({ semantic:{ operations:[] } }, { semantic:{ operations:[operation] } });
    assert.ok(introduced.tags.includes('clamp-introduced'));
    assert.ok(introduced.tags.includes('operations-changed'));
    const removed = summarize({ semantic:{ operations:[operation] } }, { semantic:{ operations:[] } });
    assert.ok(removed.tags.includes('clamp-removed'));
    assert.ok(removed.tags.includes('operations-changed'));
  }
  const overlapping = summarize(
    { semantic:{ operations:['min', 'add', 'add'] } },
    { semantic:{ operations:['max', 'add', 'max'] } },
  );
  assert.equal(overlapping.changed, true);
  assert.deepEqual(overlapping.addedOperations, ['max']);
  assert.deepEqual(overlapping.removedOperations, ['min']);
  assert.deepEqual(overlapping.tags, ['operations-changed'], 'changing clamp operations does not introduce/remove the clamp family');
  const other = summarize(
    { constants:[1], calls:['old'], semantic:{ operations:['add'], writes:['x0'] } },
    { constants:[2], calls:['new'], semantic:{ operations:['add'], writes:['x1'] } },
  );
  assert.equal(other.changed, true);
  assert.deepEqual(other.addedConstants, ['2']);
  assert.deepEqual(other.removedConstants, ['1']);
  assert.deepEqual(other.addedCalls, ['new']);
  assert.deepEqual(other.removedCalls, ['old']);
  assert.deepEqual(other.addedWrites, ['x1']);
  assert.deepEqual(other.removedWrites, ['x0']);
  assert.deepEqual(other.tags, ['constants-added', 'calls-added', 'write-set-changed']);
}

const relocation = [{ offset: 0, width: 8 }];
const fp = fingerprintFunction({ ...base, relocationOffsets: relocation });
const movedReloc = fingerprintFunction({ ...base, address: 9n, bytes: Uint8Array.from([9,9,9,9,9,9,9,9]), relocationOffsets: relocation });
assert.equal(fp.normalizedByteHash, movedReloc.normalizedByteHash);

// #4518: structured relocation coordinates are unknown metadata, never mask authority.
const malformedReloc = fingerprintFunction({
  architecture: 'arm64', size: 4, bytes: Uint8Array.from([1,2,3,4]),
  relocationRanges: [{ offset: ['0'], width: ['4'] }],
});
const validReloc = fingerprintFunction({
  architecture: 'arm64', size: 4, bytes: Uint8Array.from([9,8,7,6]),
  relocationRanges: [{ offset: 0, width: 4 }],
});
const originalReloc = fingerprintFunction({ architecture: 'arm64', size: 4, bytes: Uint8Array.from([1,2,3,4]) });
assert.equal(malformedReloc.relocationNormalization.masked, 0);
assert.equal(malformedReloc.relocationNormalization.unknown, 1);
assert.equal(malformedReloc.relocationNormalization.confidence, 0.65);
assert.equal(malformedReloc.normalizedByteHash, originalReloc.normalizedByteHash);
assert.notEqual(compareFingerprints(malformedReloc, validReloc).identity, 'normalized-identical');

const malformedLength = fingerprintFunction({
  architecture: 'arm64', size: 4, bytes: Uint8Array.from([1,2,3,4]),
  relocationRanges: [{ offset: 0, length: ['2'] }],
});
const malformedRLength = fingerprintFunction({
  architecture: 'arm64', size: 4, bytes: Uint8Array.from([1,2,3,4]),
  relocationRanges: [{ offset: 0, r_length: { valueOf: () => 2 } }],
});
assert.equal(malformedLength.normalizedByteHash, originalReloc.normalizedByteHash);
assert.equal(malformedLength.relocationNormalization.masked, 0);
assert.equal(malformedLength.relocationNormalization.confidence, 0.65);
assert.equal(malformedRLength.normalizedByteHash, originalReloc.normalizedByteHash);
assert.equal(malformedRLength.relocationNormalization.masked, 0);
assert.equal(malformedRLength.relocationNormalization.confidence, 0.65);

// Missing metadata is absence of evidence, not perfect semantic similarity.
const sparseA = fingerprintFunction({ address: 1n, size: 64, bytes: Uint8Array.from({ length: 64 }, (_, i) => i) });
const sparseB = fingerprintFunction({ address: 2n, size: 64, bytes: Uint8Array.from({ length: 64 }, (_, i) => i < 40 ? i : 255 - i) });
const sparseCmp = compareFingerprints(sparseA, sparseB);
assert.ok(!sparseCmp.reasons.includes('strings'));
assert.ok(!sparseCmp.reasons.includes('imports'));
assert.ok(!sparseCmp.reasons.includes('cfg-shape'));

// Empty byte arrays are not an exact fingerprint shared by unrelated functions.
const emptyA = fingerprintFunction({ address: 3n, bytes: new Uint8Array(0) });
const emptyB = fingerprintFunction({ address: 4n, bytes: new Uint8Array(0) });
assert.equal(compareFingerprints(emptyA, emptyB).reasons.includes('normalized-bytes'), false);
assert.equal(diffFunctions([emptyA], [emptyB]).matches.length, 0);


// #514: candidate-graph truncation must not become confidence-1 deletion/addition.
{
  const before=Array.from({length:4},(_x,i)=>({ ...base,address:0x10000n+BigInt(i*0x20) }));
  const after=Array.from({length:4},(_x,i)=>({ ...base,address:0x20000n+BigInt(i*0x20) }));
  const partial=diffFunctions(before,after,{
    maxCandidates:4,maxBucketScan:4,
    matchBudget:{maxCandidateEvaluations:1,maxCandidateEdges:32,maxWallMs:10_000},
  });
  assert.equal(partial.complete,false);
  assert.equal(partial.matching.candidateGraphIncomplete,true);
  assert.equal(partial.deleted.length,0);
  assert.equal(partial.new.length,0);
  assert.equal(partial.unresolved.length,8);
  assert.ok(partial.unresolved.every((x)=>x.confidence===0&&x.status==='unresolved'));
}

// #514: an oversized ambiguity component is unresolved, never a mass delete/add.
{
  const before=Array.from({length:4},(_x,i)=>({ ...base,address:0x30000n+BigInt(i*0x20) }));
  const after=Array.from({length:4},(_x,i)=>({ ...base,address:0x40000n+BigInt(i*0x20) }));
  const partial=diffFunctions(before,after,{
    maxCandidates:4,maxBucketScan:4,
    matchBudget:{maxCandidateEvaluations:100,maxCandidateEdges:100,maxComponentNodes:4,maxComponentEdges:100,maxWallMs:10_000},
  });
  assert.equal(partial.complete,false);
  assert.ok(partial.matching.truncatedComponents.some((x)=>x.reason==='component-budget'));
  assert.equal(partial.deleted.length,0);
  assert.equal(partial.new.length,0);
  assert.equal(partial.unresolved.length,8);
}

// #514: exact-solver exhaustion discards partial certainty at the facade too.
{
  const before=Array.from({length:3},(_x,i)=>({ ...base,address:0x50000n+BigInt(i*0x20) }));
  const after=Array.from({length:3},(_x,i)=>({ ...base,address:0x60000n+BigInt(i*0x20) }));
  const partial=diffFunctions(before,after,{
    maxCandidates:3,maxBucketScan:3,
    matchBudget:{maxCandidateEvaluations:100,maxCandidateEdges:100,maxComponentNodes:100,maxComponentEdges:100,maxSolverRelaxations:1,maxSolverAugmentations:100,maxWallMs:10_000},
  });
  assert.equal(partial.complete,false);
  assert.match(partial.matching.budget.reason,/solver relaxations/);
  assert.equal(partial.deleted.length,0);
  assert.equal(partial.new.length,0);
  assert.equal(partial.unresolved.length,6);
}

// #514: when matching is complete, real unmatched functions retain definitive status.
{
  const removed={ ...base,address:0x70000n,bytes:Uint8Array.from([1,1,1,1,1,1,1,1]),strings:['removed-only'],calls:[],constants:[7] };
  const addedOnly={ ...base,address:0x80000n,bytes:Uint8Array.from([9,9,9,9,9,9,9,9]),strings:['added-only'],calls:['different'],constants:[9999] };
  const gone=diffFunctions([removed],[],{threshold:0.95});
  assert.equal(gone.complete,true);
  assert.equal(gone.deleted.length,1);
  assert.equal(gone.deleted[0].confidence,1);
  assert.equal(gone.unresolved.length,0);
  const fresh=diffFunctions([],[addedOnly],{threshold:0.95});
  assert.equal(fresh.complete,true);
  assert.equal(fresh.new.length,1);
  assert.equal(fresh.new[0].confidence,1);
  assert.equal(fresh.unresolved.length,0);
}

// #4514: symmetric fingerprint budgets are discrete.  Fractional values must
// be normalized before Array/BigInt consumers, while malformed values must not
// be coerced into a caller-selected budget.
{
  const region = { id:'text', exec:true, vmAddr:0n, size:70_000n };
  const symbols = { funcs:[0n, 1n], functionStartsComplete:true, nameAt:() => null };
  const reads = [];
  const backend = {
    readAt(_address, length) {
      assert.equal(Number.isSafeInteger(length), true);
      reads.push(length);
      return Promise.resolve({ found:true, bytes:new Uint8Array(length) });
    },
  };

  const fractionalLimit = await createSymmetricCodeFunctionSet({
    backend, symbols, regions:[region], limit:1.5,
  });
  assert.equal(fractionalLimit.length, 1);
  assert.equal(fractionalLimit.scanned, 1);
  assert.equal(fractionalLimit.total, 2);
  assert.equal(fractionalLimit.complete, false);
  assert.equal(fractionalLimit.truncationReason, 'function-budget');

  reads.length = 0;
  const fractionalChunk = await createSymmetricCodeFunctionSet({
    backend,
    symbols:{ ...symbols, funcs:[0n] },
    regions:[region],
    chunkBytes:65_536.5,
  });
  assert.deepEqual(reads, [65_536, 4_464]);
  assert.equal(fractionalChunk.complete, true);
  assert.equal(fractionalChunk.scanned, 1);
  assert.equal(fractionalChunk.missingEvidence, 0);
  assert.equal(fractionalChunk.truncationReason, null);

  const zeroLimit = await createSymmetricCodeFunctionSet({
    backend, symbols, regions:[region], limit:0,
  });
  assert.equal(zeroLimit.length, 0);
  assert.equal(zeroLimit.scanned, 0);
  assert.equal(zeroLimit.truncationReason, 'function-budget');

  const malformedLimit = await createSymmetricCodeFunctionSet({
    backend, symbols, regions:[region], limit:'1',
  });
  assert.equal(malformedLimit.scanned, 2, 'numeric-string limit must use the default, not coercion');

  const largeRegion = { ...region, size:2n * 1024n * 1024n + 1n };
  reads.length = 0;
  await createSymmetricCodeFunctionSet({
    backend,
    symbols:{ ...symbols, funcs:[0n] },
    regions:[largeRegion],
    chunkBytes:0,
  });
  assert.deepEqual(reads, [2 * 1024 * 1024, 1], 'zero chunkBytes must retain the historical default');

  reads.length = 0;
  await createSymmetricCodeFunctionSet({
    backend,
    symbols:{ ...symbols, funcs:[0n] },
    regions:[largeRegion],
    chunkBytes:{ value:65_536 },
  });
  assert.deepEqual(reads, [2 * 1024 * 1024, 1], 'structured chunkBytes must use the default, not coercion');
}

console.log('diff-platform: PASS');
