import assert from 'node:assert/strict';
import test from 'node:test';
import { AAPCS64_ABI, AAPCS64_ILP32_ABI } from '../../../js/targets/abi/index.js';

const uncertain = [
  ['missing width', { type:'uint64' }],
  ['bytes without logical width', { type:'uint32', bytes:4 }],
  ['conflicting widths', { type:'uint32', bits:32, sizeBits:64 }],
  ['conflicting width and size', { type:'uint32', bits:32, bytes:8 }],
  ['conflicting sizes', { type:'uint32', bits:32, bytes:4, sizeBytes:8 }],
  ['null width', { type:'uint32', bits:null }],
  ['coerced width', { type:'uint32', bits:'32' }],
];

for (const [label, parameter] of uncertain) {
  test(`AAPCS64 scalar provenance: ${label} cannot publish exact placement`, () => {
    const result = AAPCS64_ABI.classifyArguments({ callPrototype:{ args:[parameter, { type:'uint64', bits:64 }] } });
    assert.equal(result.partial, true);
    assert.equal(result.stackArgsUnknown, true);
    assert.equal(result.arguments.length, 2);
    assert.ok(result.arguments.every((argument) => argument.exact === false && argument.mustUse === false));
    assert.ok(result.arguments.every((argument) => argument.bits == null && argument.bytes == null));
    assert.equal(result.srcs.some((source) => source.mustUse === true), false);
  });
}

test('AAPCS64 scalar provenance: explicit consistent width and size retain their logical span', () => {
  const result = AAPCS64_ABI.classifyArguments({ callPrototype:{ args:[{ type:'uint32', bits:32, sizeBits:32, bytes:4, sizeBytes:4 }] } });
  assert.equal(result.partial, false);
  assert.equal(result.arguments[0].bits, 32);
  assert.equal(result.arguments[0].bytes, 4);
  assert.equal(result.arguments[0].reg, 'x0');
  assert.equal(result.srcs[0].bits, 64);
});

test('AAPCS64 scalar provenance: logical width alone does not invent a register byte span', () => {
  const result = AAPCS64_ABI.classifyArguments({ callPrototype:{ args:[{ type:'uint32', bits:32 }] } });
  assert.equal(result.arguments[0].bits, 32);
  assert.equal(result.arguments[0].bytes, undefined);
});

for (const [abi, bits] of [[AAPCS64_ABI, 64], [AAPCS64_ILP32_ABI, 32]]) {
  test(`${abi.id}: the data model proves pointer width but cannot erase contradictory metadata`, () => {
    const valid = abi.classifyArguments({ callPrototype:{ args:[{ type:'void *', pointer:true }] } });
    assert.equal(valid.partial, false);
    assert.equal(valid.arguments[0].bits, bits);
    assert.equal(valid.arguments[0].bytes, bits / 8);
    const invalid = abi.classifyArguments({ callPrototype:{ args:[{ type:'void *', pointer:true, bits:bits === 32 ? 64 : 32 }] } });
    assert.equal(invalid.partial, true);
    assert.equal(invalid.arguments[0].bytes == null, true);
  });
}
