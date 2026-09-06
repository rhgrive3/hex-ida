import { deepFreeze, jsonSafe, stableDigest, validateCanonicalIdentityNumbers } from './index.js';

function fail(code) { throw new TypeError(code); }
function required(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}
function exactRevision(value, fallback, code) {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved === 'number') {
    if (!Number.isSafeInteger(resolved) || resolved < 0) fail(code);
    return String(resolved);
  }
  if (typeof resolved === 'bigint') {
    if (resolved < 0n) fail(code);
    return String(resolved);
  }
  if (typeof resolved !== 'string' || !/^(0|[1-9]\d*)$/.test(resolved)) fail(code);
  return resolved;
}
function exactJson(value) {
  validateCanonicalIdentityNumbers(value);
  return jsonSafe(value);
}
function sortedStrings(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(code);
  if (value.some((item) => typeof item !== 'string')) fail(code);
  return [...new Set(value.filter(Boolean))].sort();
}

export function createDeterminismMetadata(input = {}) {
  const passVersions = exactJson(input.passVersions ?? {});
  const targetSemanticVersions = exactJson(input.targetSemanticVersions ?? {});
  return deepFreeze({
    engineBuild: required(input.engineBuild, 'determinism-engine-build-required'),
    schemaVersion: required(input.schemaVersion, 'determinism-schema-version-required'),
    passVersions,
    targetSemanticVersions,
    optionsHash: required(input.optionsHash, 'determinism-options-hash-required'),
    inputArtifactIds: sortedStrings(input.inputArtifactIds, 'determinism-input-artifacts-invalid'),
    outputArtifactId: required(input.outputArtifactId, 'determinism-output-artifact-required'),
    backend: input.backend == null ? 'local' : required(input.backend, 'determinism-backend-invalid'),
  });
}

export function createAnalysisSnapshot(input = {}) {
  const binaryId = required(input.binaryId, 'snapshot-binary-id-required');
  const projectRevision = exactRevision(input.projectRevision, '0', 'snapshot-project-revision-invalid');
  const analysisEpoch = exactRevision(input.analysisEpoch, '0', 'snapshot-analysis-epoch-invalid');
  const artifactVersions = exactJson(input.artifactVersions ?? {});
  const snapshotId = `snapshot_${stableDigest({ binaryId, projectRevision, analysisEpoch, artifactVersions })}`;
  // Imported IDs are assertions about this state, not an override of it.
  if (input.snapshotId != null && required(input.snapshotId, 'snapshot-id-required') !== snapshotId) {
    fail('snapshot-identity-mismatch');
  }
  return deepFreeze({
    snapshotId,
    binaryId,
    projectRevision,
    artifactVersions,
    analysisEpoch,
    createdAt: required(input.createdAt, 'snapshot-created-at-required'),
  });
}
