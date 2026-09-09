import assert from 'node:assert/strict';
import { COMPACT_DIFF_FUNCTION_SET_SCHEMA, materializeCompactFunctionSet } from '../js/diff/compact-function-set.js';

function compact(symbolAddress, symbolName) {
  return {
    schema:COMPACT_DIFF_FUNCTION_SET_SCHEMA,
    functionAddresses:[4096n],
    symbolAddresses:[symbolAddress],
    symbolNames:[symbolName],
    count:1,
    architecture:'arm64',
    evidenceProfile:'symmetric-symbol-fast/v1',
  };
}

for (const badAddress of [['4096'], { toString(){ return '4096'; } }, true, false, 4096.5, -1]) {
  assert.equal(materializeCompactFunctionSet(compact(badAddress, 'forged'))[0].name, null);
}
for (const badName of [['forged'], { toString(){ return 'forged'; } }, 1, true]) {
  assert.equal(materializeCompactFunctionSet(compact(4096n, badName))[0].name, null);
}
for (const goodAddress of [4096n, 4096, '4096', '0x1000']) {
  assert.equal(materializeCompactFunctionSet(compact(goodAddress, 'canonical'))[0].name, 'canonical');
}
for (const nonCanonical of ['04096', ' 4096 ', '']) {
  assert.equal(materializeCompactFunctionSet(compact(nonCanonical, 'forged'))[0].name, null);
}

console.log('issue-3759 compact function symbol type boundary: PASS');
