import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { arm64MachineEffectFamilies } from '../../../js/targets/architecture/arm64/effects/index.js';
import {
  arm64eMachineEffectFamilies,
  arm64ePointerAuthenticationMnemonics,
} from '../../../js/targets/architecture/arm64e/effects.js';
import {
  RISCV64_DECODED_INSTRUCTION_CONTRACT_VERSION,
  RISCV64_DECODER_SEMANTIC_VERSION,
} from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { x86MachineEffectFamilies } from '../../../js/targets/architecture/x86_64/effects/index.js';
import {
  X86_DECODED_INSTRUCTION_CONTRACT_VERSION,
  X86_DECODER_SEMANTIC_VERSION,
} from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { riscv64MachineEffectFamilies } from '../../../js/targets/architecture/riscv64/effects/index.js';
import {
  RV64IMC_DECODER_DENOMINATOR_ID,
  RV64IMC_DECODER_DENOMINATOR_SCHEMA,
  RV64IMC_32BIT_OUT_OF_PROFILE_NEGATIVES,
  validateRv64imcDecoderDenominator,
} from './riscv64-rv64imc-denominator.mjs';
import { validateArm64A64ControlDenominator } from './arm64-a64-control-denominator.mjs';
import { validateArm64A64FlagsDenominator } from './arm64-a64-flags-denominator.mjs';
import { validateArm64A64FpDenominator } from './arm64-a64-fp-denominator.mjs';
import { validateArm64A64SystemDenominator } from './arm64-a64-system-denominator.mjs';
import {
  ARM64_A64_SIMD_DENOMINATOR_ID,
  ARM64_A64_SIMD_DENOMINATOR_SCHEMA,
  arm64A64SimdDecoderDependencyProof,
  validateArm64A64SimdDenominator,
} from './arm64-a64-simd-denominator.mjs';
import {
  ARM64_A64_MEMORY_DENOMINATOR_ID,
  ARM64_A64_MEMORY_DENOMINATOR_SCHEMA,
  arm64A64MemoryDecoderDependencyProof,
  validateArm64A64MemoryDenominator,
} from './arm64-a64-memory-denominator.mjs';
import { ARM64_A64_DECODER_AUDIT_LOCK, arm64A64DecoderDenominatorFromLockedAudit } from './arm64-a64-decoder-denominator.mjs';
import {
  ARM64E_A64_DELEGATION_DENOMINATOR_ID,
  ARM64E_A64_DELEGATION_DENOMINATOR_SCHEMA,
  validateArm64eA64DelegationDenominator,
} from './arm64e-a64-delegation-denominator.mjs';
import {
  ARM64_A64_INTEGER_DENOMINATOR_ID,
  ARM64_A64_INTEGER_DENOMINATOR_SCHEMA,
  validateArm64A64IntegerDenominator,
} from './arm64-a64-integer-denominator.mjs';
import {
  ARM64E_PAC_DENOMINATOR_ID,
  ARM64E_PAC_DENOMINATOR_SCHEMA,
  validateArm64ePacDenominator,
} from './arm64e-pac-denominator.mjs';
import {
  X86_LONG64_DECODER_DENOMINATOR_ID,
  X86_LONG64_DECODER_DENOMINATOR_SCHEMA,
  x86Long64DecoderDenominatorIdentity,
} from './x86-long64-decoder-denominator.mjs';
import {
  X86_LONG64_CONTROL_DENOMINATOR_ID,
  X86_LONG64_CONTROL_DENOMINATOR_SCHEMA,
  x86Long64ControlDenominatorIdentity,
} from './x86-long64-control-denominator.mjs';
import {
  X86_LONG64_INTEGER_DENOMINATOR_ID,
  X86_LONG64_INTEGER_DENOMINATOR_SCHEMA,
  validateX86Long64IntegerDenominator,
} from './x86-long64-integer-denominator.mjs';
import {
  X86_LONG64_STRING_DENOMINATOR_ID,
  X86_LONG64_STRING_DENOMINATOR_SCHEMA,
  x86Long64StringDenominatorIdentity,
} from './x86-long64-string-denominator.mjs';
import {
  X86_LONG64_ATOMIC_DENOMINATOR_ID,
  X86_LONG64_ATOMIC_DENOMINATOR_SCHEMA,
  x86Long64AtomicDenominatorIdentity,
} from './x86-long64-atomic-denominator.mjs';
import {
  X86_LONG64_MEMORY_DENOMINATOR_ID,
  X86_LONG64_MEMORY_DENOMINATOR_SCHEMA,
  x86Long64MemoryDenominatorIdentity,
} from './x86-long64-memory-denominator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
export const DEFAULT_A2_DENOMINATOR_PATH = path.join(ROOT, 'tests/machine-effects/a2-denominator-inventory.json');
export const A2_DENOMINATOR_SCHEMA = 'machine-effects-a2-denominator/v1';
const STAGE2_BASELINE_COMMIT = '3f3778e5f2bef638456da19609d616d71a3daedc';

const REGISTRIES = Object.freeze({
  arm64: Object.freeze({ families: arm64MachineEffectFamilies, pac: null, profileId: 'arm64:a64', source: 'js/targets/architecture/arm64/effects/index.js', exportName: 'arm64MachineEffectFamilies', decoderContractVersion: null, decoderSemanticVersion: null }),
  arm64e: Object.freeze({ families: arm64eMachineEffectFamilies, pac: arm64ePointerAuthenticationMnemonics, profileId: 'arm64e:a64+pac', source: 'js/targets/architecture/arm64e/effects.js', exportName: 'arm64eMachineEffectFamilies', decoderContractVersion: null, decoderSemanticVersion: null }),
  x86_64: Object.freeze({ families: x86MachineEffectFamilies, pac: null, profileId: 'x86_64:long-64', source: 'js/targets/architecture/x86_64/effects/index.js', exportName: 'x86MachineEffectFamilies', decoderContractVersion: X86_DECODED_INSTRUCTION_CONTRACT_VERSION, decoderSemanticVersion: X86_DECODER_SEMANTIC_VERSION }),
  riscv64: Object.freeze({ families: riscv64MachineEffectFamilies, pac: null, profileId: 'riscv64:rv64imc', source: 'js/targets/architecture/riscv64/effects/index.js', exportName: 'riscv64MachineEffectFamilies', decoderContractVersion: RISCV64_DECODED_INSTRUCTION_CONTRACT_VERSION, decoderSemanticVersion: RISCV64_DECODER_SEMANTIC_VERSION }),
});

