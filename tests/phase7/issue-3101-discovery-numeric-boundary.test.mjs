import test from 'node:test';
import assert from 'node:assert/strict';

import { fuseFunctionCandidates, regionFromSize } from '../../js/analysis/discovery/fusion.js';

const extentState = 'exact';
const evidence = (producerId, ownership = 'exclusive') => ({
  producerId,
  start: 4096,
  extentState,
  regions: [{ start: '4096', end: '4112', ownership }],
});

test('issue-3101: fusion rejects structured/boolean start coercion instead of BigInt()-ing it', () => {
  const malformed = [
    { producerId: 'x', start: [4096], extentState, regions: [{ start: '4096', end: '4112', ownership: 'exclusive' }] },
    { producerId: 'x', start: { valueOf: () => 4096 }, extentState, regions: [{ start: '4096', end: '4112', ownership: 'exclusive' }] },
    { producerId: 'x', start: true, extentState, regions: [{ start: '4096', end: '4112', ownership: 'exclusive' }] },
    { producerId: 'x', start: 4096.5, extentState, regions: [{ start: '4096', end: '4112', ownership: 'exclusive' }] },
  ];
  for (const item of malformed) {
    assert.throws(() => fuseFunctionCandidates([item]), /discovery-fusion-invalid-start/,
      `start ${JSON.stringify(item.start)} must be rejected`);
  }
});

test('issue-3101: regionFromSize rejects structured/boolean size coercion', () => {
  for (const size of [[16], { valueOf: () => 16 }, true, 16.5]) {
    assert.throws(() => regionFromSize(4096n, size), /discovery-region-invalid-size/,
      `size ${JSON.stringify(size)} must be rejected`);
  }
  for (const start of [[4096], { valueOf: () => 4096 }, false]) {
    assert.throws(() => regionFromSize(start, 16n), /discovery-region-invalid-start/,
      `start ${JSON.stringify(start)} must be rejected`);
  }
});

test('issue-3101: valid primitive sizes keep the existing region semantics', () => {
  assert.deepEqual(
    { ...regionFromSize(4096n, 16n), start: 4096n, end: 4112n },
    { ...regionFromSize(4096n, 16n), start: 4096n, end: 4112n });
  assert.equal(String(regionFromSize('4096', '16').end), '4112');
  assert.equal(regionFromSize(4096n, 0n), null);
});
