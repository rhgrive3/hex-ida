// Regression for #4637: parseGoal() picks a preset by testing GOALS strong/weak
// regexes directly, so it ignored the per-goal `avoid` contract that
// matchText()/matchField() already honour. Free input that *is* an excluded
// concept ("healthCheck", "concurrency", ...) was locked onto the HP / money
// preset — and with it the preset's `expects` and synonym-expanded extraTerms —
// before any later stage could apply avoid. Preset selection must respect the
// same avoid spans, while keeping unrelated hits ("attack healthCheck") and the
// normal preset judgements ("HPを増やしたい", "所持金") intact.
import assert from 'node:assert/strict';

import { GOALS, goalById, matchField, matchText, parseGoal } from '../js/goals.js';

const hp = goalById('hp');
const money = goalById('money');
assert.ok(hp && hp.avoid?.length, 'hp preset must carry its avoid rules');
assert.ok(money && money.avoid?.length, 'money preset must carry its avoid rules');

// (1) `healthCheck` alone is the excluded concept, not the HP preset.
{
  const goal = parseGoal('healthCheck');
  assert.equal(matchText(hp, 'healthCheck'), null, 'matchText must already avoid healthCheck');
  assert.notEqual(goal.id, 'hp', 'healthCheck must not become the hp preset');
  assert.equal(goal.free, true, 'healthCheck must stay a free goal');
}

// (2) The other HP avoid forms must not reach the HP preset either.
for (const probe of ['health status', 'healthMonitor', 'healthPercentile', 'healthState']) {
  const goal = parseGoal(probe);
  assert.equal(matchText(hp, probe), null, `matchText must avoid ${probe}`);
  assert.notEqual(goal.id, 'hp', `${probe} must not become the hp preset`);
}
for (const probe of ['lifecycle', 'lifetime', 'life span', 'timeline']) {
  assert.equal(matchText(hp, probe), null, `matchText must avoid ${probe}`);
  assert.notEqual(parseGoal(probe).id, 'hp', `${probe} must not become the hp preset`);
}

// (3) `concurrency` alone is the excluded concept, not the money preset.
{
  const goal = parseGoal('concurrency');
  assert.equal(matchText(money, 'concurrency'), null, 'matchText must already avoid concurrency');
  assert.notEqual(goal.id, 'money', 'concurrency must not become the money preset');
  assert.equal(goal.free, true, 'concurrency must stay a free goal');
}
for (const probe of ['concurrent', 'concurrentRequests', 'bid_floor_currency', 'price_floor_usd']) {
  assert.equal(matchText(money, probe), null, `matchText must avoid ${probe}`);
  assert.notEqual(parseGoal(probe).id, 'money', `${probe} must not become the money preset`);
}

// (4) A string that also carries a genuinely unrelated hit keeps that hit:
// avoid drops only the blocked span, never the rest of the judgement.
{
  const goal = parseGoal('attack healthCheck');
  assert.equal(goal.id, 'attack', 'attack must survive beside an avoided healthCheck');
  assert.equal(goal.free, false, 'a strong preset hit must still resolve to that preset');
}

// (5) Real HP / money wording must keep its preset judgement, expects included.
{
  const goal = parseGoal('HPを増やしたい');
  assert.equal(goal.id, 'hp');
  assert.equal(goal.free, false);
  assert.deepEqual(goal.expects, hp.expects);

  const coins = parseGoal('所持金');
  assert.equal(coins.id, 'money');
  assert.equal(coins.free, false);
  assert.deepEqual(coins.expects, money.expects);

  const health = parseGoal('health');
  assert.equal(health.id, 'hp', 'a bare health is still HP');
  assert.deepEqual(parseGoal('healthCheck then health').id, 'hp', 'a later real health still counts');
}

// (6) Preset selection and matchText()/matchField() must agree: whenever every
// clue of a goal is avoided, parseGoal() must not route the input to that goal.
{
  const probes = [
    'healthCheck', 'health check', 'health-status', 'healthMonitor', 'health report',
    'lifecycle', 'lifetime', 'HP healthCheck', 'concurrency', 'concurrent',
    'maxConcurrency', 'bid_floor_currency', 'price_floor', '所持金 concurrency',
  ];
  for (const probe of probes) {
    const chosen = parseGoal(probe);
    for (const g of GOALS) {
      const textBlocked = matchText(g, probe) === null && matchField(g, probe) === null;
      if (textBlocked && chosen.id === g.id) {
        assert.fail(`parseGoal('${probe}') chose preset '${g.id}' that avoids every match of '${probe}'`);
      }
    }
  }
}

// (7) An avoided input must not inherit the preset's expects / preset identity.
{
  for (const [probe, preset] of [['healthCheck', 'hp'], ['concurrency', 'money']]) {
    const goal = parseGoal(probe);
    assert.equal(goal.id, 'free');
    assert.equal(goal.free, true);
    assert.equal(goal.text, probe);
    assert.deepEqual(Object.keys(goal.expects || {}), [], `free goal for ${probe} must not preset expectations`);
    assert.notEqual(goal.strong, goalById(preset).strong);
    assert.equal(goal.strong.length, 0);
  }
}

console.log('issue #4637 parseGoal avoid-contract regressions PASS');
