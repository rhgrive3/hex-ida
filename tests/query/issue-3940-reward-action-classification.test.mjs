import assert from 'node:assert/strict';
import test from 'node:test';

import { compileGoal, queryPlan } from '../../js/goalc.js';

function planSteps(text) {
  return queryPlan(compileGoal(text)).map((step) => step.step);
}

test('#3940: reward noun does not outrank an explicit decide verb', () => {
  const query = compileGoal('報酬が決まる場所');
  assert.equal(query.action, 'decide');
  assert.equal(query.dataflow.shape, 'produce');
  assert.equal(planSteps('報酬が決まる場所').includes('rmw'), false);
  assert.equal(planSteps('報酬が決まる場所').includes('branch'), true);
});

test('#3940: reward noun does not outrank an explicit save verb', () => {
  const query = compileGoal('報酬を保存する場所');
  assert.equal(query.action, 'save');
  assert.equal(query.dataflow.shape, 'transfer');
  assert.equal(planSteps('報酬を保存する場所').includes('rmw'), false);
  assert.equal(planSteps('報酬を保存する場所').includes('calls'), true);
});

test('#3940: reward noun alone does not invent an increase action', () => {
  const query = compileGoal('報酬について知りたい');
  assert.notEqual(query.action, 'increase');
  assert.equal(query.action, null);
  assert.equal(query.missing.includes('action'), true);
  assert.equal(planSteps('報酬について知りたい').includes('rmw'), false);
});

test('#3940: explicit increase verbs still classify reward updates as increase', () => {
  for (const text of ['報酬が増える場所', '報酬を獲得する場所']) {
    const query = compileGoal(text);
    assert.equal(query.action, 'increase', text);
    assert.equal(query.dataflow.shape, 'read-modify-write', text);
    assert.equal(planSteps(text).includes('rmw'), true, text);
  }
});

test('#3940: reward context remains available when independently established', () => {
  const battle = compileGoal('戦闘終了時に報酬が増える場所');
  assert.equal(battle.action, 'increase');
  assert.equal(battle.event?.id, 'battle-end');
  assert.equal(battle.context.terms.includes('reward'), true);
  assert.equal(battle.context.terms.includes('battle'), true);

  const gacha = compileGoal('ガチャ報酬が決まる場所');
  assert.equal(gacha.action, 'decide');
  assert.equal(gacha.entity.goal, 'gacha');
  assert.equal(gacha.context.terms.includes('reward'), true);
});
