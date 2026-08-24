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
import {
  ARM64_A64_INTEGER_DENOMINATOR_ID,
  ARM64_A64_INTEGER_DENOMINATOR_SCHEMA,
  validateArm64A64IntegerDenominator,
} from './arm64-a64-integer-denominator.mjs';

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
  if (decoder.units.length !== 1 || decoder.units[0] !== 'riscv64:rv64imc:all-valid-32-bit-and-compressed-encodings') {
    fail('a2-denominator-exact-decoder-unit-set-drift', pathName);
  }
  if (architecture.id !== 'riscv64') fail('a2-denominator-exact-decoder-proof-unavailable', pathName);
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
      if (!baseline || baseline.kind !== 'delegation' || baseline.sourceArchitecture !== 'arm64' || baseline.status !== 'excluded' || baseline.preexisting !== true || !baseline.reason) fail('a2-denominator-arm64e-baseline-alias-missing');
      const exclusion = architecture.exclusions?.find((item) => item?.id === 'pac-missing-structured-operands');
      if (!exclusion || exclusion.status !== 'excluded') fail('a2-denominator-pac-partial-exclusion-missing');
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
    }
    if (architecture.id === 'arm64') {
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
    }
  }

  const blockingGaps = inventory.architectures.flatMap((architecture) => [
    ...architecture.decoder.missingUnits,
    ...(architecture.effectRegistry.families || []).flatMap((unit) => collectStatusGaps(
      unit,
      `${architecture.profileId}:effect-family`,
      { exempt: architecture.id === 'riscv64' && unit.id === 'fallback-unmatched-decoder-family' },
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
    terminalEligible: inventory.scope.fullIsaCoverageIncluded === true && blockingGaps.length === 0,
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
