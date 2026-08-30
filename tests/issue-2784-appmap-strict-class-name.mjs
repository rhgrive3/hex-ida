import assert from 'node:assert/strict';
import { classifyClassName } from '../js/appmap.js';

assert.equal(classifyClassName('BattleManager').some((hit) => hit.id === 'battle'), true);
assert.equal(classifyClassName('LoginManager').some((hit) => hit.id === 'login'), true);

for (const value of [
  ['LoginManager'],
  { toString() { return 'BattleManager'; } },
  1,
  true,
  null,
  undefined,
]) {
  assert.deepEqual(classifyClassName(value), []);
}

console.log('appmap strict class-name input regression PASS');
