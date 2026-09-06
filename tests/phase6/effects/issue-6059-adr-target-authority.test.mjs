import test from 'node:test';
import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../../js/targets/architecture/arm64/effects/index.js';
import { strictAddressInput } from '../../../js/targets/architecture/arm64/effects/common.js';

test('6059: strict parser accepts canonical inputs only', () => {
  assert.equal(strictAddressInput(4096n), 4096n);
  assert.equal(strictAddressInput(4096), 4096n);
  assert.equal(strictAddressInput('4096'), 4096n);
  assert.equal(strictAddressInput('0x1000'), 4096n);
  assert.equal(strictAddressInput([4096]), null);
  assert.equal(strictAddressInput(['4096']), null);
  assert.equal(strictAddressInput(true), null);
  assert.equal(strictAddressInput({}), null);
  assert.equal(strictAddressInput(null), null);
  assert.equal(strictAddressInput(undefined), null);
  assert.equal(strictAddressInput(1.5), null);
});

function adr(extra) {
  return liftArm64MachineEffects({
    instructionId: 'adr-authority-probe',
    architectureId: 'arm64',
    mode: 'a64',
    mnemonic: 'adr',
    address: 0n,
    pcRelTarget: 4096n,
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      { k: 'other', text: 'symbolic-target' },
    ],
    origin: { instructionIds: ['adr-authority-probe'] },
    ...extra,
  });
}

test('6059: canonical ADR target stays exact', () => {
  const bundle = adr({});
  assert.equal(bundle?.completeness, 'exact');
});

test('6059: array pcRelTarget does not exactify', () => {
  const bundle = adr({ pcRelTarget: [4096] });
  assert.notEqual(bundle?.completeness, 'exact');
});

test('6059: boolean pcRelTarget does not exactify', () => {
  const bundle = adr({ pcRelTarget: true });
  assert.notEqual(bundle?.completeness, 'exact');
});

test('6059: array address does not exactify', () => {
  const bundle = adr({ address: [0] });
  assert.notEqual(bundle?.completeness, 'exact');
});
