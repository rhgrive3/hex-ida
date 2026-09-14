import assert from 'node:assert/strict';
import { functionSeed, mergeFunctionSeeds } from '../js/binary/model.js';

const structuredOrCoercible = [
  ['1'],
  true,
  false,
  '0.8',
  { valueOf() { return 1; } },
  { toString() { return '0.95'; } },
];

for (const confidence of structuredOrCoercible) {
  assert.equal(
    functionSeed(0x1000n, { confidence }).confidence,
    0.5,
    `malformed confidence must fall back instead of coercing: ${typeof confidence}`,
  );
}

assert.equal(functionSeed(0x1000n, { confidence: 0.8 }).confidence, 0.8);
assert.equal(functionSeed(0x1000n, { confidence: 2 }).confidence, 1);
assert.equal(functionSeed(0x1000n, { confidence: -1 }).confidence, 0);
assert.equal(functionSeed(0x1000n, { confidence: Number.NaN }).confidence, 0.5);
assert.equal(functionSeed(0x1000n, { confidence: Number.POSITIVE_INFINITY }).confidence, 0.5);

const merged = mergeFunctionSeeds([
  { address: 0x1000n, source: 'symbol', name: 'good', confidence: 0.9 },
  { address: 0x1000n, source: 'symbol', name: 'malformed', confidence: ['1'] },
]);
assert.equal(merged.length, 1);
assert.equal(merged[0].name, 'good');
assert.equal(merged[0].confidence, 0.9);

const seededExtent = functionSeed(0x2000n, {
  source: 'symbol',
  confidence: 0.75,
  size: 4n,
  extentConfidence: ['1'],
});
assert.equal(seededExtent.extentConfidence, 0.5);

const mergedExtent = mergeFunctionSeeds([
  {
    address: 0x3000n,
    source: 'symbol',
    confidence: 0.8,
    size: 8n,
    extentConfidence: { valueOf() { return 1; } },
  },
]);
assert.equal(mergedExtent[0].extentConfidence, 0.5);

console.log('issue-3598 function seed confidence regression: PASS');
