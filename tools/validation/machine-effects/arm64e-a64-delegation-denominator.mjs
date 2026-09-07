import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOperands } from '../../../js/arm64.js';
import { arm64A64DecoderDenominatorFromLockedAudit } from './arm64-a64-decoder-denominator.mjs';
import { arm64A64MemoryDecoderDependencyProof } from './arm64-a64-memory-denominator.mjs';
import { arm64A64SimdDecoderDependencyProof } from './arm64-a64-simd-denominator.mjs';
import { liftArm64MachineEffects } from '../../../js/targets/architecture/arm64/effects/index.js';
import {
  arm64ePointerAuthenticationMnemonics,
  extendArm64WithArm64eEffects,
} from '../../../js/targets/architecture/arm64e/effects.js';
import {
  arm64A64ControlEncodingCases,
  validateArm64A64ControlDenominator,
} from './arm64-a64-control-denominator.mjs';
import {
  arm64A64FlagEncodingCases,
  validateArm64A64FlagsDenominator,
} from './arm64-a64-flags-denominator.mjs';
import {
  arm64A64FpEncodingCases,
  validateArm64A64FpDenominator,
} from './arm64-a64-fp-denominator.mjs';
import {
  arm64A64IntegerEncodingCases,
  validateArm64A64IntegerDenominator,
} from './arm64-a64-integer-denominator.mjs';
import {
  arm64A64SystemEncodingCases,
  validateArm64A64SystemDenominator,
} from './arm64-a64-system-denominator.mjs';
import {
  ARM64E_PAC_DENOMINATOR_ID,
  ARM64E_PAC_ENCODING_FAMILIES,
  classifyArm64ePacEncoding,
  validateArm64ePacDenominator,
} from './arm64e-pac-denominator.mjs';

export const ARM64E_A64_DELEGATION_DENOMINATOR_SCHEMA = 'arm64e-a64-delegation-denominator/v1';
export const ARM64E_A64_DELEGATION_DENOMINATOR_ID = 'arm64e:a64+pac:baseline-a64-delegation:v1';

