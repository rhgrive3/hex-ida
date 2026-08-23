import { deepFreeze, jsonSafe, stableDigest, validateCanonicalIdentityNumbers } from './index.js';

function fail(code) { throw new TypeError(code); }
function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}
function exactRevision(value, fallback, code) {
  const resolved = value ?? fallback;
  if (typeof resolved === 'number' && !Number.isSafeInteger(resolved)) fail(code);
  return required(resolved, code);
}
function sortedStrings(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(code);
  return [...new Set(value.map(String).filter(Boolean))].sort();
}

export function createDeterminismMetadata(input = {}) {
  const passVersions = input.passVersions == null ? {} : jsonSafe(input.passVersions);
  const targetSemanticVersions = input.targetSemanticVersions == null ? {} : jsonSafe(input.targetSemanticVersions);
  return deepFreeze({
    engineBuild: required(input.engineBuild, 'determinism-engine-build-required'),
    schemaVersion: required(input.schemaVersion, 'determinism-schema-version-required'),
    passVersions,
    targetSemanticVersions,
    optionsHash: required(input.optionsHash, 'determinism-options-hash-required'),
    inputArtifactIds: sortedStrings(input.inputArtifactIds, 'determinism-input-artifacts-invalid'),
    outputArtifactId: required(input.outputArtifactId, 'determinism-output-artifact-required'),
    backend: input.backend == null ? 'local' : String(input.backend),
  });
}

export function createAnalysisSnapshot(input = {}) {
  const binaryId = required(input.binaryId, 'snapshot-binary-id-required');
  const projectRevision = exactRevision(input.projectRevision, '0', 'snapshot-project-revision-invalid');
  const analysisEpoch = exactRevision(input.analysisEpoch, '0', 'snapshot-analysis-epoch-invalid');
  const artifactVersionInput = input.artifactVersions ?? {};
  validateCanonicalIdentityNumbers(artifactVersionInput);
  const artifactVersions = jsonSafe(artifactVersionInput);
  const snapshotId = input.snapshotId == null
    ? `snapshot_${stableDigest({ binaryId, projectRevision, analysisEpoch, artifactVersions })}`
    : required(input.snapshotId, 'snapshot-id-required');
  return deepFreeze({
    snapshotId,
    binaryId,
    projectRevision,
    artifactVersions,
    analysisEpoch,
    createdAt: required(input.createdAt, 'snapshot-created-at-required'),
  });
}
