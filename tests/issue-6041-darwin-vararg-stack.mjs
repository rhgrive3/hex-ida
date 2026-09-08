import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDarwinArm64Arguments } from '../js/targets/abi/darwin-arm64.js';

test('6041: anonymous varargs go to the stack, not x1', () => {
  const result = classifyDarwinArm64Arguments({
    callPrototype: {
      variadic: true,
      fixedParameterCount: 1,
      args: [
        { type: 'const char *', pointer: true, bits: 64 },
        { type: 'int', bits: 32, variadic: true, unnamed: true },
      ],
    },
  });
  assert.equal(result.arguments[0].reg, 'x0');
  assert.equal(result.arguments[1].location, 'stack');
  assert.equal(result.arguments[1].variadicAnonymous, true);
  assert.ok(
    !result.srcs.some((src) => src.reg === 'x1'),
    'x1 must not be published as a must-use source for an anonymous vararg',
  );
});

test('6041: anonymous fp varargs skip v-registers', () => {
  const result = classifyDarwinArm64Arguments({
    callPrototype: {
      variadic: true,
      args: [
        { type: 'char *', pointer: true },
        { type: 'double', variadic: true, unnamed: true, named: false },
      ],
    },
  });
  assert.equal(result.arguments[1].location, 'stack');
  assert.ok(
    !result.srcs.some((src) => src.reg === 'v0'),
    'v0 must not back an anonymous vararg',
  );
});

test('6041: named parameters still allocate registers', () => {
  const result = classifyDarwinArm64Arguments({
    callPrototype: {
      variadic: true,
      fixedParameterCount: 2,
      args: [
        { type: 'int', bits: 32 },
        { type: 'int', bits: 32 },
      ],
    },
  });
  assert.equal(result.arguments[0].reg, 'x0');
  assert.equal(result.arguments[1].reg, 'x1');
});

test('6041: non-variadic prototypes are unaffected', () => {
  const result = classifyDarwinArm64Arguments({
    callPrototype: {
      args: [
        { type: 'int', bits: 32 },
        { type: 'int', bits: 32 },
      ],
    },
  });
  assert.equal(result.arguments[1].reg, 'x1');
  assert.equal(result.arguments[1].variadicAnonymous ?? null, null);
});
