import test from 'node:test';
import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../../js/targets/architecture/arm64/effects/index.js';

let caseId = 0;
function lift(mnemonic, text) {
  caseId += 1;
  return liftArm64MachineEffects({
    instructionId: `audit-dsb-nxs-${caseId}`,
    architectureId: 'arm64',
    mode: 'a64',
    mnemonic,
    ops: text == null ? [] : [{ k: 'other', text }],
  });
}

function liftImmediate(mnemonic, value) {
  caseId += 1;
  return liftArm64MachineEffects({
    instructionId: `audit-dsb-nxs-imm-${caseId}`,
    architectureId: 'arm64',
    mode: 'a64',
    mnemonic,
    ops: [{ k:'imm', value:BigInt(value) }],
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

test('6073: encoded DSB nXS immediates use their architectural selectors', () => {
  for (const [immediate, option, domain] of [
    [16, 'oshnxs', 'outer-shareable'],
    [20, 'nshnxs', 'non-shareable'],
    [24, 'ishnxs', 'inner-shareable'],
    [28, 'synxs', 'full-system'],
  ]) {
    const bundle = liftImmediate('dsb', immediate);
    assertBarrier(bundle, option);
    const op = bundle.operations.find((item) => item?.kind === 'barrier');
    assert.equal(op?.scope?.option, option);
    assert.equal(op?.scope?.domain, domain);
    assert.equal(op?.scope?.nxs, true);
    assert.equal(op?.metadata?.crm, immediate);
  }
  assert.equal(liftImmediate('dsb', 17)?.completeness, 'partial',
    'unassigned immediate encodings must remain fail-closed');
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
