import fs from 'node:fs';
import path from 'node:path';
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
export const DEFAULT_A2_DENOMINATOR_PATH = path.join(ROOT, 'tests/machine-effects/a2-denominator-inventory.json');
export const A2_DENOMINATOR_SCHEMA = 'machine-effects-a2-denominator/v1';

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

function validateStatus(unit, pathName) {
  if (!unit || typeof unit !== 'object') fail('a2-denominator-unit-invalid', pathName);
  assertString(unit.id, 'a2-denominator-unit-id-required', pathName);
  if (!['exact', 'excluded'].includes(unit.status)) fail('a2-denominator-unit-status-invalid', `${pathName}:${unit.id}`);
  if (unit.status === 'exact') {
    if (!['exact', 'exact-with-intrinsic'].includes(unit.coverage)) fail('a2-denominator-exact-coverage-invalid', `${pathName}:${unit.id}`);
    if (unit.preexisting !== true) fail('a2-denominator-exact-preexisting-evidence-required', `${pathName}:${unit.id}`);
    assertString(unit.oracle, 'a2-denominator-exact-oracle-required', `${pathName}:${unit.id}`);
  } else {
    if (!['partial', 'unknown', 'unsupported'].includes(unit.coverage)) fail('a2-denominator-exclusion-coverage-invalid', `${pathName}:${unit.id}`);
    if (unit.preexisting !== true) fail('a2-denominator-exclusion-must-be-preexisting', `${pathName}:${unit.id}`);
    assertString(unit.reason, 'a2-denominator-exclusion-reason-required', `${pathName}:${unit.id}`);
  }
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

function collectStatusGaps(unit, prefix, { exempt = false } = {}) {
  if (!unit || typeof unit !== 'object') return [];
  const pathName = `${prefix}:${unit.id}`;
  const gaps = [];
  if (!exempt && unit.status !== 'exact') gaps.push(pathName);
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
  if (decoder.enumerationStatus !== 'excluded') fail('a2-denominator-decoder-gap-must-be-explicit', pathName);
  assertString(decoder.reason, 'a2-denominator-decoder-gap-reason-required', pathName);
  if (!Array.isArray(decoder.missingUnits) || decoder.missingUnits.length === 0) fail('a2-denominator-decoder-missing-units-required', pathName);
  if (new Set(decoder.missingUnits).size !== decoder.missingUnits.length) fail('a2-denominator-decoder-missing-units-duplicate', pathName);
  if (!decoder.missingUnits.every((unit) => typeof unit === 'string' && unit.startsWith(`${architecture.profileId}:`))) {
    fail('a2-denominator-decoder-missing-unit-profile-drift', pathName);
  }
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
