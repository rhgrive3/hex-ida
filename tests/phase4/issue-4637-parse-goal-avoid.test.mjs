import assert from 'node:assert/strict';
import {
  GOALS,
  matchText,
  parseGoal,
} from '../../js/goals.js';

const hpFree = parseGoal('healthCheck');
assert.notEqual(hpFree.id, 'hp', 'healthCheck must not be classified as the HP preset');
assert.equal(hpFree.id, 'free');
assert.equal(hpFree.free, true);
assert.equal(hpFree.expects.numeric, undefined, 'free goals must not inherit preset expects');

const hpStatus = parseGoal('health status');
assert.notEqual(hpStatus.id, 'hp', 'health status must not be classified as the HP preset');

assert.notEqual(parseGoal('healthMonitor').id, 'hp');
assert.notEqual(parseGoal('healthPercentile').id, 'hp');
assert.notEqual(parseGoal('lifecycle').id, 'hp');
assert.notEqual(parseGoal('lifetime').id, 'hp');

const moneyFree = parseGoal('concurrency');
assert.notEqual(moneyFree.id, 'money', 'concurrency must not be classified as the money preset');
assert.equal(moneyFree.id, 'free');

const mixed = parseGoal('attack healthCheck');
assert.equal(mixed.id, 'attack', 'non-avoided hits must survive beside an avoided concept');

assert.equal(parseGoal('HPを増やしたい').id, 'hp', 'plain HP preset selection must be preserved');
assert.equal(parseGoal('所持金').id, 'money', 'plain money preset selection must be preserved');
assert.ok(parseGoal('HPを増やしたい').strong.length > 0);
assert.ok(parseGoal('所持金').expects.numeric === true);

const samples = [
  'healthCheck', 'health status', 'healthMonitor', 'healthPercentile',
  'lifecycle', 'lifetime', 'concurrency', 'concurrent', 'concurrentRequest',
  'bid floor currency', 'priceFloor', 'HP', '所持金', 'attack healthCheck',
];
for (const goal of GOALS) {
  for (const text of samples) {
    const preset = parseGoal(text);
    if (matchText(goal, text) === null && preset.id === goal.id) {
      assert.fail(
        `parseGoal("${text}") selected "${goal.id}" but matchText reports no unblocked match`,
      );
    }
  }
}

console.log('issue-4637-parse-goal-avoid: ok');
