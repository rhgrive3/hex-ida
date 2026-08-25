import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';

const x0 = { k:'reg', cls:'gp', num:0, bits:64, text:'x0' };
const base = 0x100000n;

function lift(mnemonic, address, target, suffix) {
  return liftArm64MachineEffects({
    instructionId:`issue-1914:${mnemonic}:${suffix}`,
    mnemonic,
    mode:'a64',
    address,
    pcRelTarget:target,
    ops:[x0, { k:'imm', value:target, text:`#0x${target.toString(16)}` }],
  });
}

for (const [suffix, delta] of [
  ['min-valid', -0x100000n],
  ['max-valid', 0xfffffn],
]) {
  const effect = lift('adr', base, base + delta, suffix);
  assert.ok(effect, `ADR ${suffix}: effect required`);
  assert.notEqual(effect.completeness, 'partial', `ADR ${suffix}: encodable boundary must remain modeled`);
}

for (const [suffix, delta] of [
  ['below-min', -0x100001n],
  ['above-max', 0x100000n],
]) {
  const effect = lift('adr', base, base + delta, suffix);
  assert.equal(effect.completeness, 'partial', `ADR ${suffix}: unencodable target must fail closed`);
  assert.equal(effect.unknownEffects?.reason, 'arm64-adr-target-out-of-encoding-range');
}

const pageBase = 0x400000000n;
for (const [suffix, pages] of [
  ['min-valid', -0x100000n],
  ['max-valid', 0xfffffn],
]) {
  const effect = lift('adrp', pageBase + 0x123n, pageBase + pages * 0x1000n, suffix);
  assert.ok(effect, `ADRP ${suffix}: effect required`);
  assert.notEqual(effect.completeness, 'partial', `ADRP ${suffix}: encodable boundary must remain modeled`);
}

for (const [suffix, pages] of [
  ['below-min', -0x100001n],
  ['above-max', 0x100000n],
]) {
  const effect = lift('adrp', pageBase + 0x123n, pageBase + pages * 0x1000n, suffix);
  assert.equal(effect.completeness, 'partial', `ADRP ${suffix}: unencodable target must fail closed`);
  assert.equal(effect.unknownEffects?.reason, 'arm64-adrp-target-out-of-encoding-range');
}

const misaligned = lift('adrp', pageBase, pageBase + 1n, 'misaligned');
assert.equal(misaligned.completeness, 'partial', 'ADRP non-page-aligned target must fail closed');
assert.equal(misaligned.unknownEffects?.reason, 'arm64-adrp-target-not-page-aligned');

const missingAddress = liftArm64MachineEffects({
  instructionId:'issue-1914:adr:missing-address',
  mnemonic:'adr',
  mode:'a64',
  pcRelTarget:0x1000n,
  ops:[x0, { k:'imm', value:0x1000n, text:'#0x1000' }],
});
assert.equal(missingAddress.completeness, 'partial', 'ADR without PC evidence must fail closed');
assert.equal(missingAddress.unknownEffects?.reason, 'arm64-adr-encoding-address-unavailable');

console.log('ARM64 ADR/ADRP encoding-domain validation (#1914): PASS');
