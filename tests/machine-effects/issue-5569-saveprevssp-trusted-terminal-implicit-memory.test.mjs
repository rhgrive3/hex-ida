import assert from 'node:assert/strict';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { closeTrustedX86Partial } from '../../js/targets/architecture/x86_64/effects/trusted-decoder-terminal.js';

// Issue #5569: SAVEPREVSSP is an operandless CET instruction that
// architecturally reads (pops) the previous-SSP token from the current shadow
// stack and writes restore tokens back. The decoder operand surface carries no
// memory operand, so the trusted decoder terminal must not publish a
// `memory:none` exact-with-intrinsic summary for it (or for any other
// operandless system instruction with unproven implicit memory). The
// fail-closed system partial is the only safe state until dedicated
// shadow-stack semantics prove the implicit access surface.

// Reuse #7514's terminal projection regression without impersonating a
// Worker realm or minting private row authority. Public dispatch stays partial;
// the real receiver path is separately exercised by phase6:browser.
function projectTerminal(instruction) {
  const outcome = dispatchX86MachineEffects(instruction, { closureMatrixTerminal: true });
  assert.equal(outcome.result?.completeness, 'partial', 'unbranded public dispatch stays fail-closed');
  return { ownerId: outcome.ownerId, result: closeTrustedX86Partial(
    instruction, outcome.ownerId, outcome.result, { closureMatrixTerminal: true },
  ) };
}

const capstone = await createCapstoneX86Session();
try {
  for (const [raw, mnemonic] of [
    [[0xf3, 0x0f, 0x01, 0xea], 'saveprevssp'],
    [[0x0f, 0x32], 'rdmsr'],
    [[0x0f, 0x30], 'wrmsr'],
  ]) {
    const decoded = capstone.decode(raw, 0x1000n);
    assert.equal(decoded.length, 1, `instruction must decode once: ${mnemonic}`);
    const instruction = createX86DecodedInstruction({
      ...decoded[0],
      instructionId: `issue-5569:${mnemonic}`,
      detail: { ...(decoded[0].detail ?? {}), flagsKind: 'eflags' },
    });
    assert.equal(instruction.mnemonic, mnemonic);
    const memoryOperands = (instruction.detail?.operands || []).filter((operand) => operand?.type === 'memory');
    assert.equal(memoryOperands.length, 0, `${mnemonic} must be operandless for this proof`);

    const outcome = projectTerminal(instruction);
    assert.equal(outcome.ownerId, 'system', `${mnemonic} must stay with the system owner`);
    const result = outcome.result;
    assert.equal(result?.completeness, 'partial', `${mnemonic} without an implicit-memory proof must stay partial`);
    assert.notEqual(result?.metadata?.terminalizedBy, 'trusted-capstone-structured-intrinsic');
    assert.equal(result?.controlEffect?.kind, 'unknown');
    assert.equal(result?.unknownEffects?.reason, 'x86-extended-system-family-requires-dedicated-semantics');
    if (Array.isArray(result?.operations)) {
      for (const operation of result.operations) {
        const summary = operation?.effectSummary;
        assert.notEqual(
          summary?.memoryRead?.scope,
          'none',
          `${mnemonic} must never publish a memoryRead:none summary while unproven`,
        );
        assert.notEqual(
          summary?.memoryWrite?.scope,
          'none',
          `${mnemonic} must never publish a memoryWrite:none summary while unproven`,
        );
      }
    }
  }

  // The explicit-memory surface of regular system rows (e.g. SGDT) still
  // terminalizes from its decoder operand evidence, so the gate does not
  // blanket-disable the system owner's trusted path.
  const sgdt = capstone.decode([0x0f, 0x01, 0x00], 0x3000n);
  const sgdtInstruction = createX86DecodedInstruction({
    ...sgdt[0],
    instructionId: 'issue-5569:sgdt-explicit-memory',
    detail: { ...(sgdt[0].detail ?? {}), flagsKind: 'eflags' },
  });
  const sgdtOutcome = projectTerminal(sgdtInstruction);
  assert.equal(sgdtOutcome.ownerId, 'system');
  assert.equal(sgdtOutcome.result?.completeness, 'exact-with-intrinsic');
  const sgdtSummary = sgdtOutcome.result?.operations?.[0]?.effectSummary;
  assert.equal(sgdtSummary?.memoryWrite?.scope, 'accesses', 'SGDT keeps its explicit 10-byte pseudo-descriptor write');
} finally {
  capstone.close();
}

console.log('issue-5569 operandless system implicit memory stays fail-closed partial: PASS');