function fail(code, detail = '') {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function sorted(values) {
  return [...values].map(String).sort();
}

function sameSet(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function sameList(actual, expected) {
  return JSON.stringify(actual.map(String)) === JSON.stringify(expected.map(String));
}

function assertString(value, code, detail) {
  if (typeof value !== 'string' || value.trim() === '') fail(code, detail);
}

function validateNormativeExclusion(unit, pathName) {
  const proof = unit.normativeExclusion;
  if (proof == null) return false;
  if (unit.id === 'pac-missing-structured-operands') {
    if (unit.status !== 'excluded' || unit.coverage !== 'partial' || unit.preexisting !== true
      || proof.schemaVersion !== 'machine-effects-preexisting-normative-exclusion/v1'
      || proof.classification !== 'PREEXISTING_NORMATIVE_EXCLUSION'
      || proof.baselineCommit !== STAGE2_BASELINE_COMMIT
      || proof.baselineRef !== 'js/targets/architecture/arm64e/effects.js'
      || proof.baselineBlob !== '56a7b2bb6fa34d2d4206f5b463770e6f2726efbc'
      || proof.scope !== 'malformed-operands-outside-validated-pac-decoder-denominator'
      || proof.currentProofSource !== 'tools/validation/machine-effects/arm64e-pac-denominator.mjs'
      || proof.currentProofTest !== 'tests/machine-effects/arm64e-pac-denominator.test.mjs') {
      fail('a2-denominator-arm64e-malformed-exclusion-drift', pathName);
    }
    const baselineBlob = spawnSync('git', ['rev-parse', `${STAGE2_BASELINE_COMMIT}:${proof.baselineRef}`], { cwd:ROOT, encoding:'utf8' });
    if (baselineBlob.status !== 0 || baselineBlob.stdout.trim() !== proof.baselineBlob) fail('a2-denominator-arm64e-malformed-exclusion-baseline-unresolved', pathName);
    return true;
  }
  if (unit.id !== 'fence.i' || unit.status !== 'excluded' || unit.coverage !== 'unsupported' || unit.preexisting !== true) {
    fail('a2-denominator-normative-exclusion-unit-invalid', `${pathName}:${unit.id}`);
  }
  if (!proof || proof.schemaVersion !== 'machine-effects-preexisting-normative-exclusion/v1'
    || proof.classification !== 'PREEXISTING_NORMATIVE_EXCLUSION') {
    fail('a2-denominator-normative-exclusion-proof-invalid', `${pathName}:${unit.id}`);
  }
  if (proof.baselineCommit !== STAGE2_BASELINE_COMMIT
    || proof.baselineRef !== 'tools/validation/phase6/profile.json'
    || proof.baselineBlob !== '7f8e893d4645a20a7be309f071d1b3a18653b5d1') {
    fail('a2-denominator-normative-exclusion-baseline-drift', `${pathName}:${unit.id}`);
  }
  const baselineBlob = spawnSync('git', ['rev-parse', `${STAGE2_BASELINE_COMMIT}:${proof.baselineRef}`], { cwd: ROOT, encoding: 'utf8' });
  if (baselineBlob.status !== 0 || baselineBlob.stdout.trim() !== proof.baselineBlob) {
    fail('a2-denominator-normative-exclusion-baseline-unresolved', `${pathName}:${unit.id}`);
  }
  const baseline = spawnSync('git', ['show', `${STAGE2_BASELINE_COMMIT}:${proof.baselineRef}`], { cwd: ROOT, encoding: 'utf8' });
  if (baseline.status !== 0) fail('a2-denominator-normative-exclusion-baseline-unresolved', `${pathName}:${unit.id}`);
  let profile;
  try { profile = JSON.parse(baseline.stdout); } catch { fail('a2-denominator-normative-exclusion-baseline-invalid', `${pathName}:${unit.id}`); }
  if (profile.isaProfile?.id !== 'rv64imc'
    || JSON.stringify(profile.isaProfile?.standardExtensions) !== JSON.stringify(['M', 'C'])
    || proof.excludedExtension !== 'Zifencei') {
    fail('a2-denominator-normative-exclusion-scope-drift', `${pathName}:${unit.id}`);
  }
  if (proof.currentProofSource !== 'tools/validation/machine-effects/riscv64-rv64imc-denominator.mjs'
    || proof.currentProofTest !== 'tests/machine-effects/riscv64-rv64imc-denominator.test.mjs') {
    fail('a2-denominator-normative-exclusion-current-proof-drift', `${pathName}:${unit.id}`);
  }
  const negative = RV64IMC_32BIT_OUT_OF_PROFILE_NEGATIVES.find((item) => item.id === 'zifencei-extension');
  if (!negative || negative.word !== 0x0000100f || negative.reason !== 'riscv64-zifencei-outside-phase6-profile') {
    fail('a2-denominator-normative-exclusion-negative-proof-invalid', `${pathName}:${unit.id}`);
  }
  return true;
}

function validateStatus(unit, pathName) {
  if (!unit || typeof unit !== 'object') fail('a2-denominator-unit-invalid', pathName);
  assertString(unit.id, 'a2-denominator-unit-id-required', pathName);
  if (!['exact', 'excluded'].includes(unit.status)) fail('a2-denominator-unit-status-invalid', `${pathName}:${unit.id}`);
  if (unit.status === 'exact') {
    if (!['exact', 'exact-with-intrinsic'].includes(unit.coverage)) fail('a2-denominator-exact-coverage-invalid', `${pathName}:${unit.id}`);
    assertString(unit.oracle, 'a2-denominator-exact-oracle-required', `${pathName}:${unit.id}`);
    if (unit.preexisting !== true) {
      const proof = unit.proof;
      if (!proof || proof.schemaVersion !== 'machine-effects-effect-unit-proof/v1') {
        fail('a2-denominator-exact-current-proof-required', `${pathName}:${unit.id}`);
      }
      for (const [field, expectedPrefix] of [
        ['source', 'js/targets/architecture/'],
        ['test', 'tests/'],
        ['denominatorTest', 'tests/machine-effects/'],
      ]) {
        if (typeof proof[field] !== 'string' || !proof[field].startsWith(expectedPrefix)) {
          fail('a2-denominator-exact-current-proof-ref-invalid', `${pathName}:${unit.id}:${field}`);
        }
        const resolved = path.resolve(ROOT, proof[field]);
        if (!resolved.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          fail('a2-denominator-exact-current-proof-ref-missing', `${pathName}:${unit.id}:${field}`);
        }
      }
    }
  } else {
    if (!['partial', 'unknown', 'unsupported'].includes(unit.coverage)) fail('a2-denominator-exclusion-coverage-invalid', `${pathName}:${unit.id}`);
    if (unit.preexisting !== true) fail('a2-denominator-exclusion-must-be-preexisting', `${pathName}:${unit.id}`);
    assertString(unit.reason, 'a2-denominator-exclusion-reason-required', `${pathName}:${unit.id}`);
  }
  validateNormativeExclusion(unit, pathName);
  if (unit.subunits != null) {
    if (!Array.isArray(unit.subunits) || unit.subunits.length === 0) fail('a2-denominator-subunits-required', `${pathName}:${unit.id}`);
    const ids = new Set();
    for (const subunit of unit.subunits) {
      validateStatus(subunit, `${pathName}:${unit.id}:subunit`);
      if (ids.has(subunit.id)) fail('a2-denominator-subunit-duplicate', `${pathName}:${unit.id}:${subunit.id}`);
      ids.add(subunit.id);
    }
  }
}

function validateArm64FamilyProof(unit, expected, live, pathName) {
  if (!unit || unit.status !== 'exact' || unit.coverage !== (expected.coverage || 'exact') || unit.preexisting !== false
    || unit.oracle !== expected.oracle
    || unit.proof?.schemaVersion !== 'machine-effects-effect-unit-proof/v1'
    || unit.proof?.source !== expected.source
    || unit.proof?.test !== expected.test
    || unit.proof?.denominatorTest !== expected.denominatorTest) {
    fail(`a2-denominator-arm64-${expected.id}-proof-identity-drift`, pathName);
  }
  const proof = unit.proof.denominator;
  for (const field of ['schemaVersion','denominatorId','profileId','encodingFamilyCount','encodingCaseCount',...(expected.cardinalityFields || [])]) {
    if (proof?.[field] !== live[field]) fail(`a2-denominator-arm64-${expected.id}-proof-denominator-drift`, `${pathName}:${field}`);
  }
  if (!sameSet(proof.oracleIds || [], live.oracleIds)) fail(`a2-denominator-arm64-${expected.id}-proof-denominator-drift`, `${pathName}:oracleIds`);
}

function collectStatusGaps(unit, prefix, { exempt = false } = {}) {
  if (!unit || typeof unit !== 'object') return [];
  const pathName = `${prefix}:${unit.id}`;
  const gaps = [];
  if (!exempt && unit.status !== 'exact' && unit.normativeExclusion == null) gaps.push(pathName);
  for (const subunit of unit.subunits || []) {
    // Keep nested unit identities aligned with the canonical profile lock,
    // which treats subunits as a path extension of their parent family.
    gaps.push(...collectStatusGaps(subunit, pathName));
  }
  return gaps;
}

// The unmatched-family fallback can never be exact: it exists precisely to
// return null. It stops being a blocking gap only when the architecture's
// decoder denominator proves no valid in-profile encoding can reach it. Without
// that negative proof the fallback stays an open gap, because an unowned valid
// encoding would otherwise disappear into it unnoticed.
function fallbackNegativeProven(architecture) {
  if (architecture.decoder?.enumerationStatus !== 'exact') return false;
  if (architecture.id === 'riscv64') return architecture.decoder.missingUnits.length === 0;
  if (architecture.id === 'arm64') return arm64A64DecoderTerminal().fallbackNegativeProof === true;
  if (architecture.id === 'arm64e') return validateArm64eA64DelegationDenominator().terminalEligible === true;
  if (architecture.id === 'x86_64') return architecture.decoder.missingUnits.length === 0;
  return false;
}

function validateX86ExactDecoder(decoder, pathName) {
  const proof = decoder.denominator;
  if (!proof || typeof proof !== 'object') fail('a2-denominator-exact-decoder-proof-required', pathName);
  const live = x86Long64DecoderDenominatorIdentity();
  if (proof.schemaVersion !== X86_LONG64_DECODER_DENOMINATOR_SCHEMA || proof.schemaVersion !== live.schemaVersion) {
    fail('a2-denominator-exact-decoder-proof-schema-drift', pathName);
  }
  if (proof.denominatorId !== X86_LONG64_DECODER_DENOMINATOR_ID || proof.denominatorId !== live.denominatorId) {
    fail('a2-denominator-exact-decoder-proof-identity-drift', pathName);
  }
  if (proof.source !== 'tools/validation/machine-effects/x86-long64-decoder-denominator.mjs') {
    fail('a2-denominator-exact-decoder-proof-source-drift', pathName);
  }
  if (proof.test !== 'tests/machine-effects/x86-long64-decoder-denominator.test.mjs') {
    fail('a2-denominator-exact-decoder-proof-test-drift', pathName);
  }
  for (const field of [
    'registryInstructionCount', 'validLong64InstructionIdCount', 'explicitOutOfProfileRegistryIdCount',
    'modeInvalidOrRepurposedCount', 'prefixTokenCount', 'nonemittingAliasCount',
    'witnessFixtureVersion', 'witnessSha256',
  ]) {
    if (proof[field] !== live[field]) fail('a2-denominator-exact-decoder-proof-count-drift', `${pathName}:${field}`);
  }
  if (!sameSet(proof.oracleIds || [], live.oracleIds)) fail('a2-denominator-exact-decoder-proof-oracle-drift', pathName);
}

function validateArm64ExactDecoder(decoder, pathName) {
  const proof = decoder.denominator;
  if (!proof || typeof proof !== 'object') fail('a2-denominator-exact-decoder-proof-required', pathName);
  const live = arm64A64DecoderTerminal();
  // An exact A64 decoder unit is only publishable when the ownership audit and
  // both family dependency contracts hold at the same time. Anything less has to
  // stay an explicit missing unit.
  if (live.terminalEligible !== true) fail('a2-denominator-arm64-decoder-not-terminal', `${pathName}:${JSON.stringify(live.missingDependencies)}`);
  if (live.validEncodingOwnershipProof !== true || live.fallbackNegativeProof !== true) {
    fail('a2-denominator-arm64-decoder-ownership-proof-missing', pathName);
  }
  if (proof.source !== 'tools/validation/machine-effects/arm64-a64-decoder-denominator.mjs'
    || proof.test !== 'tests/machine-effects/arm64-a64-decoder-denominator.test.mjs') {
    fail('a2-denominator-arm64-decoder-proof-ref-drift', pathName);
  }
  for (const field of ['schemaVersion','denominatorId','profileId','architectureProfileId','denominatorAuthority','decoderIdentityId','architectureSemanticVersion']) {
    if (proof[field] !== live[field]) fail('a2-denominator-arm64-decoder-proof-identity-drift', `${pathName}:${field}`);
  }
  for (const field of ['candidateCaseCount','candidateUniqueWordCount','candidateSha256','candidateUniqueWordsSha256']) {
    if (proof[field] !== live.candidateCorpus[field]) fail('a2-denominator-arm64-decoder-proof-corpus-drift', `${pathName}:${field}`);
  }
  if (proof.decoderAuditSha256 !== ARM64_A64_DECODER_AUDIT_LOCK.decoderAuditSha256) {
    fail('a2-denominator-arm64-decoder-proof-audit-drift', pathName);
  }
  if (!sameList(proof.dependencyFamilies || [], live.requiredCanonicalFamilies.filter((family) => ['memory','simd'].includes(family)))) {
    fail('a2-denominator-arm64-decoder-proof-dependency-drift', pathName);
  }
}

function validateArm64eExactDecoder(decoder, pathName) {
  const proof = decoder.delegation;
  if (!proof || typeof proof !== 'object') fail('a2-denominator-arm64e-delegation-proof-required', pathName);
  const live = validateArm64eA64DelegationDenominator();
  // The delegated baseline is only exact while the ARM64 baseline it delegates
  // to is itself terminal. It has no independent coverage of its own to fall
  // back on.
  if (live.terminalEligible !== true) {
    fail('a2-denominator-arm64e-delegation-not-terminal', `${pathName}:${JSON.stringify(live.dependency?.blockingUnits || [])}`);
  }
  if (proof.source !== 'tools/validation/machine-effects/arm64e-a64-delegation-denominator.mjs'
    || proof.test !== 'tests/machine-effects/arm64e-a64-delegation-denominator.test.mjs') {
    fail('a2-denominator-arm64e-delegation-proof-ref-drift', pathName);
  }
  if (proof.schemaVersion !== ARM64E_A64_DELEGATION_DENOMINATOR_SCHEMA || proof.schemaVersion !== live.schemaVersion
    || proof.denominatorId !== ARM64E_A64_DELEGATION_DENOMINATOR_ID || proof.denominatorId !== live.denominatorId) {
    fail('a2-denominator-arm64e-delegation-proof-identity-drift', pathName);
  }
  for (const field of ['profileId','delegationMechanismStatus','terminalStatus','fallbackDisposition']) {
    if (proof[field] !== live[field]) fail('a2-denominator-arm64e-delegation-proof-identity-drift', `${pathName}:${field}`);
  }
  for (const field of [
    'pacEncodingCaseCount','pacMnemonicCount','knownBaselineEncodingCaseCount',
    'strictBaselineDisjointEncodingCaseCount','baselineFeatureAliasOverlapCount',
    'positiveDelegationSampleCount','pacDispatchOwnerCount',
  ]) {
    if (proof[field] !== live[field]) fail('a2-denominator-arm64e-delegation-proof-count-drift', `${pathName}:${field}`);
  }
  if (!sameList(proof.units || [], live.units)) fail('a2-denominator-arm64e-delegation-proof-unit-drift', pathName);
}

// Terminal state of the A64 decoder ownership denominator on the current tree,
// composed from the locked (and separately live-proven) candidate audit plus the
// two real family dependency contracts.
let arm64DecoderTerminalCache = null;
function arm64A64DecoderTerminal() {
  if (arm64DecoderTerminalCache == null) {
    arm64DecoderTerminalCache = arm64A64DecoderDenominatorFromLockedAudit({
      memory:arm64A64MemoryDecoderDependencyProof(),
      simd:arm64A64SimdDecoderDependencyProof(),
    });
  }
  return arm64DecoderTerminalCache;
}

function validateDecoder(architecture, pathName) {
  const decoder = architecture.decoder;
  if (!decoder || typeof decoder !== 'object') fail('a2-denominator-decoder-required', pathName);
  assertString(decoder.provider, 'a2-denominator-decoder-provider-required', pathName);
  assertString(decoder.contract, 'a2-denominator-decoder-contract-required', pathName);
  if (!['exact', 'excluded'].includes(decoder.enumerationStatus)) fail('a2-denominator-decoder-status-invalid', pathName);
  if (!Array.isArray(decoder.missingUnits)) fail('a2-denominator-decoder-missing-units-invalid', pathName);
  const denominatorUnits = decoder.units == null ? decoder.missingUnits : decoder.units;
  if (!Array.isArray(denominatorUnits) || denominatorUnits.length === 0) fail('a2-denominator-decoder-units-required', pathName);
  if (new Set(denominatorUnits).size !== denominatorUnits.length) fail('a2-denominator-decoder-units-duplicate', pathName);
  if (!denominatorUnits.every((unit) => typeof unit === 'string' && unit.startsWith(`${architecture.profileId}:`))) {
    fail('a2-denominator-decoder-unit-profile-drift', pathName);
  }
  if (new Set(decoder.missingUnits).size !== decoder.missingUnits.length) fail('a2-denominator-decoder-missing-units-duplicate', pathName);
  if (!decoder.missingUnits.every((unit) => typeof unit === 'string' && unit.startsWith(`${architecture.profileId}:`))) {
    fail('a2-denominator-decoder-missing-unit-profile-drift', pathName);
  }
  if (decoder.enumerationStatus === 'excluded') {
    assertString(decoder.reason, 'a2-denominator-decoder-gap-reason-required', pathName);
    if (decoder.missingUnits.length === 0) fail('a2-denominator-decoder-missing-units-required', pathName);
    if (decoder.denominator != null) fail('a2-denominator-excluded-decoder-cannot-claim-proof', pathName);
    return;
  }
  if (decoder.missingUnits.length !== 0) fail('a2-denominator-exact-decoder-cannot-have-missing-units', pathName);
  const EXACT_DECODER_UNITS = Object.freeze({
    riscv64:Object.freeze(['riscv64:rv64imc:all-valid-32-bit-and-compressed-encodings']),
    arm64:Object.freeze(['arm64:a64:all-decoder-encodings-and-aliases']),
    arm64e:Object.freeze(['arm64e:a64+pac:all-a64-decoder-encodings-and-aliases','arm64e:a64+pac:all-pac-decoder-encodings-and-aliases']),
    x86_64:Object.freeze(['x86_64:long-64:all-decoder-encodings-prefixes-and-aliases']),
  });
  const expectedUnits = EXACT_DECODER_UNITS[architecture.id];
  if (!expectedUnits) fail('a2-denominator-exact-decoder-proof-unavailable', pathName);
  if (!sameSet(decoder.units, expectedUnits)) fail('a2-denominator-exact-decoder-unit-set-drift', pathName);
  if (architecture.id === 'arm64') return validateArm64ExactDecoder(decoder, pathName);
  if (architecture.id === 'arm64e') return validateArm64eExactDecoder(decoder, pathName);
  if (architecture.id === 'x86_64') return validateX86ExactDecoder(decoder, pathName);
  const proof = decoder.denominator;
  if (!proof || typeof proof !== 'object') fail('a2-denominator-exact-decoder-proof-required', pathName);
  const live = validateRv64imcDecoderDenominator();
  if (proof.schemaVersion !== RV64IMC_DECODER_DENOMINATOR_SCHEMA || proof.schemaVersion !== live.schemaVersion) {
    fail('a2-denominator-exact-decoder-proof-schema-drift', pathName);
  }
  if (proof.denominatorId !== RV64IMC_DECODER_DENOMINATOR_ID || proof.denominatorId !== live.denominatorId) {
    fail('a2-denominator-exact-decoder-proof-identity-drift', pathName);
  }
  if (proof.source !== 'tools/validation/machine-effects/riscv64-rv64imc-denominator.mjs') {
    fail('a2-denominator-exact-decoder-proof-source-drift', pathName);
  }
  if (proof.test !== 'tests/machine-effects/riscv64-rv64imc-denominator.test.mjs') {
    fail('a2-denominator-exact-decoder-proof-test-drift', pathName);
  }
  for (const field of ['encoding32FamilyCount', 'compressedFamilyCount', 'compressedWordCount', 'discriminatorTupleCount']) {
    if (proof[field] !== live[field]) fail('a2-denominator-exact-decoder-proof-count-drift', `${pathName}:${field}`);
  }
  if (!sameSet(proof.oracleIds || [], live.oracleIds)) fail('a2-denominator-exact-decoder-proof-oracle-drift', pathName);
}

export function loadA2DenominatorInventory(file = DEFAULT_A2_DENOMINATOR_PATH) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || parsed.schemaVersion !== A2_DENOMINATOR_SCHEMA) fail('a2-denominator-schema-mismatch');
  return parsed;
}

