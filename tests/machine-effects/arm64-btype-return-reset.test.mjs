import assert from 'node:assert/strict';
import { resolveArm64BtypeTransition } from '../../js/targets/architecture/arm64/effects/btype.js';

for (const mnemonic of ['ret', 'retaa', 'retab']) {
  const transition = resolveArm64BtypeTransition({ mnemonic });
  assert.equal(transition?.kind, 'known', `${mnemonic}: BTYPE transition must be known`);
  assert.equal(transition?.value, 0, `${mnemonic}: BTYPE must reset to 0`);
}

assert.equal(resolveArm64BtypeTransition({ mnemonic:'bl' })?.value, 0, 'BL direct branch reset remains 0');
assert.equal(resolveArm64BtypeTransition({ mnemonic:'blr', ops:[{ k:'reg', cls:'gp', num:0, bits:64 }] })?.value, 2, 'BLR call type remains 2');
assert.equal(resolveArm64BtypeTransition({ mnemonic:'br', ops:[{ k:'reg', cls:'gp', num:16, bits:64 }] })?.value, 1, 'BR x16 jump-compatible type remains 1');

console.log('arm64-btype-return-reset: PASS');
