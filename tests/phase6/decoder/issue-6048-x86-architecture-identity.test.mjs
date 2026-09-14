import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMachineEffectsCoverage } from '../../../js/targets/architecture/coverage.js';
import '../../../js/targets/architecture/index.js';
import { createX86DecodedInstruction } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { liftX86MachineEffects } from '../../../js/targets/architecture/x86_64/effects/index.js';

function nop(extra = {}) {
  return createX86DecodedInstruction({
    address:0x1000n,
    length:1,
    rawBytes:Uint8Array.of(0x90),
    mode:'long-64',
    instructionCode:1,
    instructionFamily:'nop',
    instructionId:'issue-6048:nop',
    mnemonic:'nop',
    detailAvailable:true,
    detailStatus:'complete',
    detail:{ operandCount:0, operands:[], implicitReads:[], implicitWrites:[] },
    ...extra,
  });
}

test('6048: canonical x86 record always publishes x86_64 architecture identity', () => {
  const omitted = nop();
  assert.equal(omitted.architecture, 'x86_64');
  assert.equal(omitted.architectureId, 'x86_64');

  const declared = nop({ architecture:' X86_64 ', architectureId:'X86_64' });
  assert.equal(declared.architecture, 'x86_64');
  assert.equal(declared.architectureId, 'x86_64');
});

test('6048: contradictory or structured architecture declarations fail closed', () => {
  for (const extra of [
    { architecture:'arm64' },
    { architecture:'riscv64' },
    { architectureId:'arm64' },
    { architecture:'x86_64', architectureId:'arm64' },
    { architecture:'x86-64' },
    { architectureId:'x64' },
    { architecture:['x86_64'] },
    { architecture:new String('x86_64') },
    { architectureId:{ toString:() => 'x86_64' } },
  ]) {
    assert.throws(() => nop(extra), /x86-decoded-instruction-architecture-mismatch/);
  }
});

test('6048: x86 MachineEffects and coverage consume the same canonical identity', () => {
  const decoded = nop();
  const effects = liftX86MachineEffects(decoded);
  assert.equal(effects.architectureId, 'x86_64');

  const coverage = classifyMachineEffectsCoverage('x86_64', decoded);
  assert.equal(coverage.status, 'covered');
  assert.equal(coverage.architectureId, 'x86_64');
});
