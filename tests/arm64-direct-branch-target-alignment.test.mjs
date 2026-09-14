import assert from 'node:assert/strict';

import { liftArm64ControlEffects } from '../js/targets/architecture/arm64/effects/control.js';

// Decoder-derived cases prove valid encodings; these cases additionally prove
// that malformed structured absolute targets cannot bypass A64 PC-relative bounds.
const gp64 = { k:'reg', cls:'gp', num:0, bits:64, text:'x0' };
const imm0 = { k:'imm', value:0n, text:'#0' };
const base = 0x40000000n;

const cases = [
  ['b', [], 26],
  ['bl', [], 26],
  ['b.eq', [], 19],
  ['cbz', [gp64], 19],
  ['cbnz', [gp64], 19],
  ['tbz', [gp64, imm0], 14],
  ['tbnz', [gp64, imm0], 14],
];

function liftAt(mnemonic, ops, target, suffix, address = base) {
  return liftArm64ControlEffects({
    instructionId:`arm64-direct-branch:${mnemonic}:${suffix}`,
    mnemonic,
    mode:'a64',
    address,
    branchTarget:target,
    callTarget:mnemonic === 'bl' ? target : undefined,
    ops,
  });
}

for (const [mnemonic, ops, immediateBits] of cases) {
  const misaligned = liftAt(mnemonic, ops, base + 1n, 'misaligned');
  assert.ok(misaligned, `${mnemonic}:misaligned effect required`);
  assert.equal(misaligned.completeness, 'partial', `${mnemonic}:misaligned target must fail closed`);
  assert.match(misaligned.unknownEffects?.reason || '', /target-misaligned-encoding$/);

  const minimum = -(1n << BigInt(immediateBits + 1));
  const maximum = (1n << BigInt(immediateBits + 1)) - 4n;
  for (const [suffix, displacement] of [
    ['zero', 0n],
    ['positive-max', maximum],
    ['negative-min', minimum],
  ]) {
    const valid = liftAt(mnemonic, ops, base + displacement, suffix);
    assert.ok(valid, `${mnemonic}:${suffix}:effect required`);
    assert.notEqual(valid.completeness, 'partial', `${mnemonic}:${suffix}:encodable boundary must remain modeled`);
  }

  for (const [suffix, displacement] of [
    ['positive-overflow', maximum + 4n],
    ['negative-overflow', minimum - 4n],
  ]) {
    const invalid = liftAt(mnemonic, ops, base + displacement, suffix);
    assert.ok(invalid, `${mnemonic}:${suffix}:effect required`);
    assert.equal(invalid.completeness, 'partial', `${mnemonic}:${suffix}:out-of-range target must fail closed`);
    assert.match(invalid.unknownEffects?.reason || '', /target-out-of-range-encoding$/);
  }
}

const addressless = liftArm64ControlEffects({
  instructionId:'arm64-direct-branch:b:addressless',
  mnemonic:'b',
  mode:'a64',
  branchTarget:0x1000n,
  ops:[],
});
assert.equal(addressless.completeness, 'partial');
assert.equal(addressless.unknownEffects?.reason, 'arm64-b-address-unavailable-for-encoding');

console.log('ARM64 direct branch target encoding validation (#1907/#1924): PASS');
