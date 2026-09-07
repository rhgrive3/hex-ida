import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARM64_ATOMIC_EFFECT_MNEMONICS,
  liftArm64AtomicEffects,
} from '../../js/targets/architecture/arm64/effects/atomic.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import {
  ARM64_SYSTEM_EFFECT_MNEMONICS,
  liftArm64SystemEffects,
} from '../../js/targets/architecture/arm64/effects/system.js';
import { arm64BarrierScope } from '../../js/targets/architecture/arm64/effects/barrier-options.js';

// DSB (and only DSB) accepts the nXS option variants (ARMv8.7+). The
// memory/atomic family owns barriers in the production dispatch order, so its
// option table must know them or every `dsb <X>nXS` falls to partial while
// the system family's exact implementation stays unreachable (#6073).

function lift(mnemonic, option) {
  const operand = option && typeof option === 'object' ? option : option ? { k:'other', text:option } : null;
  return liftArm64MachineEffects({
    instructionId: `arm64-dsb-nxs-${mnemonic}-${option || 'none'}`,
    architectureId: 'arm64',
    mode: 'a64',
    mnemonic,
    ops: operand ? [operand] : [],
  });
}

function liftAtomic(mnemonic, option) {
  const operand = option ? { k:'other', text:option } : null;
  return liftArm64AtomicEffects({
    instructionId:`arm64-dsb-nxs-atomic-${mnemonic}-${option || 'none'}`,
    architectureId:'arm64',
    mode:'a64',
    mnemonic,
    ops:operand ? [operand] : [],
  });
}

function liftSystem(mnemonic, option) {
  const operand = option && typeof option === 'object' ? option : option ? { k:'other', text:option } : null;
  const instructionId = `arm64-dsb-nxs-system-${mnemonic}-${option || 'none'}`;
  return liftArm64SystemEffects({
    instructionId,
    architectureId:'arm64',
    mode:'a64',
    mnemonic,
    ops:operand ? [operand] : [],
  });
}

const NXS_SCOPES = {
  oshnxs:{ domain:'outer-shareable', access:'all' },
  nshnxs:{ domain:'non-shareable', access:'all' },
  ishnxs:{ domain:'inner-shareable', access:'all' },
  synxs:{ domain:'full-system', access:'all' },
};

test('#6073: DSB nXS variants lift to exact barrier effects', () => {
  for (const [option, expectedScope] of Object.entries(NXS_SCOPES)) {
    const bundle = lift('dsb', option);
    assert.equal(bundle.completeness, 'exact', `dsb ${option}`);
    const barrier = bundle.operations.find((x) => x.kind === 'barrier');
    assert.ok(barrier, `dsb ${option} owns a barrier operation`);
    assert.equal(barrier.scope.option, option);
    assert.deepEqual(
      { domain:barrier.scope.domain, access:barrier.scope.access, nonXs:barrier.scope.nonXs },
      { ...expectedScope, nonXs:true },
      `dsb ${option} barrier scope`,
    );
    assert.deepEqual(
      { domain:bundle.metadata.domain, access:bundle.metadata.access, nonXs:bundle.metadata.nonXs },
      { ...expectedScope, nonXs:true },
      `dsb ${option} bundle metadata`,
    );
  }
});

