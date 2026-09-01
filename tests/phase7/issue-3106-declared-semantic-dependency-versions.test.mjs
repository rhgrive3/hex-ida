import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASE7_ARTIFACT_KINDS,
  createPhase7ArtifactDescriptor,
  dependencyClassFor,
} from '../../js/analysis/artifact-identity.js';

const base = (overrides = {}) => ({
  kind: 'phase7.pointsto.local',
  binaryId: 'binary_1',
  functionId: 'function_1',
  architectureId: 'arm64',
  snapshotId: 'snapshot_1',
  analyzerId: 'phase7.pointsto.a2-local',
  analyzerVersion: '1.0.0',
  semanticSchemaVersion: '2',
  cfgVersion: '2.0.0',
  ssaVersion: '2.0.0',
  memorySsaVersion: '2.0.0',
  architectureSemanticVersion: '1',
  abiSemanticVersion: '1',
  ...overrides,
});

test('issue-3106: an artifact with a semantic dependency must declare architectureSemanticVersion', () => {
  // phase7.pointsto.local declares the semantic class, so omitting the version
  // used to publish 'n/a' with relevance false — a stale artifact could be
  // reused across architecture semantic versions.
  for (const kind of PHASE7_ARTIFACT_KINDS) {
    const classes = dependencyClassFor(kind);
    if (!classes.includes('semantic')) continue;
    assert.throws(() => createPhase7ArtifactDescriptor(base({ kind, architectureSemanticVersion: undefined })),
      /phase7-artifact-architecture-semantic-version-required/, `${kind} must require architectureSemanticVersion`);
  }
});

test('issue-3106: an artifact with an abi dependency must declare abiSemanticVersion', () => {
  for (const kind of PHASE7_ARTIFACT_KINDS) {
    const classes = dependencyClassFor(kind);
    if (!classes.includes('abi')) continue;
    assert.throws(() => createPhase7ArtifactDescriptor(base({ kind, abiSemanticVersion: undefined })),
      /phase7-artifact-abi-semantic-version-required/, `${kind} must require abiSemanticVersion`);
  }
});

test('issue-3106: declared versions keep the artifact identity stable and distinct', () => {
  assert.equal(createPhase7ArtifactDescriptor(base()).artifactId, createPhase7ArtifactDescriptor(base()).artifactId);
  assert.notEqual(
    createPhase7ArtifactDescriptor(base()).artifactId,
    createPhase7ArtifactDescriptor(base({ architectureSemanticVersion: '2' })).artifactId,
    'a different architecture semantic version must mint a different identity');
  assert.notEqual(
    createPhase7ArtifactDescriptor(base()).artifactId,
    createPhase7ArtifactDescriptor(base({ abiSemanticVersion: '2' })).artifactId,
    'a different abi semantic version must mint a different identity');
});
