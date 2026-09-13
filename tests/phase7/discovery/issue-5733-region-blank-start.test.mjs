import assert from 'node:assert/strict';
import test from 'node:test';

import { fuseFunctionCandidates, regionFromSize } from '../../../js/analysis/discovery/fusion.js';
import { loaderProducer } from '../../../js/analysis/discovery/producers.js';

const BLANK_ADDRESSES = ['', '   ', '\t\n'];

test('regionFromSize rejects blank starts instead of laundering them into address 0 (#5733)', () => {
  for (const start of BLANK_ADDRESSES) {
    assert.throws(
      () => regionFromSize(start, 16),
      /discovery-region-invalid-start/,
    );
    assert.throws(
      () => regionFromSize(start, '16'),
      /discovery-region-invalid-start/,
    );
  }
});

test('regionFromSize rejects blank sizes instead of laundering them into size 0 (#5733)', () => {
  for (const size of BLANK_ADDRESSES) {
    assert.throws(
      () => regionFromSize(0x1000, size),
      /discovery-region-invalid-size/,
    );
  }
});

test('regionFromSize keeps the canonical address contract for padded numeric strings', () => {
  assert.deepEqual(regionFromSize(' 4096 ', 16), { start: '4096', end: '4112', ownership: 'exclusive' });
  assert.deepEqual(regionFromSize(0n, 8), { start: '0', end: '8', ownership: 'exclusive' });
});

test('producers cannot mint a region anchored at 0 from a blank entry address (#5733)', () => {
  const evidence = loaderProducer.produce({
    image: {
      functions: [
        { address: '', sizeBytes: 16, source: 'function_starts' },
        { address: 0, sizeBytes: 16, source: 'function_starts' },
      ],
      functionStarts: [],
      unwindEntries: [],
    },
  });

  // The blank entry must not survive as region evidence anchored at '0';
  // the explicit zero address remains a legitimate region at '0'.
  const anchoredAtZero = evidence.filter((item) => item.regions.some((region) => region.start === '0'));
  assert.equal(anchoredAtZero.length, 1, JSON.stringify(evidence.map((item) => [item.start, item.regions])));
  assert.equal(anchoredAtZero[0].start, '0');
});

test('fusion direct route still fails closed on blank starts after canonicalization (#5733)', () => {
  const evidence = (start, producerId) => ({ kind: 'symbol-table', start, producerId, regions: [] });
  assert.throws(
    () => fuseFunctionCandidates([evidence('', 'probe-a'), evidence('   ', 'probe-b')]),
    /discovery-evidence-invalid-start/,
  );
});
