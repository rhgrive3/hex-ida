import test from 'node:test';
import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';

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