test('#6073: canonical DSB nXS immediate encodings are exact', () => {
  for (const [crm, [option, expectedScope]] of [[
    16n, ['oshnxs', NXS_SCOPES.oshnxs],
  ], [
    20n, ['nshnxs', NXS_SCOPES.nshnxs],
  ], [
    24n, ['ishnxs', NXS_SCOPES.ishnxs],
  ], [
    28n, ['synxs', NXS_SCOPES.synxs],
  ]]) {
    const bundle = lift('dsb', { k:'imm', text:`#${crm}`, value:crm });
    const barrier = bundle.operations.find((x) => x.kind === 'barrier');
    assert.equal(bundle.completeness, 'exact', `dsb #${crm}`);
    assert.equal(bundle.metadata.option, option, `dsb #${crm} option`);
    assert.equal(bundle.metadata.crm, Number(crm), `dsb #${crm} encoding`);
    assert.deepEqual(
      { domain:barrier.scope.domain, access:barrier.scope.access, nonXs:barrier.scope.nonXs },
      { ...expectedScope, nonXs:true },
      `dsb #${crm} scope`,
    );
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

test('#6073: non-canonical DSB immediate encodings stay partial', () => {
  for (const crm of [17n, 21n, 25n, 29n]) {
    const bundle = lift('dsb', { k:'imm', text:`#${crm}`, value:crm });
    assert.equal(bundle.completeness, 'partial', `dsb #${crm}`);
    assert.ok(!bundle.operations.some((x) => x.kind === 'barrier'), `dsb #${crm}`);
  }
});

test('#6073: inherited selector names stay invalid across barrier owners', () => {
  assert.equal(arm64BarrierScope('__proto__'), null);
  assert.equal(arm64BarrierScope('constructor'), null);
  assert.ok(Object.isFrozen(arm64BarrierScope('oshnxs')));
  for (const mnemonic of ['dmb', 'dsb']) {
    for (const option of ['__proto__', 'constructor']) {
      for (const [owner, bundle] of [
        ['atomic', liftAtomic(mnemonic, option)],
        ['system', liftSystem(mnemonic, option)],
        ['dispatcher', lift(mnemonic, option)],
      ]) {
        assert.equal(bundle.completeness, 'partial', `${owner} ${mnemonic} ${option}`);
        assert.ok(!bundle.operations.some((x) => x.kind === 'barrier'), `${owner} ${mnemonic} ${option}`);
      }
    }
  }
});

test('#6073: duplicate barrier owners share selector domains', () => {
  const sharedMnemonics = [...new Set(ARM64_ATOMIC_EFFECT_MNEMONICS)]
    .filter((mnemonic) => ARM64_SYSTEM_EFFECT_MNEMONICS.has(mnemonic))
    .sort();
  assert.deepEqual(sharedMnemonics, ['clrex', 'dmb', 'dsb', 'isb']);
  const options = { clrex:null, dmb:'ish', dsb:'oshnxs', isb:'sy' };
  for (const mnemonic of sharedMnemonics) {
    const option = options[mnemonic];
    const atomic = liftAtomic(mnemonic, option);
    const system = liftSystem(mnemonic, option);
    assert.equal(system.completeness, atomic.completeness, `${mnemonic} owner completeness`);
    if (mnemonic === 'clrex') continue;
    const atomicScope = atomic.operations.find((x) => x.kind === 'barrier')?.scope;
    const systemScope = system.operations.find((x) => x.kind === 'barrier')?.scope;
    assert.deepEqual(
      { domain:systemScope?.domain, access:systemScope?.access, nonXs:systemScope?.nonXs },
      { domain:atomicScope?.domain, access:atomicScope?.access, nonXs:atomicScope?.nonXs },
      `${mnemonic} ${option} owner scope`,
    );
  }
});

test('#6073: canonical dispatcher preserves standard barrier owners', () => {
  for (const [mnemonic, option, kind] of [
    ['dmb', 'ish', 'barrier'],
    ['dsb', 'ish', 'barrier'],
    ['isb', 'sy', 'barrier'],
    ['ssbb', null, 'barrier'],
    ['pssbb', null, 'barrier'],
    ['clrex', null, 'intrinsic'],
  ]) {
    const bundle = lift(mnemonic, option);
    assert.ok(['exact', 'exact-with-intrinsic'].includes(bundle.completeness), `${mnemonic} remains exact`);
    assert.ok(bundle.operations.some((x) => x.kind === kind), `${mnemonic} retains its ${kind} effect`);
  }
});
