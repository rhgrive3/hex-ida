import test from 'node:test';
import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../../js/targets/architecture/arm64/effects/index.js';

let caseId = 0;
function lift(extra) {
  caseId += 1;
  return liftArm64MachineEffects({
    instructionId: `audit-arm64-ldr-literal-target-conflict-${caseId}`,
    architectureId: 'arm64',
    mode: 'a64',
    address: 0x1000n,
    mnemonic: 'ldr',
    rawBytes: [0x20, 0x00, 0x00, 0x58],
    ...extra,
  });
}

const coherentOps = [
  { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
  { k: 'imm', value: 0x1004n },
];

function genericImmediate(value) {
  return [
    { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
    { kind: 'immediate', value },
  ];
}

test('6078: coherent literal evidence stays exact', () => {
  const bundle = lift({ pcRelTarget: 0x1004n, ops: coherentOps });
  assert.equal(bundle?.completeness, 'exact');
});

test('6078: contradictory pcRelTarget does not exactify a wrong address', () => {
  const bundle = lift({ pcRelTarget: 0x1008n, ops: coherentOps });
  assert.notEqual(bundle?.completeness, 'exact');
  assert.match(bundle?.unknownEffects?.reason ?? '', /evidence-mismatch|disagrees/);
});

test('6078: contradictory literalTarget does not exactify a wrong address', () => {
  const bundle = lift({ literalTarget: 0x1008n, ops: coherentOps });
  assert.notEqual(bundle?.completeness, 'exact');
});

test('6078: single-source target still resolves', () => {
  const onlyImmediate = lift({ ops: coherentOps });
  assert.equal(onlyImmediate?.completeness, 'exact');
});

test('6078: generic immediate participates in target coherence', () => {
  const bundle = lift({ pcRelTarget: 0x1008n, ops: genericImmediate(0x1004n) });
  assert.notEqual(bundle?.completeness, 'exact');
  assert.match(bundle?.unknownEffects?.reason ?? '', /literal-target-evidence-mismatch/);
});

test('6078: generic immediate cannot bypass literal alignment proof', () => {
  const bundle = lift({ ops: genericImmediate(0x1002n) });
  assert.notEqual(bundle?.completeness, 'exact');
  assert.match(bundle?.unknownEffects?.reason ?? '', /literal-target-misaligned-encoding/);
});

test('6078: generic immediate cannot bypass literal range proof', () => {
  const bundle = lift({ ops: genericImmediate(0x300000n) });
  assert.notEqual(bundle?.completeness, 'exact');
  assert.match(bundle?.unknownEffects?.reason ?? '', /literal-target-out-of-range-encoding/);
});
