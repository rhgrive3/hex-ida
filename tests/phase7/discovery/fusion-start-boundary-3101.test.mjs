import assert from 'node:assert/strict';

import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';

function evidence(start, producerId = 'loader') {
  return {
    kind: 'loader-function-start',
    authority: 'authoritative',
    producerId,
    start,
    extentRole: 'complete',
    regions: [],
  };
}

for (const malformed of [
  ['4096'],
  true,
  false,
  { toString: () => '4096' },
  4096.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  -1,
  '-1',
]) {
  const { candidates } = fuseFunctionCandidates([evidence(malformed)]);
  assert.deepEqual(candidates, [], `malformed start must not create a candidate: ${String(malformed)}`);
}

const { candidates } = fuseFunctionCandidates([
  evidence(4096n, 'bigint'),
  evidence(4096, 'number'),
  evidence('4096', 'decimal-string'),
  evidence('0x1000', 'hex-string'),
]);
assert.equal(candidates.length, 1);
assert.equal(candidates[0].start, '4096');
assert.equal(candidates[0].startState, 'exact');

console.log('fusion start boundary regression: ok');
