import assert from 'node:assert/strict';
import {
  classifyString,
  classifyFeaturesAndEngineAsync,
  detectEngine,
  groupByFeature,
} from '../../js/features.js';

for (const text of [
  null,
  undefined,
  ['purchase payment'],
  { toString: () => 'purchase payment' },
  123,
  true,
  new String('purchase payment'),
]) {
  assert.deepEqual(classifyString(text), [], 'structured feature text must not become evidence');
}

const malformed = [
  { addr: 1n, text: ['purchase payment'] },
  { addr: 2n, text: { toString: () => 'UnityEngine' } },
];
assert.equal(detectEngine(malformed), null, 'structured engine text must not become evidence');
assert.deepEqual(groupByFeature(malformed), [], 'groupByFeature must preserve the string-only boundary');

const asyncResult = await classifyFeaturesAndEngineAsync(malformed);
assert.deepEqual(asyncResult.features, []);
assert.equal(asyncResult.engine, null);

const validAsync = await classifyFeaturesAndEngineAsync([
  { addr: 3n, text: 'UnityEngine purchase payment' },
]);
assert.equal(validAsync.engine?.id, 'unity', 'async primitive engine evidence must retain matching');
assert.ok(validAsync.features.some((feature) => feature.id === 'purchase'),
  'async primitive feature evidence must retain matching');

// #4119: the chunk boundary must preserve callable progress and ignore malformed observers.
const boundaryStrings = Array.from({ length: 101 }, (_, index) => ({
  addr: BigInt(index),
  text: index === 100 ? 'UnityEngine purchase payment' : 'ordinary text',
}));
const boundaryProgress = [];
const boundaryResult = await classifyFeaturesAndEngineAsync(boundaryStrings, {
  chunkSize: 100,
  onProgress: (done, all) => boundaryProgress.push({ done, all }),
});
assert.deepEqual(boundaryProgress, [{ done: 100, all: 101 }],
  'callable progress must fire once at the 100-item chunk boundary');
assert.equal(boundaryResult.count, 101);
assert.equal(boundaryResult.engine?.id, 'unity', 'boundary scan must retain engine detection');
assert.ok(boundaryResult.features.some((feature) => feature.id === 'purchase'),
  'boundary scan must retain feature classification');
for (const onProgress of [undefined, null, true, {}, [], 'progress', 1]) {
  const result = await classifyFeaturesAndEngineAsync(boundaryStrings, { chunkSize: 100, onProgress });
  assert.equal(result.count, 101,
    `non-callable onProgress ${Object.prototype.toString.call(onProgress)} must not abort classification`);
  assert.equal(result.engine?.id, 'unity');
}

assert.ok(classifyString('purchase payment').some((hit) => hit.id === 'purchase'));
assert.equal(detectEngine([{ addr: 3n, text: 'UnityEngine' }])?.id, 'unity');
assert.ok(groupByFeature([{ addr: 4n, text: 'purchase payment' }]).some((f) => f.id === 'purchase'));

console.log('issue-6114-features-boundary: ok');
