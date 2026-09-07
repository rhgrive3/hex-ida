import assert from 'node:assert/strict';
import test from 'node:test';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

// DSB (and only DSB) accepts the nXS option variants (ARMv8.7+). The
// memory/atomic family owns barriers in the production dispatch order, so its
// option table must know them or every `dsb <X>nXS` falls to partial while
// the system family's exact implementation stays unreachable (#6073).

function lift(mnemonic, option) {
  return liftArm64MachineEffects({
    instructionId: `arm64-dsb-nxs-${mnemonic}-${option || 'none'}`,
    architectureId: 'arm64',
    mode: 'a64',
    mnemonic,
    ops: option ? [{ k: 'other', text: option }] : [],
  });
}

test('#6073: DSB nXS variants lift to exact barrier effects', () => {
  for (const option of ['oshnxs', 'nshnxs', 'ishnxs', 'synxs']) {
    const bundle = lift('dsb', option);
    assert.equal(bundle.completeness, 'exact', `dsb ${option}`);
    const barrier = bundle.operations.find((x) => x.kind === 'barrier');
    assert.ok(barrier, `dsb ${option} owns a barrier operation`);
    assert.equal(barrier.scope.option, option);
  }
});

test('#6073: regular DSB options and DMB/ISB behavior are unchanged', () => {
  assert.equal(lift('dsb', 'ish').completeness, 'exact');
  assert.equal(lift('dsb', '').completeness, 'exact');
  assert.equal(lift('dmb', 'ish').completeness, 'exact');
  assert.equal(lift('isb', 'sy').completeness, 'exact');
});

test('#6073: nXS stays rejected for DMB and unknown options stay partial', () => {
  for (const [mnemonic, option] of [['dmb', 'ishnxs'], ['dsb', 'foo'], ['isb', 'synxs']]) {
    const bundle = lift(mnemonic, option);
    assert.equal(bundle.completeness, 'partial', `${mnemonic} ${option}`);
    assert.ok(!bundle.operations.some((x) => x.kind === 'barrier'));
  }
});
