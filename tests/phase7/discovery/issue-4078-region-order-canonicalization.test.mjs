import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryEvidence } from '../../../js/analysis/discovery/candidates.js';
import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';

const A = Object.freeze({ start: 0x1000n, end: 0x1010n, ownership: 'exclusive' });
const B = Object.freeze({ start: 0x2000n, end: 0x2020n, ownership: 'shared' });
const C = Object.freeze({ start: 0x3000n, end: 0x3010n, ownership: 'exclusive' });

function complete(kind, producerId, regions) {
  return createDiscoveryEvidence({
    kind,
    producerId,
    start: 0x1000n,
    extentRole: 'complete',
    regions,
  });
}

test('4078: canonical discovery evidence orders regions independent of producer enumeration', () => {
  const forward = complete('loader-function-start', 'loader', [A, B, C]);
  const permuted = complete('loader-function-start', 'loader', [C, A, B]);

  assert.deepEqual(permuted, forward);
  assert.deepEqual(forward.regions, [
    { start: '4096', end: '4112', ownership: 'exclusive' },
    { start: '8192', end: '8224', ownership: 'shared' },
    { start: '12288', end: '12304', ownership: 'exclusive' },
  ]);
});

test('4078: equivalent authoritative complete region sets do not create a false extent conflict', () => {
  const loader = complete('loader-function-start', 'loader', [A, B, C]);
  const debug = complete('debug-symbol', 'debug', [C, B, A]);

  const forward = fuseFunctionCandidates([loader, debug], { snapshotId: 'snapshot-4078' });
  const reversed = fuseFunctionCandidates([debug, loader], { snapshotId: 'snapshot-4078' });

  assert.deepEqual(reversed, forward);
  assert.equal(forward.candidates.length, 1);
  assert.equal(forward.candidates[0].extentState, 'exact');
  assert.equal(forward.candidates[0].conflicts.length, 0);
  assert.deepEqual(forward.candidates[0].regions, loader.regions);
});

test('4078: a real region ownership difference remains an extent conflict', () => {
  const loader = complete('loader-function-start', 'loader', [A, B, C]);
  const conflictingB = { ...B, ownership: 'exclusive' };
  const debug = complete('debug-symbol', 'debug', [C, conflictingB, A]);

  const result = fuseFunctionCandidates([loader, debug], { snapshotId: 'snapshot-4078' });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].extentState, 'unknown');
  assert.deepEqual(result.candidates[0].regions, []);
  assert.ok(result.candidates[0].conflicts.some((conflict) => conflict.kind === 'extent'));
});