export const ARM64E_A64_DELEGATION_UNITS = Object.freeze([
  'arm64e:a64+pac:all-a64-decoder-encodings-and-aliases',
  'arm64e:a64+pac:alias:baseline-a64-delegation',
  'arm64e:a64+pac:effect-family:fallback-unmatched-decoder-family',
]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INVENTORY_PATH = path.join(ROOT, 'tests/machine-effects/a2-denominator-inventory.json');
const BASELINE_DECODER_UNIT = 'arm64:a64:all-decoder-encodings-and-aliases';
const MALFORMED_PAC_EXCLUSION = 'pac-missing-structured-operands';

export const ARM64E_BASELINE_FEATURE_ALIAS_MNEMONICS = Object.freeze([
  'xpaclri',
  'pacia1716',
  'pacib1716',
  'autia1716',
  'autib1716',
  'paciasp',
  'pacibsp',
  'autiasp',
  'autibsp',
]);

const BASELINE_DENOMINATORS = Object.freeze([
  Object.freeze({ id: 'control', validate: validateArm64A64ControlDenominator, cases: arm64A64ControlEncodingCases }),
  Object.freeze({ id: 'flags', validate: validateArm64A64FlagsDenominator, cases: arm64A64FlagEncodingCases }),
  Object.freeze({ id: 'fp', validate: validateArm64A64FpDenominator, cases: arm64A64FpEncodingCases }),
  Object.freeze({ id: 'integer', validate: validateArm64A64IntegerDenominator, cases: arm64A64IntegerEncodingCases }),
  Object.freeze({ id: 'system', validate: validateArm64A64SystemDenominator, cases: arm64A64SystemEncodingCases }),
]);

const BASELINE_POSITIVE_SAMPLES = Object.freeze([
  Object.freeze({ id: 'integer-add', mnemonic: 'add', opStr: 'x0, x1, x2' }),
  Object.freeze({ id: 'flags-cmp', mnemonic: 'cmp', opStr: 'x3, x4' }),
  Object.freeze({ id: 'control-b', mnemonic: 'b', opStr: '#0x1010' }),
  Object.freeze({ id: 'fp-fadd', mnemonic: 'fadd', opStr: 's0, s1, s2' }),
  Object.freeze({ id: 'system-nop', mnemonic: 'nop', opStr: '' }),
]);

function fail(code, detail = '') {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function sameSet(left, right) {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === left.length && right.every((value) => values.has(value));
}

function readInventory() {
  return JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
}

export function arm64BaselineDependencyStatus(inventory = readInventory()) {
  const arm64 = inventory?.architectures?.find((architecture) => architecture?.id === 'arm64');
  if (!arm64 || arm64.profileId !== 'arm64:a64') fail('arm64e-delegation-arm64-profile-missing');

  const blocking = new Set();
  const decoder = arm64.decoder || {};
  for (const unit of decoder.missingUnits || []) blocking.add(String(unit));
  if (decoder.enumerationStatus !== 'exact' && !blocking.has(BASELINE_DECODER_UNIT)) blocking.add(BASELINE_DECODER_UNIT);

  const families = arm64.effectRegistry?.families;
  if (!Array.isArray(families) || families.length === 0) fail('arm64e-delegation-arm64-effect-registry-missing');
  // The unmatched-family fallback exists to return null and can never be exact.
  // It stops blocking the delegated baseline only when the A64 decoder ownership
  // denominator proves no valid in-profile encoding can reach it — the same
  // negative proof the A2 denominator requires.
  const fallbackNegativeProven = decoder.enumerationStatus === 'exact'
    && (decoder.missingUnits || []).length === 0
    && arm64A64DecoderDenominatorFromLockedAudit({
      memory:arm64A64MemoryDecoderDependencyProof(),
      simd:arm64A64SimdDecoderDependencyProof(),
    }).fallbackNegativeProof === true;
  for (const family of families) {
    if (family?.status === 'exact') continue;
    if (family?.id === 'fallback-unmatched-decoder-family' && fallbackNegativeProven) continue;
    blocking.add(`arm64:a64:effect-family:${family?.id || 'unknown'}`);
  }

  const blockingUnits = Object.freeze([...blocking].sort());
  return Object.freeze({
    profileId: 'arm64:a64',
    status: blockingUnits.length === 0 ? 'exact' : 'blocked',
    terminalEligible: blockingUnits.length === 0,
    blockingUnits,
  });
}

function validatePacBoundary() {
  const pac = validateArm64ePacDenominator();
  const registry = [...arm64ePointerAuthenticationMnemonics()];
  const denominatorMnemonics = [...new Set(ARM64E_PAC_ENCODING_FAMILIES.map(({ mnemonic }) => mnemonic))];
  if (!sameSet(registry, denominatorMnemonics)) fail('arm64e-delegation-pac-registry-drift');
  if (pac.denominatorId !== ARM64E_PAC_DENOMINATOR_ID) fail('arm64e-delegation-pac-denominator-identity-drift');

  let baselineCaseCount = 0;
  const baselineSummaries = [];
  const featureAliasOverlaps = [];
  for (const denominator of BASELINE_DENOMINATORS) {
    const summary = denominator.validate();
    let familyCases = 0;
    for (const candidate of denominator.cases()) {
      const collision = classifyArm64ePacEncoding(candidate.word);
      if (collision) {
        featureAliasOverlaps.push(Object.freeze({
          baselineFamilyId: denominator.id,
          baselineCaseId: candidate.id,
          pacFamilyId: collision.id,
          pacMnemonic: collision.mnemonic,
          word: candidate.word >>> 0,
        }));
      }
      familyCases++;
    }
    if (familyCases !== summary.encodingCaseCount) fail('arm64e-delegation-baseline-case-count-drift', denominator.id);
    baselineCaseCount += familyCases;
    baselineSummaries.push(Object.freeze({
      familyId: denominator.id,
      denominatorId: summary.denominatorId,
      encodingCaseCount: familyCases,
    }));
  }

  const overlapMnemonics = featureAliasOverlaps.map(({ pacMnemonic }) => pacMnemonic);
  if (!sameSet(overlapMnemonics, ARM64E_BASELINE_FEATURE_ALIAS_MNEMONICS)) {
    fail('arm64e-delegation-feature-alias-boundary-drift', overlapMnemonics.join(','));
  }
  if (featureAliasOverlaps.some(({ baselineFamilyId }) => baselineFamilyId !== 'system')) {
    fail('arm64e-delegation-feature-alias-outside-system-hint-space');
  }

  return Object.freeze({
    pac,
    registryCount: registry.length,
    baselineCaseCount,
    strictBaselineDisjointCaseCount: baselineCaseCount - featureAliasOverlaps.length,
    baselineSummaries: Object.freeze(baselineSummaries),
    featureAliasOverlaps: Object.freeze(featureAliasOverlaps),
  });
}

function validateDispatchPartition() {
  const pacMnemonics = [...arm64ePointerAuthenticationMnemonics()];
  let baseCallCount = 0;
  const base = () => {
    baseCallCount++;
    return Object.freeze({ owner: 'unexpected-arm64-baseline' });
  };
  const lift = extendArm64WithArm64eEffects(base);

  for (const mnemonic of pacMnemonics) {
    const instructionId = `arm64e-delegation:pac:${mnemonic}`;
    const decoded = { instructionId, mnemonic, ops: [], mode: 'arm64e', origin: { instructionIds: [instructionId] } };
    const result = lift(decoded, { mode: 'arm64e' });
    if (result == null) fail('arm64e-delegation-pac-fell-through', mnemonic);
    if (result.metadata?.family !== 'arm64e-pointer-authentication') fail('arm64e-delegation-pac-owner-drift', mnemonic);
  }
  if (baseCallCount !== 0) fail('arm64e-delegation-pac-reached-baseline', String(baseCallCount));

  const ordinaryDecoded = Object.freeze({ mnemonic: '__arm64e_non_pac_delegation_class__' });
  const ordinaryContext = Object.freeze({ proof: 'delegation-identity' });
  const sentinel = Object.freeze({ owner: 'canonical-arm64-sentinel' });
  let delegatedArgs = null;
  const delegatedLift = extendArm64WithArm64eEffects((decoded, context) => {
    delegatedArgs = Object.freeze({ decoded, context });
    return sentinel;
  });
  const delegated = delegatedLift(ordinaryDecoded, ordinaryContext);
  if (delegated !== sentinel) fail('arm64e-delegation-result-identity-lost');
  if (delegatedArgs?.decoded !== ordinaryDecoded || delegatedArgs?.context !== ordinaryContext) fail('arm64e-delegation-input-identity-lost');

  const malformedId = 'arm64e-delegation:malformed-pacia';
  let malformedBaseCalls = 0;
  const malformed = extendArm64WithArm64eEffects(() => {
    malformedBaseCalls++;
    return sentinel;
  })({ instructionId: malformedId, mnemonic: 'pacia', ops: [], mode: 'arm64e', origin: { instructionIds: [malformedId] } });
  if (malformedBaseCalls !== 0) fail('arm64e-delegation-malformed-pac-reinterpreted-as-baseline');
  if (malformed?.completeness !== 'partial') fail('arm64e-delegation-malformed-pac-must-fail-closed');
  if (!/destination register is unavailable/.test(String(malformed?.unknownEffects?.reason || ''))) fail('arm64e-delegation-malformed-pac-reason-drift');

  return Object.freeze({
    pacOwnerCount: pacMnemonics.length,
    malformedPacDisposition: 'partial-fail-closed-no-baseline-delegation',
    malformedPacNormativeExclusion: MALFORMED_PAC_EXCLUSION,
  });
}

function makePositiveDecoded(sample, index) {
  const instructionId = `arm64e-delegation:a64:${sample.id}`;
  const address = 0x1000n + BigInt(index * 4);
  return Object.freeze({
    instructionId,
    address,
    mnemonic: sample.mnemonic,
    opStr: sample.opStr,
    ops: parseOperands(sample.opStr),
    mode: 'arm64e',
    origin: Object.freeze({ instructionIds: Object.freeze([instructionId]) }),
  });
}

function validateCanonicalBaselineDelegation() {
  const delegatedFamilies = [];
  for (let index = 0; index < BASELINE_POSITIVE_SAMPLES.length; index++) {
    const sample = BASELINE_POSITIVE_SAMPLES[index];
    const decoded = makePositiveDecoded(sample, index);
    const context = Object.freeze({ mode: 'arm64e' });
    let invocation = null;
    const lift = extendArm64WithArm64eEffects((candidate, candidateContext) => {
      const result = liftArm64MachineEffects(candidate, candidateContext);
      invocation = { candidate, candidateContext, result };
      return result;
    });
    const delegated = lift(decoded, context);
    if (invocation == null) fail('arm64e-delegation-canonical-baseline-not-called', sample.id);
    if (invocation.candidate !== decoded || invocation.candidateContext !== context) fail('arm64e-delegation-canonical-input-identity-lost', sample.id);
    if (delegated !== invocation.result) fail('arm64e-delegation-canonical-result-identity-lost', sample.id);
    if (delegated == null) fail('arm64e-delegation-positive-a64-unowned', sample.id);
    if (delegated.architectureId !== 'arm64') fail('arm64e-delegation-duplicate-arm64e-baseline-owner', sample.id);
    if (delegated.instructionId !== decoded.instructionId) fail('arm64e-delegation-instruction-identity-lost', sample.id);
    if (!sameSet(delegated.origin?.instructionIds || [], decoded.origin.instructionIds)) fail('arm64e-delegation-origin-provenance-lost', sample.id);
    delegatedFamilies.push(String(delegated.metadata?.family || sample.id));
  }

  const invalidId = 'arm64e-delegation:invalid';
  const invalid = Object.freeze({
    instructionId: invalidId,
    mnemonic: '__arm64e_invalid_encoding__',
    ops: Object.freeze([]),
    mode: 'arm64e',
    origin: Object.freeze({ instructionIds: Object.freeze([invalidId]) }),
  });
  let fallbackCalls = 0;
  const fallbackResult = extendArm64WithArm64eEffects((decoded, context) => {
    fallbackCalls++;
    return liftArm64MachineEffects(decoded, context);
  })(invalid, Object.freeze({ mode: 'arm64e' }));
  if (fallbackCalls !== 1) fail('arm64e-delegation-fallback-baseline-call-count', String(fallbackCalls));
  if (fallbackResult !== null) fail('arm64e-delegation-invalid-must-fail-closed');

  return Object.freeze({
    positiveSampleCount: BASELINE_POSITIVE_SAMPLES.length,
    delegatedFamilies: Object.freeze(delegatedFamilies),
    invalidDisposition: 'null-after-single-canonical-arm64-attempt',
  });
}

let validated = null;
export function validateArm64eA64DelegationDenominator() {
  if (validated) return validated;
  const boundary = validatePacBoundary();
  const dispatch = validateDispatchPartition();
  const baseline = validateCanonicalBaselineDelegation();
  const dependency = arm64BaselineDependencyStatus();

  validated = Object.freeze({
    valid: true,
    schemaVersion: ARM64E_A64_DELEGATION_DENOMINATOR_SCHEMA,
    denominatorId: ARM64E_A64_DELEGATION_DENOMINATOR_ID,
    profileId: 'arm64e:a64+pac',
    units: ARM64E_A64_DELEGATION_UNITS,
    delegationMechanismStatus: 'proven',
    terminalEligible: dependency.terminalEligible,
    terminalStatus: dependency.terminalEligible ? 'exact-via-arm64-baseline' : 'blocked-on-arm64-baseline',
    pacDenominatorId: boundary.pac.denominatorId,
    pacEncodingCaseCount: boundary.pac.encodingCaseCount,
    pacMnemonicCount: boundary.registryCount,
    knownBaselineEncodingCaseCount: boundary.baselineCaseCount,
    strictBaselineDisjointEncodingCaseCount: boundary.strictBaselineDisjointCaseCount,
    baselineFeatureAliasOverlapCount: boundary.featureAliasOverlaps.length,
    baselineFeatureAliasOverlaps: boundary.featureAliasOverlaps,
    knownBaselineDenominators: boundary.baselineSummaries,
    positiveDelegationSampleCount: baseline.positiveSampleCount,
    delegatedFamilies: baseline.delegatedFamilies,
    pacDispatchOwnerCount: dispatch.pacOwnerCount,
    malformedPacDisposition: dispatch.malformedPacDisposition,
    normativeExclusions: Object.freeze([dispatch.malformedPacNormativeExclusion]),
    fallbackDisposition: baseline.invalidDisposition,
    dependency,
    oracleIds: Object.freeze([
      'arm64e-pac-finite-discriminator-denominator',
      'canonical-arm64-machine-effects-lifter',
      'production-arm64e-extension-dispatch',
      'current-arm64-a2-denominator-inventory',
    ]),
  });
  return validated;
}
