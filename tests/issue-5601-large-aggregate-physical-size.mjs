import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAAPCS64Arguments } from '../js/targets/abi/aapcs64.js';
import { classifyDarwinArm64Arguments } from '../js/targets/abi/darwin-arm64.js';

const paddedAggregate = {
  type:'struct Padded24',
  aggregate:true,
  bits:128,
  layout:{
    bits:128,
    bytes:24,
    members:[
      { type:'uint64_t', bits:64, bytes:8, byteOffset:0 },
      { type:'uint64_t', bits:64, bytes:8, byteOffset:8 },
    ],
    padding:[{ bytes:8, byteOffset:16 }],
  },
};

for (const [name, classify] of [
  ['AAPCS64', classifyAAPCS64Arguments],
  ['Darwin ARM64', classifyDarwinArm64Arguments],
]) {
  test(`#5601 ${name} uses physical aggregate size for B.4`, () => {
    const result = classify({ callPrototype:{ args:[paddedAggregate] } });
    const argument = result.arguments[0];
    assert.equal(argument.location, 'register');
    assert.equal(argument.reg, 'x0');
    assert.equal(argument.abiClass, 'aggregate-indirect-copy');
    assert.equal(argument.pointer, true);
    assert.equal(argument.callerCopy, true);
    assert.equal(argument.pointeeBits, 128);
    assert.equal(argument.bytes, 8);
  });
}

test('#5601 Darwin keeps an anonymous large aggregate on the compact stack', () => {
  const result = classifyDarwinArm64Arguments({ callPrototype:{
    variadic:true,
    fixedParameterCount:0,
    args:[{ ...paddedAggregate, unnamed:true, variadic:true }],
  } });
  const argument = result.arguments[0];
  assert.equal(argument.location, 'stack');
  assert.equal(argument.offset, 0);
  assert.equal(argument.abiClass, 'aggregate-indirect-copy');
  assert.equal(argument.pointer, true);
  assert.equal(argument.variadicAnonymous, true);
});
