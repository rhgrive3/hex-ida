import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { closeTrustedX86Partial } from '../../js/targets/architecture/x86_64/effects/trusted-decoder-terminal.js';

// Issue #5563: the trusted decoder terminal must not convert IRET/IRETD/IRETQ
// into a `trap` control effect. The Capstone `iret` group is classification
// metadata, not a trap direction; IRET* restores RIP/CS/RFLAGS (and more) from
// the interrupt stack frame and returns from an interrupt/exception handler.
// While dedicated interrupt-return semantics are unproven, the system owner's
// fail-closed `unknown` control must survive terminalization.

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
    [[0x48, 0xcf], 'iretq'],
    [[0xcf], 'iretd'],
    [[0x66, 0xcf], 'iret'],
  ]) {
    const decoded = capstone.decode(raw, 0x1000n);
    assert.equal(decoded.length, 1, `instruction must decode once: ${mnemonic}`);
    const instruction = createX86DecodedInstruction({
      ...decoded[0],
      instructionId: `issue-5563:${mnemonic}`,
      detail: { ...(decoded[0].detail ?? {}), flagsKind: 'eflags' },
    });
    assert.equal(instruction.mnemonic, mnemonic);

    // Even the legacy closure-matrix option must not invent a trap.
    const outcome = projectTerminal(instruction);
    assert.equal(outcome.ownerId, 'system', `${mnemonic} must stay with the system owner`);
    const result = outcome.result;
    assert.equal(result?.completeness, 'partial', `${mnemonic} without dedicated semantics must stay partial`);
    assert.equal(result?.controlEffect?.kind, 'unknown', `${mnemonic} control must stay fail-closed unknown`);
    assert.notEqual(result?.controlEffect?.kind, 'trap', `${mnemonic} must never be reclassified as a trap`);
    assert.notEqual(result?.metadata?.terminalizedBy, 'trusted-capstone-structured-intrinsic');
    assert.equal(result?.unknownEffects?.reason, 'x86-extended-system-family-requires-dedicated-semantics');
  }
} finally {
  capstone.close();
}

// The guard itself is part of the regression: the iret decoder group must not
// feed the trap promotion branch.
const terminalSource = await readFile(
  new URL('../../js/targets/architecture/x86_64/effects/trusted-decoder-terminal.js', import.meta.url),
  'utf8',
);
assert.doesNotMatch(
  terminalSource,
  /groups\.has\('int'\)\s*\|\|\s*groups\.has\('iret'\)/,
  'the iret decoder group must not feed the trap promotion branch',
);
assert.match(
  terminalSource,
  /groups\.has\('iret'\)\) return null/,
  'IRET* must cancel group-based control promotion instead of minting a trap',
);

console.log('issue-5563 trusted terminal must not convert IRET* into a trap: PASS');
