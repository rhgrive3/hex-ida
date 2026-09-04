import { createHash } from 'node:crypto';

import { canonicalStringify } from '../../../tools/validation/machine-effects/oracle-schema.mjs';
import { PINNED_ARCHITECTURAL_SOURCES } from '../../../tools/validation/machine-effects/oracle-evidence-v2.mjs';

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalStringify(value)).digest('hex')}`;
}

function artifactFor(profileId, kind = 'instruction-footprint', identity = 'standalone:a64-adds') {
  const format = kind === 'relaxed-memory-outcomes' ? 'herd7/v7.58'
    : profileId === 'riscv64:rv64imc' ? 'sail-riscv/v0.13.1'
      : profileId === 'arm64:a64' ? 'isla-footprint/v0.2.0' : 'architectural-spec-extraction/v1';
  const artifact = {
    format,
    inputDigest: digest({ profileId, kind, identity }),
    command: `unit-fixture --no-external-execution --profile ${profileId} --kind ${kind} --case ${identity}`,
    toolOutput: `synthetic schema fixture for ${profileId} ${kind} ${identity}; not regenerated evidence`,
  };
  return { artifact, freshness: { generatedBy: format, artifactDigest: digest(artifact) } };
}

export function architecturalInput(overrides = {}) {
  const profileId = overrides.profileId ?? 'arm64:a64';
  const pinned = PINNED_ARCHITECTURAL_SOURCES[profileId] ?? PINNED_ARCHITECTURAL_SOURCES['arm64:a64'];
  const evidenceArtifact = artifactFor(profileId);
  return {
    kind: 'instruction-footprint',
    architecture: pinned.architecture,
    profileId,
    source: {
      authorityId: pinned.authorityId,
      repository: pinned.repository,
      revision: pinned.revision,
      modelCommit: pinned.modelCommit,
      toolIdentity: pinned.toolIdentity,
      independentFromProduction: true,
    },
    effect: { instructionId: 'a64:adds:x0-x1-x2', effectId: 'register:x0+nzcv', caseId: 'standalone:a64-adds', requiredFeatures: ['a64'] },
    observables: {
      declared: ['flag:C', 'flag:N', 'flag:V', 'flag:Z', 'register:x0'],
      known: ['flag:C', 'flag:N', 'flag:V', 'flag:Z', 'register:x0'],
      undefined: [], implementationDefined: [], unobserved: [],
    },
    expectedObservables: { 'flag:C': '0', 'flag:N': '1', 'flag:V': '1', 'flag:Z': '0', 'register:x0': '0x8000000000000000' },
    completeness: 'complete',
    artifact: evidenceArtifact.artifact,
    freshness: { ...evidenceArtifact.freshness, generatedFrom: pinned.modelCommit },
    ...overrides,
  };
}

export function memoryInput(ordering, overrides = {}) {
  const evidenceArtifact = artifactFor('arm64:a64', 'relaxed-memory-outcomes', ordering);
  const base = architecturalInput({
    kind: 'relaxed-memory-outcomes',
    effect: { instructionId: `a64:litmus:${ordering}`, effectId: `memory-order:${ordering}`, caseId: `standalone:litmus:${ordering}`, requiredFeatures: ['a64', 'atomics'] },
    observables: { declared: ['outcome:r0=0,r1=0', 'outcome:r0=1,r1=1'], known: ['outcome:r0=0,r1=0', 'outcome:r0=1,r1=1'], undefined: [], implementationDefined: [], unobserved: [] },
    expectedObservables: { 'outcome:r0=0,r1=0': 'classified', 'outcome:r0=1,r1=1': 'classified' },
    completeness: ordering === 'unknown' ? 'partial' : 'complete',
    artifact: evidenceArtifact.artifact,
    freshness: { ...evidenceArtifact.freshness, generatedFrom: PINNED_ARCHITECTURAL_SOURCES['arm64:a64'].modelCommit },
  });
  return {
    ...base,
    memoryModel: {
      ordering,
      atomic: ordering !== 'unknown',
      outcomeUniverse: ['r0=0,r1=0', 'r0=1,r1=1'],
      permittedOutcomes: ordering === 'seq-cst' ? ['r0=1,r1=1'] : ['r0=0,r1=0', 'r0=1,r1=1'],
      forbiddenOutcomes: ordering === 'seq-cst' ? ['r0=0,r1=0'] : [],
    },
    ...overrides,
  };
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function evidenceInputForOracleCase(caseValue) {
  const expected = {};
  for (const [name, value] of Object.entries(caseValue.expectedState.registers)) expected[`register:${name}`] = value;
  for (const [name, value] of Object.entries(caseValue.expectedState.flags)) expected[`flag:${name}`] = String(value);
  for (const [name, value] of Object.entries(caseValue.expectedState.vectors)) expected[`vector:${name}`] = value;
  for (const entry of caseValue.expectedState.memory) expected[`memory:${entry.address}:${entry.widthBits}`] = entry.value;
  const declared = Object.keys(expected).sort();
  const evidenceArtifact = artifactFor(caseValue.profileId, 'instruction-footprint', caseValue.caseId);
  return architecturalInput({
    profileId: caseValue.profileId,
    kind: 'instruction-footprint',
    effect: {
      instructionId: `${caseValue.architecture}:${caseValue.mnemonic}`,
      effectId: `oracle-case:${caseValue.caseId}`,
      caseId: caseValue.caseId,
      requiredFeatures: caseValue.requiredFeatures,
    },
    observables: { declared, known: declared, undefined: [], implementationDefined: [], unobserved: [] },
    expectedObservables: expected,
    completeness: 'complete',
    artifact: evidenceArtifact.artifact,
    freshness: { ...evidenceArtifact.freshness, generatedFrom: PINNED_ARCHITECTURAL_SOURCES[caseValue.profileId].modelCommit },
  });
}
