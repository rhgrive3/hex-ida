import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySysVAMD64Arguments } from '../js/targets/abi/sysv-amd64.js';

function classified(args, options = {}) {
  return classifySysVAMD64Arguments(
    { callPrototype: { args } },
    { maxVectorRegisterBits: 512, ...options },
  );
}

test('6049: 1024-bit vector is not truncated to an exact zmm placement', () => {
  const result = classified([{ type: 'v1024', vector: true, bits: 1024 }]);
  const argument = result.arguments[0];
  assert.notEqual(
    { location: argument.location, reg: argument.reg, bits: argument.bits, partial: argument.partial ?? false },
    { location: 'register', reg: 'zmm0', bits: 512, partial: false },
    'must not publish an exact half-width placement',
  );
  assert.ok(
    argument.partial === true || argument.unsupported === true || argument.location !== 'register',
    'oversized vector must fail closed',
  );
  assert.equal(argument.bits, 1024, 'declared width must survive classification');
});

test('6049: canonical 512-bit vector still resolves exactly', () => {
  const result = classified([{ type: '__m512', vector: true, bits: 512 }]);
  const argument = result.arguments[0];
  assert.equal(argument.location, 'register');
  assert.equal(argument.reg, 'zmm0');
  assert.equal(argument.bits, 512);
});

test('6049: canonical 128/256-bit vectors are unchanged', () => {
  const result = classified([
    { type: '__m128', vector: true, bits: 128 },
    { type: '__m256', vector: true, bits: 256 },
  ]);
  assert.equal(result.arguments[0].reg, 'xmm0');
  assert.equal(result.arguments[1].reg, 'ymm1');
});
