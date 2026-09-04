import assert from 'node:assert/strict';
import {
  classifyString,
  classifyFeaturesAndEngineAsync,
  detectEngine,
  groupByFeature,
} from '../../js/features.js';

for (const text of [
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

assert.ok(classifyString('purchase payment').some((hit) => hit.id === 'purchase'));
assert.equal(detectEngine([{ addr: 3n, text: 'UnityEngine' }])?.id, 'unity');
assert.ok(groupByFeature([{ addr: 4n, text: 'purchase payment' }]).some((f) => f.id === 'purchase'));

console.log('issue-6114-features-boundary: ok');
