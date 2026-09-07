import test from 'node:test';
import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../../js/targets/architecture/arm64/effects/index.js';

let caseId = 0;
function lift(mnemonic, operand) {
  caseId += 1;
  return liftArm64MachineEffects({
    instructionId: `audit-dsb-nxs-${caseId}`,
    architectureId: 'arm64',
    mode: 'a64',
    mnemonic,
    ops: operand == null ? [] : [typeof operand === 'object' ? operand : { k: 'other', text: operand }],
  });
}

function assertBarrier(bundle, option) {
  assert.ok(bundle, 'expected a bundle');
  assert.notEqual(bundle.completeness, 'partial', `dsb ${option} must not be an unsupported-option partial`);
  assert.ok(
    (bundle.operations ?? []).some((op) => op?.kind === 'barrier'),
    `dsb ${option} must carry a barrier operation`,
  );
}

test('6073: DSB nXS selectors reach exact barrier semantics', () => {
  for (const option of ['oshnxs', 'nshnxs', 'ishnxs', 'synxs']) {
    assertBarrier(lift('dsb', option), option);
  }
});

test('6073: nXS barriers keep their base domain', () => {
  const ish = lift('dsb', 'ishnxs');
  const op = ish.operations.find((item) => item?.kind === 'barrier');
  assert.equal(op?.scope?.domain, 'inner-shareable');
  assert.equal(op?.scope?.nxs, true);
  const osh = lift('dsb', 'oshnxs');
  const oshOp = osh.operations.find((item) => item?.kind === 'barrier');
  assert.equal(oshOp?.scope?.domain, 'outer-shareable');
});

test('6073: canonical nXS immediate encodings reach exact barrier semantics', () => {
  const expected = [
    [16, 'outer-shareable'],
    [20, 'non-shareable'],
    [24, 'inner-shareable'],
    [28, 'full-system'],
  ];
  for (const [immediate, domain] of expected) {
    const bundle = lift('dsb', { k: 'imm', value: BigInt(immediate) });
    assertBarrier(bundle, `#${immediate}`);
    const op = bundle.operations.find((item) => item?.kind === 'barrier');
    assert.equal(op?.scope?.domain, domain);
    assert.equal(op?.scope?.nxs, true);
    assert.equal(op?.metadata?.crm, immediate);
  }
});

test('6073: classic selectors are unchanged', () => {
  for (const option of ['sy', 'ish', 'osh', 'nsh']) {
    assertBarrier(lift('dsb', option), option);
  }
  const classic = lift('dsb', 'ish');
  const op = classic.operations.find((item) => item?.kind === 'barrier');
  assert.equal(op?.scope?.nxs ?? null, null);
});

test('6073: unknown selectors stay fail-closed', () => {
  const bundle = lift('dsb', 'notanoption');
  assert.equal(bundle?.completeness, 'partial');
  assert.match(bundle?.unknownEffects?.reason ?? '', /unsupported DSB option/);
});
