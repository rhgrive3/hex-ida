import assert from 'node:assert/strict';
import test from 'node:test';
import { matchField, parseGoal } from '../js/goals.js';

test('#9501 asked and expanded terms cannot bypass avoid spans', () => {
  assert.equal(matchField(parseGoal('hp'), 'waterfallLifeCycleHolder'), null);
  assert.equal(matchField(parseGoal('health'), 'healthCheck'), null);
});

test('#9501 same terms still match outside avoid spans', () => {
  assert.ok(matchField(parseGoal('hp'), 'playerLife'));
  assert.ok(matchField(parseGoal('health'), 'playerHealth'));
});
