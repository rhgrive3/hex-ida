import test from 'node:test';
import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../../js/targets/architecture/arm64/effects/index.js';

let caseId = 0;
function lift(mnemonic, ops, extra = {}) {
  caseId += 1;
  return liftArm64MachineEffects({
    instructionId: `audit-arm64-target-coherence-${caseId}`,
    mode: 'a64',
    address: 0x1000n,
    mnemonic,
    ...extra,
    ops,
  });
}

test('6067: contradictory branchTarget does not exactify a wrong target', () => {
  const bundle = lift('b', [{ k: 'imm', value: 0x1004n }], {
    rawBytes: [0x01, 0x00, 0x00, 0x14],
    branchTarget: 0x1008n,
  });
  assert.notEqual(bundle?.completeness, 'exact');
  assert.match(bundle?.unknownEffects?.reason ?? '', /target-evidence-mismatch/);
});

test('6067: coherent branch evidence stays exact', () => {
  const bundle = lift('b', [{ k: 'imm', value: 0x1004n }], { branchTarget: 0x1004n });
  assert.equal(bundle?.completeness, 'exact');
  assert.equal(bundle?.controlEffect?.target?.value, '4100');
});

test('6067: contradictory callTarget does not exactify', () => {
  const bundle = lift('bl', [{ k: 'imm', value: 0x1004n }], { callTarget: 0x1008n });
  assert.notEqual(bundle?.completeness, 'exact');
  assert.match(bundle?.unknownEffects?.reason ?? '', /target-evidence-mismatch/);
});

test('6067: operand-only target still resolves', () => {
  const bundle = lift('b', [{ k: 'imm', value: 0x1004n }]);
  assert.equal(bundle?.completeness, 'exact');
});

test('6067: bc.cond contradictory branchTarget does not exactify', () => {
  const bundle = lift('bc.eq', [{ k: 'imm', value: 0x1004n }], { branchTarget: 0x1008n });
  assert.notEqual(bundle?.completeness, 'exact');
  assert.match(bundle?.unknownEffects?.reason ?? '', /target-evidence-mismatch/);
});

test('6067: coherent bc.cond target evidence stays exact', () => {
  const bundle = lift('bc.eq', [{ k: 'imm', value: 0x1004n }], { branchTarget: 0x1004n });
  assert.equal(bundle?.completeness, 'exact');
  assert.equal(bundle?.controlEffect?.target?.value, '4100');
});
