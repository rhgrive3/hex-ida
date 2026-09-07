import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';
import { liftArm64eEffects } from '../../js/targets/architecture/arm64e/effects.js';
import {
  ARM64E_A64_DELEGATION_DENOMINATOR_ID,
  ARM64E_A64_DELEGATION_DENOMINATOR_SCHEMA,
  ARM64E_A64_DELEGATION_UNITS,
  ARM64E_BASELINE_FEATURE_ALIAS_MNEMONICS,
  arm64BaselineDependencyStatus,
  validateArm64eA64DelegationDenominator,
} from '../../tools/validation/machine-effects/arm64e-a64-delegation-denominator.mjs';
import { validateArm64ePacDenominator } from '../../tools/validation/machine-effects/arm64e-pac-denominator.mjs';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
}

const proof = validateArm64eA64DelegationDenominator();
assert.equal(proof.valid, true);
assert.equal(proof.schemaVersion, ARM64E_A64_DELEGATION_DENOMINATOR_SCHEMA);
assert.equal(proof.denominatorId, ARM64E_A64_DELEGATION_DENOMINATOR_ID);
assert.equal(proof.profileId, 'arm64e:a64+pac');
assert.deepEqual(proof.units, ARM64E_A64_DELEGATION_UNITS);
assert.equal(proof.delegationMechanismStatus, 'proven');

const pac = validateArm64ePacDenominator();
assert.equal(proof.pacDenominatorId, pac.denominatorId, 'delegation proof must reuse the existing exact PAC denominator identity');
assert.equal(proof.pacEncodingCaseCount, pac.encodingCaseCount, 'delegation proof must not redefine the PAC denominator');
assert.equal(proof.pacMnemonicCount, pac.mnemonicCount);
assert.equal(proof.pacDispatchOwnerCount, pac.mnemonicCount, 'every PAC mnemonic must be extension-owned before baseline delegation');
assert.equal(proof.normativeExclusions.length, 1, 'delegation proof must not expand malformed-PAC normative exclusions');
assert.equal(proof.normativeExclusions[0], 'pac-missing-structured-operands');
assert.equal(proof.malformedPacDisposition, 'partial-fail-closed-no-baseline-delegation');

assert.equal(proof.knownBaselineDenominators.length, 5);
assert.equal(proof.knownBaselineEncodingCaseCount, 376_186);
assert.equal(proof.baselineFeatureAliasOverlapCount, 9,
  'only the architecturally feature-sensitive PAC/HINT aliases may overlap the baseline raw A64 system region');
assert.equal(proof.strictBaselineDisjointEncodingCaseCount, 376_177);
assert.deepEqual(
  proof.baselineFeatureAliasOverlaps.map(({ pacMnemonic }) => pacMnemonic).sort(),
  [...ARM64E_BASELINE_FEATURE_ALIAS_MNEMONICS].sort(),
);
assert.equal(proof.positiveDelegationSampleCount, 5);
assert.ok(proof.delegatedFamilies.includes('integer'));
assert.ok(proof.delegatedFamilies.includes('flags'));
assert.ok(proof.delegatedFamilies.includes('control'));
assert.ok(proof.delegatedFamilies.includes('arm64-fp'));
assert.ok(proof.delegatedFamilies.includes('arm64-system'));
assert.equal(proof.fallbackDisposition, 'null-after-single-canonical-arm64-attempt',
  'invalid/non-owned input must fail closed after exactly one canonical ARM64 attempt');

const session = await createCapstoneArm64Session();
try {
  for (const overlap of proof.baselineFeatureAliasOverlaps) {
    const raw = session.decode(bytes32(overlap.word), 0x900000n)[0];
    assert.ok(raw, `${overlap.pacMnemonic}: feature-alias encoding must decode`);
    assert.equal(raw.mnemonic, overlap.pacMnemonic, `${overlap.pacMnemonic}: ARM64e/PAuth decoder identity`);
    const instructionId = `arm64e-delegation:feature-alias:${overlap.pacMnemonic}`;
    const decoded = {
      instructionId,
      address: raw.address,
      mnemonic: raw.mnemonic,
      opStr: raw.opStr,
      ops: parseOperands(raw.opStr),
      mode: 'arm64e',
      origin: { instructionIds: [instructionId] },
    };
    assert.equal(liftArm64SystemEffects(decoded), null, `${overlap.pacMnemonic}: baseline system lifter must not duplicate PAC semantics`);
    const pacEffects = liftArm64eEffects(decoded);
    assert.ok(pacEffects, `${overlap.pacMnemonic}: PAC extension must own the feature alias`);
    assert.equal(pacEffects.completeness, 'exact-with-intrinsic');
    assert.equal(pacEffects.metadata.family, 'arm64e-pointer-authentication');
    assert.equal(pacEffects.instructionId, instructionId);
    assert.deepEqual(pacEffects.origin.instructionIds, [instructionId]);
  }
} finally {
  session.close();
}

const dependency = arm64BaselineDependencyStatus();
assert.deepEqual(proof.dependency, dependency);
assert.equal(proof.terminalEligible, dependency.terminalEligible);
assert.equal(proof.terminalStatus, dependency.terminalEligible ? 'exact-via-arm64-baseline' : 'blocked-on-arm64-baseline');
if (!dependency.terminalEligible) {
  assert.ok(dependency.blockingUnits.length > 0, 'non-terminal ARM64 baseline dependency must name its blockers');
} else {
  assert.deepEqual(dependency.blockingUnits, []);
}

// The delegated baseline has no coverage of its own: a non-exact ARM64 family
// or a re-opened ARM64 decoder unit must pull it straight back to blocked,
// including through the fallback family, whose exemption is a negative proof
// rather than a standing allowance.
const baselineInventory = JSON.parse(fs.readFileSync(new URL('./a2-denominator-inventory.json', import.meta.url), 'utf8'));
function mutatedBaseline(mutate) {
  const clone = JSON.parse(JSON.stringify(baselineInventory));
  mutate(clone.architectures.find((architecture) => architecture.id === 'arm64'));
  return arm64BaselineDependencyStatus(clone);
}
const reopenedDecoder = mutatedBaseline((arm64) => {
  arm64.decoder.enumerationStatus = 'excluded';
  arm64.decoder.missingUnits = ['arm64:a64:all-decoder-encodings-and-aliases'];
});
assert.equal(reopenedDecoder.terminalEligible, false);
assert.ok(reopenedDecoder.blockingUnits.includes('arm64:a64:all-decoder-encodings-and-aliases'));
assert.ok(
  mutatedBaseline((arm64) => { arm64.decoder.enumerationStatus = 'excluded'; }).blockingUnits
    .includes('arm64:a64:effect-family:fallback-unmatched-decoder-family'),
  'the fallback exemption must disappear with the decoder ownership proof that justifies it',
);
const reopenedFamily = mutatedBaseline((arm64) => {
  const memory = arm64.effectRegistry.families.find((family) => family.id === 'memory');
  memory.status = 'excluded';
  memory.coverage = 'partial';
});
assert.equal(reopenedFamily.terminalEligible, false);
assert.ok(reopenedFamily.blockingUnits.includes('arm64:a64:effect-family:memory'));

console.log(`ARM64e A64 delegation denominator (${proof.knownBaselineEncodingCaseCount} known baseline cases + ${proof.pacEncodingCaseCount} PAC cases): PASS; dependency=${proof.terminalStatus}`);