export function validateA2DenominatorInventory(inventory = loadA2DenominatorInventory()) {
  if (inventory.oracleRole !== 'production-effect-registry-denominator-with-explicit-profile-gaps') fail('a2-denominator-oracle-role-invalid');
  if (inventory.scope?.unitGranularity !== 'production-decoder-effect-family') fail('a2-denominator-granularity-invalid');
  if (inventory.scope?.fullIsaCoverageIncluded !== false) fail('a2-denominator-must-not-claim-full-isa');
  if (inventory.scope?.missingUnitPolicy !== 'blocking-and-explicit') fail('a2-denominator-missing-unit-policy-invalid');
  const expectedArchitectures = Object.keys(REGISTRIES);
  if (!sameSet(inventory.scope?.lockedProfiles, expectedArchitectures.map((id) => REGISTRIES[id].profileId))) fail('a2-denominator-profile-set-drift');
  if (!Array.isArray(inventory.architectures) || !sameSet(inventory.architectures.map((item) => item?.id), expectedArchitectures)) {
    fail('a2-denominator-architecture-set-drift');
  }

  for (const architecture of inventory.architectures) {
    const pathName = `architecture:${architecture.id}`;
    const live = REGISTRIES[architecture.id];
    if (!live) fail('a2-denominator-unknown-architecture', architecture.id);
    if (architecture.profileId !== live.profileId) fail('a2-denominator-profile-omission', `${pathName}:${architecture.profileId}`);
    validateDecoder(architecture, pathName);
    const plugin = architecturePluginV2(architecture.id);
    if (!plugin || plugin.id !== architecture.id) fail('a2-denominator-decoder-plugin-missing', pathName);
    if (architecture.decoder.provider !== plugin.decodeProvider) fail('a2-denominator-decoder-provider-drift', `${pathName}:${architecture.decoder.provider}`);
    if (architecture.decoder.contract !== plugin.capabilities.decode) fail('a2-denominator-decoder-contract-drift', `${pathName}:${architecture.decoder.contract}`);
    if (live.decoderContractVersion == null) {
      if ('contractVersion' in architecture.decoder || 'semanticVersion' in architecture.decoder) fail('a2-denominator-decoder-version-unexpected', pathName);
    } else {
      if (architecture.decoder.contractVersion !== live.decoderContractVersion) fail('a2-denominator-decoder-contract-version-drift', pathName);
      if (architecture.decoder.semanticVersion !== live.decoderSemanticVersion) fail('a2-denominator-decoder-semantic-version-drift', pathName);
    }
    const effectRegistry = architecture.effectRegistry;
    if (!effectRegistry || typeof effectRegistry !== 'object') fail('a2-denominator-effect-registry-required', pathName);
    if (effectRegistry.source !== live.source) fail('a2-denominator-effect-source-drift', `${pathName}:${effectRegistry.source}`);
    if (effectRegistry.export !== live.exportName) fail('a2-denominator-effect-export-drift', `${pathName}:${effectRegistry.export}`);
    const families = Array.isArray(effectRegistry.families) ? effectRegistry.families : null;
    if (!families || families.length === 0) fail('a2-denominator-effect-families-required', pathName);
    const familyIds = families.map((family) => family?.id);
    if (new Set(familyIds).size !== familyIds.length) fail('a2-denominator-family-duplicate', pathName);
    const liveFamilies = live.families();
    const declaredFamilies = familyIds.filter((id) => id !== 'fallback-unmatched-decoder-family');
    if (!sameList(declaredFamilies, liveFamilies)) fail('a2-denominator-effect-registry-drift', `${pathName}:${JSON.stringify({ declared:declaredFamilies, live:liveFamilies })}`);
    if (familyIds.at(-1) !== 'fallback-unmatched-decoder-family') fail('a2-denominator-fallback-must-be-last', pathName);
    for (const [index, family] of families.entries()) validateStatus(family, `${pathName}:family[${index}]`);

    const fallback = families.at(-1);
    if (fallback.status !== 'excluded' || fallback.coverage !== 'unsupported') fail('a2-denominator-fallback-must-be-unsupported', pathName);

    if (architecture.exclusions != null) {
      if (!Array.isArray(architecture.exclusions) || architecture.exclusions.length === 0) fail('a2-denominator-exclusions-invalid', pathName);
      const exclusionIds = new Set();
      for (const [index, exclusion] of architecture.exclusions.entries()) {
        validateStatus(exclusion, `${pathName}:exclusion[${index}]`);
        if (exclusionIds.has(exclusion.id)) fail('a2-denominator-exclusion-duplicate', `${pathName}:${exclusion.id}`);
        exclusionIds.add(exclusion.id);
      }
    }

    if (architecture.id === 'arm64') {
      const integer = families.find((family) => family.id === 'integer');
      const liveInteger = validateArm64A64IntegerDenominator();
      const proof = integer?.proof;
      const denominator = proof?.denominator;
      if (!integer || integer.status !== 'exact' || integer.coverage !== 'exact' || integer.preexisting !== false
        || integer.oracle !== 'arm-a-profile-a64-data-processing-encoding-tables + deployed-capstone-5-arm64 + llvm-mc-18-aarch64-disassembler'
        || proof?.schemaVersion !== 'machine-effects-effect-unit-proof/v1'
        || proof?.source !== 'js/targets/architecture/arm64/effects/integer.js'
        || proof?.test !== 'tests/machine-effects/arm64-int-arithmetic.test.mjs'
        || proof?.denominatorTest !== 'tests/machine-effects/arm64-a64-integer-denominator.test.mjs') {
        fail('a2-denominator-arm64-integer-proof-identity-drift', pathName);
      }
      if (!denominator || denominator.schemaVersion !== ARM64_A64_INTEGER_DENOMINATOR_SCHEMA
        || denominator.schemaVersion !== liveInteger.schemaVersion
        || denominator.denominatorId !== ARM64_A64_INTEGER_DENOMINATOR_ID
        || denominator.denominatorId !== liveInteger.denominatorId
        || denominator.source !== 'tools/validation/machine-effects/arm64-a64-integer-denominator.mjs'
        || denominator.encodingFamilyCount !== liveInteger.encodingFamilyCount
        || denominator.encodingCaseCount !== liveInteger.encodingCaseCount
        || denominator.mnemonicCount !== liveInteger.mnemonicCount
        || !sameSet(denominator.oracleIds || [],liveInteger.oracleIds)) {
        fail('a2-denominator-arm64-integer-live-proof-drift', pathName);
      }
    }
    if (architecture.id === 'arm64e') {
      const pac = architecture.pointerAuthenticationMnemonics;
      if (!Array.isArray(pac) || !sameSet(pac, live.pac())) fail('a2-denominator-pac-registry-drift');
      if (new Set(pac).size !== pac.length) fail('a2-denominator-pac-duplicate');
      const aliases = Array.isArray(architecture.aliases) ? architecture.aliases : [];
      const baseline = aliases.find((alias) => alias?.id === 'baseline-a64-delegation');
      if (!baseline || baseline.kind !== 'delegation' || baseline.sourceArchitecture !== 'arm64' || !baseline.reason) fail('a2-denominator-arm64e-baseline-alias-missing');
      const delegation = validateArm64eA64DelegationDenominator();
      // The delegated baseline alias tracks the ARM64 baseline exactly: exact
      // once that baseline is terminal, an explicit pre-existing exclusion while
      // it is not. It never gets to be exact on its own authority.
      if (delegation.terminalEligible === true) {
        if (baseline.status !== 'exact' || baseline.coverage !== 'exact-with-intrinsic' || baseline.preexisting !== false
          || baseline.proof?.schemaVersion !== 'machine-effects-effect-unit-proof/v1'
          || baseline.proof?.source !== 'js/targets/architecture/arm64e/effects.js'
          || baseline.proof?.test !== 'tests/machine-effects/arm64e-effects.test.mjs'
          || baseline.proof?.denominatorTest !== 'tests/machine-effects/arm64e-a64-delegation-denominator.test.mjs') {
          fail('a2-denominator-arm64e-baseline-alias-proof-drift');
        }
      } else if (baseline.status !== 'excluded' || baseline.preexisting !== true) {
        fail('a2-denominator-arm64e-baseline-alias-must-track-baseline');
      }
      const exclusion = architecture.exclusions?.find((item) => item?.id === 'pac-missing-structured-operands');
      if (!exclusion || exclusion.status !== 'excluded') fail('a2-denominator-pac-partial-exclusion-missing');
      const pacDenominator = architecture.decoder?.pacDenominator;
      const livePac = validateArm64ePacDenominator();
      if (!pacDenominator || pacDenominator.schemaVersion !== ARM64E_PAC_DENOMINATOR_SCHEMA
        || pacDenominator.denominatorId !== ARM64E_PAC_DENOMINATOR_ID
        || pacDenominator.source !== 'tools/validation/machine-effects/arm64e-pac-denominator.mjs'
        || pacDenominator.test !== 'tests/machine-effects/arm64e-pac-denominator.test.mjs'
        || pacDenominator.encodingFamilyCount !== livePac.encodingFamilyCount
        || pacDenominator.encodingCaseCount !== livePac.encodingCaseCount
        || pacDenominator.mnemonicCount !== livePac.mnemonicCount
        || !sameSet(pacDenominator.oracleIds || [],livePac.oracleIds)
        || architecture.decoder.missingUnits.includes('arm64e:a64+pac:all-pac-decoder-encodings-and-aliases')) {
        fail('a2-denominator-arm64e-pac-proof-drift', pathName);
      }
    }
    if (architecture.id === 'riscv64') {
      const system = families.find((family) => family.id === 'system');
      const environmentUnits = [system, ...(system?.subunits || []).filter((unit) => ['ecall', 'ebreak'].includes(unit.id))];
      if (environmentUnits.length !== 3) fail('a2-denominator-riscv64-environment-unit-set-drift');
      for (const unit of environmentUnits) {
        if (unit.status !== 'exact' || unit.coverage !== 'exact-with-intrinsic' || unit.preexisting !== false) {
          fail('a2-denominator-riscv64-environment-exactness-drift', unit.id);
        }
        if (unit.proof?.source !== 'js/targets/architecture/riscv64/effects/system.js'
          || unit.proof?.test !== 'tests/phase6/effects/control-memory.test.mjs'
          || unit.proof?.denominatorTest !== 'tests/machine-effects/riscv64-rv64imc-denominator.test.mjs') {
          fail('a2-denominator-riscv64-environment-proof-drift', unit.id);
        }
      }
    }
    if (architecture.id === 'x86_64') {
      const lea = families.find((family) => family.id === 'lea');
      if (!lea || lea.status !== 'exact' || lea.coverage !== 'exact' || lea.preexisting !== false
        || lea.oracle !== 'intel-sdm-vol2-lea-8d-r + deployed-capstone-5-x86-long64-detail'
        || lea.proof?.schemaVersion !== 'machine-effects-effect-unit-proof/v1'
        || lea.proof?.source !== 'js/targets/architecture/x86_64/effects/integer.js'
        || lea.proof?.test !== 'tests/phase5/effects/memory/addressing.test.mjs'
        || lea.proof?.denominatorTest !== 'tests/machine-effects/x86-long64-lea-denominator.test.mjs') {
        fail('a2-denominator-x86-lea-proof-identity-drift', pathName);
      }

      const control = families.find((family) => family.id === 'control');
      if (control && control.status === 'exact') {
        const liveControl = x86Long64ControlDenominatorIdentity();
        const controlProof = control.proof;
        const controlDenominator = controlProof?.denominator;
        if (control.coverage !== 'exact' || control.preexisting !== false
          || control.oracle !== 'intel-sdm-vol2-call-ret-jmp-jcc-loop-jcxz + deployed-capstone-5-x86-long64-detail'
          || controlProof?.schemaVersion !== 'machine-effects-effect-unit-proof/v1'
          || controlProof?.source !== 'js/targets/architecture/x86_64/effects/control.js'
          || controlProof?.test !== 'tests/phase5/effects/int-control/control.test.mjs'
          || controlProof?.denominatorTest !== 'tests/machine-effects/x86-long64-control-denominator.test.mjs') {
          fail('a2-denominator-x86-control-proof-identity-drift', pathName);
        }
        if (!controlDenominator || controlDenominator.schemaVersion !== X86_LONG64_CONTROL_DENOMINATOR_SCHEMA
          || controlDenominator.denominatorId !== X86_LONG64_CONTROL_DENOMINATOR_ID
          || controlDenominator.profileId !== liveControl.profileId
          || controlDenominator.encodingCaseCount !== liveControl.encodingCaseCount
          || controlDenominator.conditionCount !== liveControl.conditionCount
          || controlDenominator.aliasCaseCount !== liveControl.aliasCaseCount
          || !sameSet(controlDenominator.oracleIds || [], liveControl.oracleIds)) {
          fail('a2-denominator-x86-control-live-proof-drift', pathName);
        }
      }

      const integer = families.find((family) => family.id === 'integer');
      if (integer && integer.status === 'exact') {
        const liveInteger = validateX86Long64IntegerDenominator();
        const integerProof = integer.proof;
        const integerDenominator = integerProof?.denominator;
        if (integer.coverage !== 'exact' || integer.preexisting !== false
          || integer.oracle !== 'intel-sdm-vol2-general-purpose-instructions + deployed-capstone-5-x86-long64-detail'
          || integerProof?.schemaVersion !== 'machine-effects-effect-unit-proof/v1'
          || integerProof?.source !== 'js/targets/architecture/x86_64/effects/integer.js'
          || integerProof?.test !== 'tests/phase5/effects/int-control/integer-flags.test.mjs'
          || integerProof?.denominatorTest !== 'tests/machine-effects/x86-long64-integer-denominator.test.mjs') {
          fail('a2-denominator-x86-integer-proof-identity-drift', pathName);
        }
        if (!integerDenominator || integerDenominator.schemaVersion !== X86_LONG64_INTEGER_DENOMINATOR_SCHEMA
          || integerDenominator.denominatorId !== X86_LONG64_INTEGER_DENOMINATOR_ID
          || integerDenominator.encodingCaseCount !== liveInteger.encodingCaseCount
          || integerDenominator.integerOwnedCaseCount !== liveInteger.integerOwnedCaseCount
          || integerDenominator.memoryDelegationCaseCount !== liveInteger.memoryDelegationCaseCount
          || !sameList(integerDenominator.operandWidths || [], liveInteger.operandWidths)
          || !sameSet(integerDenominator.oracleIds || [], liveInteger.oracleIds)) {
          fail('a2-denominator-x86-integer-live-proof-drift', pathName);
        }
      }

      const stringFamily = families.find((family) => family.id === 'string');
      if (stringFamily && stringFamily.status === 'exact') {
        const liveString = x86Long64StringDenominatorIdentity();
        const stringProof = stringFamily.proof;
        const stringDenominator = stringProof?.denominator;
        if (stringFamily.coverage !== 'exact-with-intrinsic' || stringFamily.preexisting !== false
          || stringFamily.oracle !== 'intel-sdm-string-operation-semantics + deployed-capstone-5-x86-long64-detail + x86-repeated-string-summary/v1'
          || stringProof?.schemaVersion !== 'machine-effects-effect-unit-proof/v1'
          || stringProof?.source !== 'js/targets/architecture/x86_64/effects/string.js'
          || stringProof?.test !== 'tests/phase5/effects/memory/string.test.mjs'
          || stringProof?.denominatorTest !== 'tests/machine-effects/x86-long64-string-denominator.test.mjs') {
          fail('a2-denominator-x86-string-proof-identity-drift', pathName);
        }
        if (!stringDenominator || stringDenominator.schemaVersion !== X86_LONG64_STRING_DENOMINATOR_SCHEMA
          || stringDenominator.denominatorId !== X86_LONG64_STRING_DENOMINATOR_ID
          || stringDenominator.operationCount !== liveString.operationCount
          || stringDenominator.elementWidthCount !== liveString.elementWidthCount
          || stringDenominator.addressSizeCount !== liveString.addressSizeCount
          || stringDenominator.sourceSegmentDiscriminatorCount !== liveString.sourceSegmentDiscriminatorCount
          || stringDenominator.nonCompareRepeatCount !== liveString.nonCompareRepeatCount
          || stringDenominator.compareRepeatCount !== liveString.compareRepeatCount
          || stringDenominator.semanticCaseCount !== liveString.semanticCaseCount
          || !sameSet(stringDenominator.oracleIds || [], liveString.oracleIds)) {
          fail('a2-denominator-x86-string-live-proof-drift', pathName);
        }
      }

      const atomic = families.find((family) => family.id === 'atomic');
      if (atomic && atomic.status === 'exact') {
        const liveAtomic = x86Long64AtomicDenominatorIdentity();
        const atomicProof = atomic.proof;
        const atomicDenominator = atomicProof?.denominator;
        if (atomic.coverage !== 'exact-with-intrinsic' || atomic.preexisting !== false
          || atomic.oracle !== 'intel-sdm-vol2-cmpxchg-xadd-xchg-current + intel-sdm-vol3-locked-instruction-ordering-current + amd64-vol3-general-purpose-programming-current + deployed-capstone-5-x86-long64-structured-detail'
          || atomicProof?.schemaVersion !== 'machine-effects-effect-unit-proof/v1'
          || atomicProof?.source !== 'js/targets/architecture/x86_64/effects/atomic.js'
          || atomicProof?.test !== 'tests/phase5/effects/memory/atomic.test.mjs'
          || atomicProof?.denominatorTest !== 'tests/machine-effects/x86-long64-atomic-denominator.test.mjs') {
          fail('a2-denominator-x86-atomic-proof-identity-drift', pathName);
        }
        if (!atomicDenominator || atomicDenominator.schemaVersion !== X86_LONG64_ATOMIC_DENOMINATOR_SCHEMA
          || atomicDenominator.denominatorId !== X86_LONG64_ATOMIC_DENOMINATOR_ID
          || atomicDenominator.semanticCaseCount !== liveAtomic.semanticCaseCount
          || atomicDenominator.familyCount !== liveAtomic.familyCount
          || !sameList(atomicDenominator.scalarWidths || [], liveAtomic.scalarWidths)
          || !sameSet(atomicDenominator.oracleIds || [], liveAtomic.oracleIds)) {
          fail('a2-denominator-x86-atomic-live-proof-drift', pathName);
        }
      }

      const memory = families.find((family) => family.id === 'memory');
      if (memory && memory.status === 'exact') {
        const liveMemory = x86Long64MemoryDenominatorIdentity();
        const memoryProof = memory.proof;
        const memoryDenominator = memoryProof?.denominator;
        if (memory.coverage !== 'exact-with-intrinsic' || memory.preexisting !== false
          || memory.oracle !== 'intel-sdm-vol2-memory-instruction-reference + deployed-capstone-5-x86-long64-detail'
          || memoryProof?.schemaVersion !== 'machine-effects-effect-unit-proof/v1'
          || memoryProof?.source !== 'js/targets/architecture/x86_64/effects/memory.js'
          || memoryProof?.test !== 'tests/phase5/effects/memory/memory.test.mjs'
          || memoryProof?.denominatorTest !== 'tests/machine-effects/x86-long64-memory-denominator.test.mjs') {
          fail('a2-denominator-x86-memory-proof-identity-drift', pathName);
        }
        if (!memoryDenominator || memoryDenominator.schemaVersion !== X86_LONG64_MEMORY_DENOMINATOR_SCHEMA
          || memoryDenominator.denominatorId !== X86_LONG64_MEMORY_DENOMINATOR_ID
          || memoryDenominator.addressEncodingCaseCount !== liveMemory.addressEncodingCaseCount
          || memoryDenominator.semanticCaseCount !== liveMemory.semanticCaseCount
          || memoryDenominator.moffsCaseCount !== liveMemory.moffsCaseCount
          || memoryDenominator.owner !== liveMemory.owner
          || !sameSet(memoryDenominator.oracleIds || [], liveMemory.independentOracleIds)) {
          fail('a2-denominator-x86-memory-live-proof-drift', pathName);
        }
      }
    }
    if (architecture.id === 'arm64') {
      // Advanced SIMD is proved by an independent finite case corpus rather than
      // an encoding-family sweep, so its live proof is checked against that
      // corpus's own identity, cardinality, and digest instead of the shared
      // encoding-family shape.
      const simd = families.find((family) => family.id === 'simd');
      const liveSimd = validateArm64A64SimdDenominator();
      const simdProof = simd?.proof;
      const simdDenominator = simdProof?.denominator;
      if (!simd || simd.status !== 'exact' || simd.coverage !== 'exact-with-intrinsic' || simd.preexisting !== false
        || simd.oracle !== 'arm-a64-advanced-simd-encoding-tables + llvm-mc-aarch64-advanced-simd + deployed-capstone-arm64-a64'
        || simdProof?.schemaVersion !== 'machine-effects-effect-unit-proof/v1'
        || simdProof?.source !== 'js/targets/architecture/arm64/effects/simd.js'
        || simdProof?.test !== 'tests/machine-effects/arm64-simd-core.test.mjs'
        || simdProof?.denominatorTest !== 'tests/machine-effects/arm64-a64-simd-denominator.test.mjs') {
        fail('a2-denominator-arm64-simd-proof-identity-drift', pathName);
      }
      if (!simdDenominator || simdDenominator.schemaVersion !== ARM64_A64_SIMD_DENOMINATOR_SCHEMA
        || simdDenominator.schemaVersion !== liveSimd.schemaVersion
        || simdDenominator.denominatorId !== ARM64_A64_SIMD_DENOMINATOR_ID
        || simdDenominator.denominatorId !== liveSimd.denominatorId
        || simdDenominator.profileId !== liveSimd.profileId
        || simdDenominator.source !== 'tools/validation/machine-effects/arm64-a64-simd-denominator.mjs'
        || simdDenominator.mnemonicCount !== liveSimd.mnemonicCount
        || simdDenominator.caseCount !== liveSimd.caseCount
        || simdDenominator.formCount !== liveSimd.formCount
        || simdDenominator.aliasBindingCount !== liveSimd.aliasBindingCount
        || simdDenominator.corpusSha256 !== liveSimd.corpusSha256
        || !sameSet(simdDenominator.oracleIds || [], liveSimd.oracleIds)) {
        fail('a2-denominator-arm64-simd-live-proof-drift', pathName);
      }
      // Memory is proved the same way as SIMD: an independent finite case corpus
      // with its own digest, not a shared encoding-family sweep.
      const memory = families.find((family) => family.id === 'memory');
      const liveMemory = validateArm64A64MemoryDenominator();
      const memoryProof = memory?.proof;
      const memoryDenominator = memoryProof?.denominator;
      if (!memory || memory.status !== 'exact' || memory.coverage !== 'exact-with-intrinsic' || memory.preexisting !== false
        || memory.oracle !== 'arm-a-profile-a64-load-store-encoding-tables + deployed-capstone-5-arm64 + llvm-aarch64-integrated-assembler-disassembler'
        || memoryProof?.schemaVersion !== 'machine-effects-effect-unit-proof/v1'
        || memoryProof?.source !== 'js/targets/architecture/arm64/effects/memory.js'
        || memoryProof?.test !== 'tests/machine-effects/arm64-memory-addressing.test.mjs'
        || memoryProof?.denominatorTest !== 'tests/machine-effects/arm64-a64-memory-denominator.test.mjs') {
        fail('a2-denominator-arm64-memory-proof-identity-drift', pathName);
      }
      if (!memoryDenominator || memoryDenominator.schemaVersion !== ARM64_A64_MEMORY_DENOMINATOR_SCHEMA
        || memoryDenominator.schemaVersion !== liveMemory.schemaVersion
        || memoryDenominator.denominatorId !== ARM64_A64_MEMORY_DENOMINATOR_ID
        || memoryDenominator.denominatorId !== liveMemory.denominatorId
        || memoryDenominator.profileId !== liveMemory.profileId
        || memoryDenominator.source !== 'tools/validation/machine-effects/arm64-a64-memory-denominator.mjs'
        || memoryDenominator.encodingFamilyCount !== liveMemory.encodingFamilyCount
        || memoryDenominator.encodingCaseCount !== liveMemory.encodingCaseCount
        || memoryDenominator.mnemonicCount !== liveMemory.mnemonicCount
        || memoryDenominator.exactMnemonicCount !== liveMemory.exactMnemonicCount
        || memoryDenominator.partialMnemonicCount !== liveMemory.partialMnemonicCount
        || memoryDenominator.corpusSha256 !== liveMemory.corpusSha256
        || !sameSet(memoryDenominator.oracleIds || [], liveMemory.oracleIds)) {
        fail('a2-denominator-arm64-memory-live-proof-drift', pathName);
      }
      // An exact memory family that still declares partial mnemonics would be a
      // false exact, whatever the inventory says.
      if (liveMemory.partialMnemonicCount !== 0) fail('a2-denominator-arm64-memory-partial-mnemonics-remain', pathName);

      validateArm64FamilyProof(families.find((family) => family.id === 'control'), {
        id:'control', source:'js/targets/architecture/arm64/effects/control.js',
        test:'tests/machine-effects/arm64-control-flow.test.mjs', denominatorTest:'tests/machine-effects/arm64-a64-control-denominator.test.mjs',
        oracle:'arm-a-profile-a64-branch-encoding-tables + deployed-capstone-5-arm64 + llvm-mc-18-aarch64-disassembler',
      }, validateArm64A64ControlDenominator(), pathName);
      validateArm64FamilyProof(families.find((family) => family.id === 'flags'), {
        id:'flags', source:'js/targets/architecture/arm64/effects/flags.js',
        test:'tests/machine-effects/arm64-flags-nzcv.test.mjs', denominatorTest:'tests/machine-effects/arm64-a64-flags-denominator.test.mjs',
        oracle:'arm-a-profile-a64-data-processing-encoding-tables + deployed-capstone-5-arm64 + llvm-mc-18-aarch64-disassembler',
      }, validateArm64A64FlagsDenominator(), pathName);
      validateArm64FamilyProof(families.find((family) => family.id === 'fp'), {
        id:'fp', source:'js/targets/architecture/arm64/effects/fp.js',
        test:'tests/machine-effects/arm64-fp-core.test.mjs', denominatorTest:'tests/machine-effects/arm64-a64-fp-denominator.test.mjs',
        oracle:'arm-a-profile-a64-floating-point-encoding-tables + deployed-capstone-5-arm64 + llvm-mc-18-aarch64-disassembler',
        coverage:'exact-with-intrinsic', cardinalityFields:['mnemonicCount','fpImmediateCount'],
      }, validateArm64A64FpDenominator(), pathName);
      validateArm64FamilyProof(families.find((family) => family.id === 'system'), {
        id:'system', source:'js/targets/architecture/arm64/effects/system.js',
        test:'tests/machine-effects/arm64-system-core.test.mjs', denominatorTest:'tests/machine-effects/arm64-a64-system-denominator.test.mjs',
        oracle:'arm-a-profile-a64-exception-and-system-encoding-tables + deployed-capstone-5-arm64 + llvm-mc-18-aarch64-disassembler',
        coverage:'exact-with-intrinsic', cardinalityFields:['mnemonicCount','selectorCount','registerCount'],
      }, validateArm64A64SystemDenominator(), pathName);
    }
  }

  const blockingGaps = inventory.architectures.flatMap((architecture) => [
    ...architecture.decoder.missingUnits,
    ...(architecture.effectRegistry.families || []).flatMap((unit) => collectStatusGaps(
      unit,
      `${architecture.profileId}:effect-family`,
      { exempt: unit.id === 'fallback-unmatched-decoder-family' && fallbackNegativeProven(architecture) },
    )),
    ...(architecture.exclusions || []).flatMap((unit) => collectStatusGaps(unit, `${architecture.profileId}:explicit-case`)),
    ...(architecture.aliases || []).flatMap((unit) => collectStatusGaps(unit, `${architecture.profileId}:alias`)),
  ]).sort();
  return Object.freeze({
    valid: true,
    schemaVersion: inventory.schemaVersion,
    architectureCount: inventory.architectures.length,
    familyUnitCount: inventory.architectures.reduce((count, architecture) => count + architecture.effectRegistry.families.length, 0),
    explicitDecoderGapCount: inventory.architectures.reduce((count, architecture) => count + architecture.decoder.missingUnits.length, 0),
    blockingGapCount: blockingGaps.length,
    blockingGaps: Object.freeze(blockingGaps),
    // This denominator is the locked production-registry denominator. It never
    // claims full-ISA percentage coverage (the inventory is rejected above if it
    // tries), so terminality is defined by the locked denominator itself: every
    // declared decoder unit, effect family, explicit exclusion, and alias has to
    // be exact or carry a normative-exclusion proof. Requiring
    // fullIsaCoverageIncluded here as well made the gate unsatisfiable by
    // construction and hid which units are actually still open.
    terminalEligible: blockingGaps.length === 0,
    fullIsaCoverageIncluded: false,
  });
}

export function a2DenominatorReport(inventory = loadA2DenominatorInventory()) {
  const validation = validateA2DenominatorInventory(inventory);
  return Object.freeze({
    schemaVersion: 'machine-effects-a2-denominator-report/v2',
    oracleRole: inventory.oracleRole,
    scope: inventory.scope,
    validation,
    architectures: inventory.architectures,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(a2DenominatorReport(), null, 2)}\n`);
}
