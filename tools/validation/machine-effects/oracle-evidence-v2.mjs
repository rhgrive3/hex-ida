import { createHash } from 'node:crypto';

import { MEMORY_ORDERINGS } from '../../../js/semantics/effects/index.js';
import { canonicalStringify } from './oracle-schema.mjs';
import { ORACLE_PROFILE_INVENTORY } from './oracle-policy.mjs';

export const ARCHITECTURAL_EVIDENCE_SCHEMA_VERSION = 'machine-effects-architectural-evidence/v2';
export const ARCHITECTURAL_EVIDENCE_KINDS = Object.freeze(['instruction-footprint', 'relaxed-memory-outcomes']);
export const EVIDENCE_COMPLETENESS = Object.freeze(['complete', 'partial', 'unsupported']);
export const EVIDENCE_ORDERINGS = Object.freeze([...MEMORY_ORDERINGS, 'unknown']);

const SOURCE_KEYS = Object.freeze(['authorityId', 'repository', 'revision', 'modelCommit', 'toolIdentity', 'independentFromProduction']);
const EFFECT_KEYS = Object.freeze(['instructionId', 'effectId', 'caseId', 'requiredFeatures']);
const OBSERVABLE_KEYS = Object.freeze(['declared', 'known', 'undefined', 'implementationDefined', 'unobserved']);
const FRESHNESS_KEYS = Object.freeze(['generatedBy', 'generatedFrom', 'artifactDigest']);
const ARTIFACT_KEYS = Object.freeze(['format', 'inputDigest', 'command', 'toolOutput']);
const MEMORY_KEYS = Object.freeze(['ordering', 'atomic', 'outcomeUniverse', 'permittedOutcomes', 'forbiddenOutcomes']);
const BASE_KEYS = Object.freeze(['schemaVersion', 'evidenceId', 'kind', 'architecture', 'profileId', 'source', 'effect', 'observables', 'expectedObservables', 'completeness', 'freshness', 'artifact']);

export const PINNED_ARCHITECTURAL_SOURCES = Object.freeze({
  'arm64:a64': Object.freeze({
    architecture: 'arm64', status: 'formal-and-memory-model-available', exactBoundary: 'claim-local-complete-artifacts-only',
    authorityId: 'isla-armv8p5-plus-herdtools7-aarch64', repository: 'https://github.com/rems-project/isla-snapshots+https://github.com/herd/herdtools7', revision: 'armv8p5.ir+AArch64.cat/7.58',
    modelCommit: 'isla-snapshots:d8b31014643035a3b11071e56ef30001de3f52ab+herdtools7:1ca343e16a2038e406d1ac674e7e3a1b722b36c7', toolIdentity: 'isla:f189d5cbf6d732839879024c74ab0a8478bc1e28+herdtools7:7.58',
  }),
  'arm64e:a64+pac': Object.freeze({
    architecture: 'arm64e', status: 'partial', exactBoundary: 'no-complete-pac-formal-artifact',
    authorityId: 'arm-a-profile-reference', repository: 'https://github.com/rems-project/sail-arm', revision: 'Arm A-profile PAC context',
    modelCommit: '1bf2e5574ba9d704639a28401b6a387dcb113cae', toolIdentity: 'not-integrated-for-pac',
  }),
  'x86_64:long-64': Object.freeze({
    architecture: 'x86_64', status: 'partial', exactBoundary: 'compiler-truth-is-not-modern-x86-formal-completeness',
    authorityId: 'intel-sdm-plus-compiler-truth', repository: 'local:tests/compiler-truth', revision: 'profile-scoped',
    modelCommit: 'not-available', toolIdentity: 'compiler-truth-only',
  }),
  'riscv64:rv64imc': Object.freeze({
    architecture: 'riscv64', status: 'sequential-formal-available', exactBoundary: 'relaxed-memory-requires-generated-outcome-artifact',
    authorityId: 'riscv-sail', repository: 'https://github.com/riscv/sail-riscv', revision: '0.13.1',
    modelCommit: '27224ccb2290f022e46213c05b3e72e8a9ea635e', toolIdentity: 'sail-riscv:0.13.1',
  }),
});

function fail(code, detail = null) {
  throw new TypeError(detail == null ? code : `${code}:${detail}`);
}

function plain(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(plain(value, code)).sort();
  const wanted = [...expected].sort();
  const unknown = actual.find((key) => !wanted.includes(key));
  if (unknown) fail(`${code}-unknown-field`, unknown);
  const missing = wanted.find((key) => !actual.includes(key));
  if (missing) fail(`${code}-missing-field`, missing);
}

