import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';

let address = 0x41510000n;
function instruction(mnemonic) {
  const virtualAddress = address;
  address += 4n;
  const instructionId = createInstructionId({
    binaryId:'bin_issue_4151',
    sliceId:'slice_issue_4151',
    virtualAddress,
    decodeMode:'a64',
    decoderSemanticVersion:'1',
  });
  return { mnemonic, ops:[], instructionId, origin:{ instructionIds:[instructionId] } };
}

for (const mnemonic of ['wfi', 'wfe']) {
  const effect = liftArm64SystemEffects(instruction(mnemonic));
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.equal(effect.controlEffect.kind, 'fallthrough', `${mnemonic} normal execution still falls through`);
  assert.deepEqual(effect.possibleFaults, [{
    kind:'system-instruction-trap',
    condition:{ kind:'architectural-access-check', operation:mnemonic },
  }], `${mnemonic} must retain the environment-dependent trap path`);
  assert.doesNotThrow(() => validateMachineEffectBundle(effect));
}

for (const mnemonic of ['yield', 'sev', 'sevl']) {
  const effect = liftArm64SystemEffects(instruction(mnemonic));
  assert.deepEqual(effect.possibleFaults, [], `${mnemonic} is outside issue #4151 and must not gain a trap edge`);
  assert.doesNotThrow(() => validateMachineEffectBundle(effect));
}

console.log('issue #4151 ARM64 WFI/WFE trap provenance: PASS');
