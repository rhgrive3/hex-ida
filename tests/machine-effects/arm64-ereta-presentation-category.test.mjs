import assert from 'node:assert/strict';
import { categoryOf, isBranch, isCall, isReturn } from '../../js/arm64.js';

for (const mnemonic of ['eret', 'eretaa', 'eretab', 'ERETAA', 'ERETAB']) {
  assert.equal(categoryOf(mnemonic), 'system', `${mnemonic} must remain a system/exception-return instruction`);
}

for (const mnemonic of ['retaa', 'retab']) {
  assert.equal(categoryOf(mnemonic), 'flow', `${mnemonic} must remain a normal authenticated return`);
  assert.equal(isBranch(mnemonic), true);
  assert.equal(isReturn(mnemonic), true);
}

for (const mnemonic of ['eretaa', 'eretab']) {
  assert.equal(isBranch(mnemonic), false, `${mnemonic} must not be presented as an ordinary control-flow branch`);
  assert.equal(isReturn(mnemonic), false, `${mnemonic} must not be presented as a normal function return`);
  assert.equal(isCall(mnemonic), false);
}

for (const malformed of ['eretax', 'eretaba', 'eret.a']) {
  assert.notEqual(categoryOf(malformed), 'system', `${malformed} is not a canonical exception-return mnemonic`);
}

console.log('arm64 ERETAA/ERETAB presentation category regression PASS');
