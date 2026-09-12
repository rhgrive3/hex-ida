import assert from 'node:assert/strict';
import { parseGoal, goalById, goalFromPreset, matchText, matchField } from '../js/goals.js';

assert.ok(goalById('hp') && goalById('money'), 'preset fixtures must exist');

for (const text of ['healthCheck', 'health status', 'healthMonitor', 'healthReport']) {
  assert.notEqual(parseGoal(text).id, 'hp', `${text} must not be classified as hp preset`);
}
for (const text of ['concurrency', 'concurrent']) {
  assert.notEqual(parseGoal(text).id, 'money', `${text} must not be classified as money preset`);
}

const mixed = parseGoal('attack healthCheck');
assert.equal(mixed.id, 'attack', 'non-avoided strong word must survive while avoided word is dropped');

assert.equal(parseGoal('HPを増やしたい').id, 'hp', 'normal hp preset detection must be kept');
assert.equal(parseGoal('所持金').id, 'money', 'normal money preset detection must be kept');

for (const [goalId, text] of [['hp', 'healthCheck'], ['hp', 'health status'], ['money', 'concurrency']]) {
  const goal = goalFromPreset(goalId);
  const selected = parseGoal(text);
  assert.equal(matchText(goal, text), null, `matchText avoid semantics for ${goalId}/${text}`);
  assert.equal(matchField(goal, text), null, `matchField avoid semantics for ${goalId}/${text}`);
  assert.equal(
    selected.id === goalId,
    matchText(goal, text) !== null,
    `preset selection must agree with matchText avoid contract for ${goalId}/${text}`,
  );
}

console.log('issue-4637 parseGoal honors GOALS.avoid: PASS');
