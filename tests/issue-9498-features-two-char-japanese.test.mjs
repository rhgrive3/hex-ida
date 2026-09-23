import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyString } from '../js/features.js';

const cases = new Map([
  ['設定', 'settings'], ['課金', 'purchase'], ['広告', 'ads'], ['ボス', 'battle'], ['報酬', 'gacha'],
  ['保存', 'save'], ['仲間', 'social'], ['順位', 'ranking'], ['通信', 'network'], ['不正', 'anticheat'],
]);

test('#9498 meaningful two-character Japanese keywords are classified', () => {
  for (const [word, expected] of cases) {
    assert.ok(classifyString(word).some((hit) => hit.id === expected), `${word} -> ${expected}`);
  }
});

test('#9498 short ASCII and one-character Japanese noise remain filtered', () => {
  assert.deepEqual(classifyString('ad'), []);
  assert.deepEqual(classifyString('石'), []);
  assert.deepEqual(classifyString('  '), []);
});
