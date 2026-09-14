import assert from 'node:assert/strict';
import test from 'node:test';

import { typeBits, parameterClass, classifyMicrosoftX64Arguments } from '../../../js/targets/abi/microsoft-x64.js';
import { classifyMicrosoftVectorcallArguments } from '../../../js/targets/abi/microsoft-vectorcall.js';

/* Windows `long long` / `unsigned long long` are 64-bit two-token type
 * specifiers; the 32-bit `long` token must not swallow them (issue #5977). */
for (const [type, expected] of [
  ['long long', 64],
  ['unsigned long long', 64],
  ['long', 32],
  ['unsigned long', 32],
  ['long  long', 64],
  ['unsigned  long long', 64],
  ['int64', 64],
  ['uint64', 64],
  ['int', 32],
  ['unsigned int', 32],
  ['float', 32],
  ['double', 64],
  ['char', 8],
  ['short', 16],
]) {
  assert.equal(typeBits(type), expected, `typeBits(${type}) must be ${expected}`);
}

assert.equal(parameterClass({ type:'long long' }).bits, 64,
  'parameterClass must see the proven 64-bit width of long long');
assert.equal(parameterClass({ type:'unsigned long long' }).bits, 64);

test('microsoft-x64 classifies an unproven-width long long argument as 64-bit', () => {
  const result = classifyMicrosoftX64Arguments({ callPrototype:{ args:[{ type:'long long' }] } });
  assert.equal(result.arguments[0]?.bits, 64);
  assert.equal(result.arguments[0]?.reg, 'rcx');
  assert.equal(result.partial, false);
});

test('microsoft-x64 return width for long long uses 64 bits', () => {
  const result = classifyMicrosoftX64Arguments({
    callPrototype:{ args:[], returnType:'long long' },
  });
  assert.equal(result.returnClassification, 'direct');
});

test('vectorcall inherits the corrected shared width helper', () => {
  const result = classifyMicrosoftVectorcallArguments({
    callPrototype:{ callingConvention:'vectorcall', args:[{ type:'long long' }] },
  });
  assert.equal(result.arguments[0]?.bits, 64);
});