function text(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
}

function bool(value, code) {
  if (typeof value !== 'boolean') fail(code);
  return value;
}

function uniqueStrings(value, code) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) fail(code);
  const normalized = value.map((item) => item.trim()).sort();
  if (new Set(normalized).size !== normalized.length) fail(`${code}-duplicate`);
  return Object.freeze(normalized);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(canonicalStringify(value)).digest('hex')}`;
}

function normalizeSource(value) {
  exactKeys(value, SOURCE_KEYS, 'architectural-evidence-source');
  const source = {
    authorityId: text(value.authorityId, 'architectural-evidence-authority'),
    repository: text(value.repository, 'architectural-evidence-repository'),
    revision: text(value.revision, 'architectural-evidence-revision'),
    modelCommit: text(value.modelCommit, 'architectural-evidence-model-commit'),
    toolIdentity: text(value.toolIdentity, 'architectural-evidence-tool-identity'),
    independentFromProduction: bool(value.independentFromProduction, 'architectural-evidence-independence'),
  };
  if (!source.independentFromProduction || /production-machine-effects|js\/semantics\/effects/i.test(canonicalStringify(source))) fail('production-derived-evidence');
  return Object.freeze(source);
}

function normalizeEffect(value) {
  exactKeys(value, EFFECT_KEYS, 'architectural-evidence-effect');
  return Object.freeze({
    instructionId: text(value.instructionId, 'architectural-evidence-instruction-id'),
    effectId: text(value.effectId, 'architectural-evidence-effect-id'),
    caseId: text(value.caseId, 'architectural-evidence-case-id'),
    requiredFeatures: uniqueStrings(value.requiredFeatures, 'architectural-evidence-features'),
  });
}

function normalizeObservables(value, completeness) {
  exactKeys(value, OBSERVABLE_KEYS, 'architectural-evidence-observables');
  const out = Object.fromEntries(OBSERVABLE_KEYS.map((key) => [key, uniqueStrings(value[key], `architectural-evidence-observables-${key}`)]));
  const partition = [...out.known, ...out.undefined, ...out.implementationDefined, ...out.unobserved];
  if (new Set(partition).size !== partition.length) fail('observable-partition-overlap');
  if (completeness === 'complete' && canonicalStringify([...new Set(partition)].sort()) !== canonicalStringify(out.declared)) fail('observable-partition-incomplete');
  if (partition.some((item) => !out.declared.includes(item))) fail('observable-partition-outside-declared');
  return Object.freeze(out);
}

function normalizeExpected(value, observables) {
  const input = plain(value, 'architectural-evidence-expected-observables');
  const keys = Object.keys(input).sort();
  if (keys.some((key) => !observables.known.includes(key))) fail('expected-observable-not-known');
  if (observables.known.some((key) => !Object.hasOwn(input, key))) fail('known-observable-value-missing');
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, String(input[key])])));
}

function normalizeFreshness(value) {
  exactKeys(value, FRESHNESS_KEYS, 'architectural-evidence-freshness');
  const out = {
    generatedBy: text(value.generatedBy, 'architectural-evidence-generated-by'),
    generatedFrom: text(value.generatedFrom, 'architectural-evidence-generated-from'),
    artifactDigest: text(value.artifactDigest, 'architectural-evidence-artifact-digest'),
  };
  if (!/^sha256:[0-9a-f]{64}$/.test(out.artifactDigest)) fail('architectural-evidence-artifact-digest-invalid');
  return Object.freeze(out);
}

function normalizeArtifact(value) {
  exactKeys(value, ARTIFACT_KEYS, 'architectural-evidence-artifact');
  const artifact = {
    format: text(value.format, 'architectural-evidence-artifact-format'),
    inputDigest: text(value.inputDigest, 'architectural-evidence-artifact-input-digest'),
    command: text(value.command, 'architectural-evidence-artifact-command'),
    toolOutput: text(value.toolOutput, 'architectural-evidence-artifact-tool-output'),
  };
  if (!/^sha256:[0-9a-f]{64}$/.test(artifact.inputDigest)) fail('architectural-evidence-artifact-input-digest-invalid');
  return Object.freeze(artifact);
}

function expectedArtifactFormat(profileId, kind) {
  if (profileId === 'arm64:a64') return kind === 'relaxed-memory-outcomes' ? 'herd7/v7.58' : 'isla-footprint/v0.2.0';
  if (profileId === 'riscv64:rv64imc' && kind === 'instruction-footprint') return 'sail-riscv/v0.13.1';
  return 'architectural-spec-extraction/v1';
}

function normalizeMemory(value, completeness) {
  exactKeys(value, MEMORY_KEYS, 'architectural-evidence-memory-model');
  if (!EVIDENCE_ORDERINGS.includes(value.ordering)) fail('malformed-ordering');
  const atomic = bool(value.atomic, 'architectural-evidence-memory-atomic');
  if (!atomic && value.ordering !== 'unknown') fail('atomic-non-atomic-mismatch');
  if (value.ordering === 'unknown' && completeness === 'complete') fail('unknown-ordering-cannot-be-complete');
  const outcomeUniverse = uniqueStrings(value.outcomeUniverse, 'architectural-evidence-outcome-universe');
  const permittedOutcomes = uniqueStrings(value.permittedOutcomes, 'architectural-evidence-permitted-outcomes');
  const forbiddenOutcomes = uniqueStrings(value.forbiddenOutcomes, 'architectural-evidence-forbidden-outcomes');
  if (permittedOutcomes.some((item) => forbiddenOutcomes.includes(item))) fail('outcome-partition-overlap');
  const partition = [...new Set([...permittedOutcomes, ...forbiddenOutcomes])].sort();
  if (partition.some((item) => !outcomeUniverse.includes(item))) fail('outcome-outside-universe');
  if (completeness === 'complete' && canonicalStringify(partition) !== canonicalStringify(outcomeUniverse)) fail('outcome-universe-incomplete');
  return Object.freeze({ ordering: value.ordering, atomic, outcomeUniverse, permittedOutcomes, forbiddenOutcomes });
}

function normalize(input, { requireIdentity = false } = {}) {
  const raw = plain(input, 'architectural-evidence-invalid');
  const kind = raw.kind;
  if (!ARCHITECTURAL_EVIDENCE_KINDS.includes(kind)) fail('architectural-evidence-kind-invalid');
  const keys = kind === 'relaxed-memory-outcomes' ? [...BASE_KEYS, 'memoryModel'] : BASE_KEYS;
  if (!requireIdentity && raw.evidenceId == null) exactKeys({ ...raw, evidenceId: 'pending' }, keys, 'architectural-evidence');
  else exactKeys(raw, keys, 'architectural-evidence');
  if (raw.schemaVersion !== ARCHITECTURAL_EVIDENCE_SCHEMA_VERSION) fail('architectural-evidence-schema-version');
  if (!EVIDENCE_COMPLETENESS.includes(raw.completeness)) fail('architectural-evidence-completeness-invalid');
  const profile = ORACLE_PROFILE_INVENTORY.find((item) => item.profileId === raw.profileId);
  if (!profile) fail('unsupported-profile', String(raw.profileId));
  const pinned = PINNED_ARCHITECTURAL_SOURCES[raw.profileId];
  if (!pinned) fail('unsupported-profile', raw.profileId);
  const architecture = text(raw.architecture, 'architectural-evidence-architecture');
  if (architecture !== profile.architecture || architecture !== pinned.architecture) fail('profile-architecture-mismatch');
  const source = normalizeSource(raw.source);
  if (source.authorityId !== pinned.authorityId || source.repository !== pinned.repository || source.revision !== pinned.revision || source.modelCommit !== pinned.modelCommit || source.toolIdentity !== pinned.toolIdentity) fail('unsupported-profile-version');
  const effect = normalizeEffect(raw.effect);
  const observables = normalizeObservables(raw.observables, raw.completeness);
  const expectedObservables = normalizeExpected(raw.expectedObservables, observables);
  const freshness = normalizeFreshness(raw.freshness);
  const artifact = normalizeArtifact(raw.artifact);
  if (freshness.generatedFrom !== source.modelCommit) fail('stale-source-identity');
  if (freshness.generatedBy !== artifact.format) fail('architectural-evidence-generator-artifact-mismatch');
  if (freshness.artifactDigest !== sha256(artifact)) fail('architectural-evidence-artifact-digest-mismatch');
  if (raw.completeness === 'complete' && artifact.format !== expectedArtifactFormat(raw.profileId, kind)) fail('architectural-evidence-artifact-format-profile-mismatch');
  const payload = {
    schemaVersion: ARCHITECTURAL_EVIDENCE_SCHEMA_VERSION,
    kind,
    architecture,
    profileId: raw.profileId,
    source,
    effect,
    observables,
    expectedObservables,
    completeness: raw.completeness,
    freshness,
    artifact,
    ...(kind === 'relaxed-memory-outcomes' ? { memoryModel: normalizeMemory(raw.memoryModel, raw.completeness) } : {}),
  };
  const evidenceId = sha256(payload);
  if (requireIdentity && raw.evidenceId !== evidenceId) fail('stale-evidence-identity');
  return Object.freeze({ ...payload, evidenceId });
}

export function createArchitecturalEvidence(input) {
  return normalize({ schemaVersion: ARCHITECTURAL_EVIDENCE_SCHEMA_VERSION, ...input }, { requireIdentity: false });
}

export function createMemoryOutcomeEvidence(input) {
  return createArchitecturalEvidence({ ...input, kind: 'relaxed-memory-outcomes' });
}

export function validateArchitecturalEvidence(input) {
  return normalize(input, { requireIdentity: true });
}

export function createArchitecturalEvidenceFromArtifactRecord(record) {
  const pinned = PINNED_ARCHITECTURAL_SOURCES[record?.profileId];
  if (!pinned) fail('unsupported-profile', String(record?.profileId));
  return createArchitecturalEvidence({
    kind: record.kind,
    architecture: pinned.architecture,
    profileId: record.profileId,
    source: {
      authorityId: pinned.authorityId,
      repository: pinned.repository,
      revision: pinned.revision,
      modelCommit: pinned.modelCommit,
      toolIdentity: pinned.toolIdentity,
      independentFromProduction: true,
    },
    effect: record.effect,
    observables: record.observables,
    expectedObservables: record.expectedObservables,
    completeness: record.completeness,
    freshness: {
      generatedBy: record.artifact?.format,
      generatedFrom: pinned.modelCommit,
      artifactDigest: record.artifactDigest,
    },
    artifact: record.artifact,
    ...(record.kind === 'relaxed-memory-outcomes' ? { memoryModel: record.memoryModel } : {}),
  });
}

function assessment(status, reason) {
  const exactAuthorized = status === 'exact/equivalent';
  return Object.freeze({ status, reason, exactAuthorized, passContribution: exactAuthorized ? 1 : 0 });
}

export function assessArchitecturalEvidence({ evidence, subject } = {}) {
  if (evidence?.completeness === 'unsupported' || !PINNED_ARCHITECTURAL_SOURCES[evidence?.profileId]) return assessment('unsupported', 'profile-or-evidence-unsupported');
  let normalized;
  try { normalized = validateArchitecturalEvidence(evidence); }
  catch (error) { return assessment(/stale/.test(error.message) ? 'stale' : 'malformed', error.message); }
  if (normalized.completeness !== 'complete') return assessment('partial', 'evidence-incomplete');
  if (!subject || subject.profileId !== normalized.profileId) return assessment('mismatch', 'subject-profile-mismatch');
  if (normalized.kind === 'relaxed-memory-outcomes') {
    if (subject.ordering !== normalized.memoryModel.ordering) return assessment('mismatch', 'ordering-disagreement');
    if (subject.atomic !== normalized.memoryModel.atomic) return assessment('mismatch', 'atomicity-disagreement');
    for (const key of ['outcomeUniverse', 'permittedOutcomes', 'forbiddenOutcomes']) {
      if (canonicalStringify([...(subject[key] ?? [])].sort()) !== canonicalStringify(normalized.memoryModel[key])) {
        return assessment('mismatch', `outcome-boundary-disagreement:${key}`);
      }
    }
  }
  for (const [key, expected] of Object.entries(normalized.expectedObservables)) {
    if (String(subject.observables?.[key]) !== expected) return assessment('mismatch', `observable-disagreement:${key}`);
  }
  return assessment('exact/equivalent', null);
}

export function architecturalEvidenceInventory() {
  return Object.freeze(ORACLE_PROFILE_INVENTORY.map((profile) => Object.freeze({
    profileId: profile.profileId,
    architecture: profile.architecture,
    productionSupport: 'declared-by-a2',
    independentEvidence: PINNED_ARCHITECTURAL_SOURCES[profile.profileId].status,
    exactBoundary: PINNED_ARCHITECTURAL_SOURCES[profile.profileId].exactBoundary,
  })));
}
