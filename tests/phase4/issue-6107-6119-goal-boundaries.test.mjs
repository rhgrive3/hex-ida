import assert from 'node:assert/strict';
import {
  GOALS,
  goalFromPreset,
  matchField,
  matchText,
  normalizeFieldName,
} from '../../js/goals.js';

const hp = goalFromPreset('hp');
const purchase = goalFromPreset('purchase');
assert.ok(hp && purchase, 'canonical goal fixtures must exist');

for (const value of [
  ['hp'],
  { value: 'hp' },
  42,
  true,
  new String('hp'),
]) {
  assert.equal(normalizeFieldName(value), '', 'structured field names must not be coerced');
  assert.equal(matchField(hp, value), null, 'structured field names must not create evidence');
}

for (const value of [
  ['purchase receipt'],
  { text: 'purchase receipt' },
  42,
  true,
  new String('purchase receipt'),
]) {
  assert.equal(matchText(purchase, value), null, 'structured goal text must not create evidence');
}

assert.equal(normalizeFieldName('_currentHP'), 'current hp');
assert.ok(matchField(hp, '_hp'), 'primitive field names must retain matching');
assert.ok(matchText(purchase, 'purchase receipt'), 'primitive goal text must retain matching');

// Keep the public goal collection part of the regression fixture: callers use
// these objects directly and must not need a second coercing wrapper.
assert.ok(GOALS.some((goal) => goal.id === hp.id));
assert.ok(GOALS.some((goal) => goal.id === purchase.id));

console.log('issue-6107-6119-goal-boundaries: ok');
