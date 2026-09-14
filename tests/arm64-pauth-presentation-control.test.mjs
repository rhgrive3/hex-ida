import assert from 'node:assert/strict';
import { isBranch, isCall, categoryOf, brief } from '../js/arm64.js';

const branchAliases = ['braaz', 'brabz', 'blraaz', 'blrabz'];
for (const mnemonic of branchAliases) {
  assert.equal(isBranch(mnemonic), true, `${mnemonic} must be classified as a branch`);
  assert.equal(categoryOf(mnemonic), 'flow', `${mnemonic} must be categorized as control flow`);
}

assert.equal(isCall('blraaz'), true);
assert.equal(isCall('blrabz'), true);
assert.equal(isCall('braaz'), false);
assert.equal(isCall('brabz'), false);

assert.equal(brief('braaz', 'x16', 'pseudo'), 'goto *x16');
assert.equal(brief('brabz', 'x17', 'pseudo'), 'goto *x17');
assert.equal(brief('blraaz', 'x16', 'pseudo'), '(*x16)()');
assert.equal(brief('blrabz', 'x17', 'pseudo'), '(*x17)()');

// Existing authenticated forms remain unchanged.
for (const mnemonic of ['braa', 'brab', 'blraa', 'blrab']) {
  assert.equal(isBranch(mnemonic), true, `${mnemonic} regression`);
  assert.equal(categoryOf(mnemonic), 'flow', `${mnemonic} category regression`);
}
assert.equal(isCall('blraa'), true);
assert.equal(isCall('blrab'), true);

console.log('ARM64 PAuth presentation control aliases: PASS');
