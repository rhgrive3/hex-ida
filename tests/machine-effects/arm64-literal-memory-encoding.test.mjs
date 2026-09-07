import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const base = 0x400000n;
const minimum = -(1n << 20n);
const maximum = (1n << 20n) - 4n;

function decoded(mnemonic, target, suffix, { address = base } = {}) {
  const data = {
    instructionId:`arm64-literal-memory-${mnemonic}-${suffix}`,
    mnemonic,
    mode:'a64',
    address,
    literalTarget:target,
  };
  if (mnemonic === 'prfm') {
    data.ops = [
      { k:'other', text:'pldl1keep' },
      { k:'imm', value:target, text:`#0x${target.toString(16)}` },
    ];
  } else {
    data.ops = [
      { k:'reg', cls:'gp', num:0, bits:64, text:'x0' },
      { k:'imm', value:target, text:`#0x${target.toString(16)}` },
    ];
  }
  return data;
}

for (const mnemonic of ['ldr','ldrsw','prfm']) {
  for (const [suffix, displacement] of [
    ['zero',0n],
    ['positive-max',maximum],
    ['negative-min',minimum],
  ]) {
    const effects = liftArm64MachineEffects(decoded(mnemonic, base + displacement, suffix));
    assert.ok(effects, `${mnemonic}:${suffix}:effects required`);
    assert.notEqual(effects.completeness, 'partial', `${mnemonic}:${suffix}:encodable boundary must remain modeled`);
  }

  for (const [suffix, target, reason] of [
    ['misaligned',base + 1n,`arm64-${mnemonic}-literal-target-misaligned-encoding`],
    ['positive-overflow',base + maximum + 4n,`arm64-${mnemonic}-literal-target-out-of-range-encoding`],
    ['negative-overflow',base + minimum - 4n,`arm64-${mnemonic}-literal-target-out-of-range-encoding`],
  ]) {
    const effects = liftArm64MachineEffects(decoded(mnemonic, target, suffix));
    assert.equal(effects.completeness, 'partial', `${mnemonic}:${suffix}:must fail closed`);
    assert.equal(effects.unknownEffects?.reason, reason);
    assert.equal(effects.metadata?.failClosed, true);
  }

  const addressless = decoded(mnemonic, base, 'addressless', { address:undefined });
  delete addressless.address;
  const effects = liftArm64MachineEffects(addressless);
  assert.equal(effects.completeness, 'partial', `${mnemonic}:addressless must fail closed`);
  assert.equal(effects.unknownEffects?.reason, `arm64-${mnemonic}-literal-address-unavailable-for-encoding`);
}

console.log('ARM64 literal memory encoding validation: PASS');
