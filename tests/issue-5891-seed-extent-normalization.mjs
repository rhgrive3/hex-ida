// Regression for #5891: mergeFunctionSeeds() normalizes raw seed extents
// (number/string size/end) to BigInt up front so extent canonicalization never
// mixes BigInt and other types into a raw TypeError.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeFunctionSeeds } from '../js/binary/model.js';

test('#5891 a raw seed with a number size canonicalizes without throwing', () => {
  const merged = mergeFunctionSeeds([
    { address: 0x1000n, source: 'heuristic', confidence: 0.6, size: 256 },
  ]);
  assert.equal(merged[0].end, 4352n);
  assert.equal(typeof merged[0].size, 'bigint');
});

test('#5891 a raw seed with a string end canonicalizes without throwing', () => {
  const merged = mergeFunctionSeeds([
    { address: '0x2000', source: 'symbol', confidence: 0.9, end: '8304' },
  ]);
  // 0x2000 = 8192; end 8304 → size 112.
  assert.equal(merged[0].size, 112n);
  assert.equal(typeof merged[0].end, 'bigint');
});

test('#5891 mixed number/bigint extents merge cleanly', () => {
  const merged = mergeFunctionSeeds([
    { address: '0x1000', source: 'symbol', confidence: 0.9, end: 4352 },
    { address: 0x1000n, source: 'heuristic', confidence: 0.6, size: 256 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].end, 4352n);
});
