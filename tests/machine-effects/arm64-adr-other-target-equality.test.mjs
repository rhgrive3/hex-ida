import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer.js';

let sequence = 0;
function adr(mnemonic = 'adr', pcRelTarget, otherText, address = 0x1000n) {
  sequence += 1;
  const instructionId = `adr-other-conflict-${sequence}`;
  return {
    instructionId,
    architectureId: 'arm64',
    mode: 'a64',
    mnemonic,
    address,
    pcRelTarget,
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      { k: 'other', text: otherText },
    ],
    origin: { instructionIds: [instructionId] },
  };
}

// #6101: a numeric `other` target text is canonical address evidence (the
// pipeline already parses it through directTargetOf when pcRelTarget is
// absent). When both canonical evidences exist and disagree, the record must
// fail closed instead of silently promoting the structured pcRelTarget.
{
  const conflict = liftArm64MachineEffects(adr('adr', 0x1004n, '0x2000'));
  assert.equal(conflict?.completeness, 'partial', 'conflicting other text must fail closed at the top-level gate');
  assert.equal(conflict.operations.length, 0, 'conflicting evidence emits zero definite operations');
  assert.match(conflict.unknownEffects?.reason ?? '', /target-evidence-mismatch/);
  const integer = liftArm64IntegerEffects(adr('adr', 0x1004n, '0x2000'));
  assert.equal(integer?.completeness, 'partial', 'integer family must reject conflicting evidence too');
}

// ADRP symmetry.
{
  const conflict = liftArm64MachineEffects(adr('adrp', 0x100000n, '0x200000'));
  assert.equal(conflict?.completeness, 'partial', 'conflicting ADRP evidence must fail closed');
  const agree = liftArm64MachineEffects(adr('adrp', 0x200000n, '0x200000'));
  assert.equal(agree?.completeness, 'exact', 'agreeing ADRP evidence stays exact');
}

// Agreeing evidence keeps the exact address result.
{
  const agree = liftArm64MachineEffects(adr('adr', 0x2000n, '0x2000'));
  assert.equal(agree?.completeness, 'exact');
  const write = agree.operations.find((operation) => operation.kind === 'register-write');
  assert.equal(write?.value?.value, 8192n.toString());
}

// Non-numeric `other` text is symbolic spelling, not conflicting evidence.
{
  const symbolic = liftArm64MachineEffects(adr('adr', 0x1004n, 'symbolic-target'));
  assert.equal(symbolic?.completeness, 'exact', 'symbolic other text does not conflict with the structured target');
}

// Decimal `other` spellings participate in the same equality authority.
{
  const conflict = liftArm64MachineEffects(adr('adr', 0x1004n, '8192'));
  assert.equal(conflict?.completeness, 'partial', 'decimal other text conflict must fail closed');
  const agree = liftArm64MachineEffects(adr('adr', 0x2000n, '8192'));
  assert.equal(agree?.completeness, 'exact');
}

// Integer-family agreement keeps the exact constant.
{
  const agree = liftArm64IntegerEffects(adr('adr', 0x2000n, '0x2000'));
  assert.equal(agree?.completeness, 'exact');
}

console.log('ARM64 ADR/ADRP other-target evidence equality (#6101): PASS');
