// Regression for #6243: phase7.pointsto.local declares calleeSummaries as a
// dependency class, so changing a callee summary's identity (its
// returnProvenance) must change the canonical artifact identity — the
// FM-15 rule (never build a key narrower than the actual dependency).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PHASE7_DEPENDENCY_CLASSES, createPhase7ArtifactDescriptor, dependencyClassFor } from '../../../js/analysis/artifact-identity.js';

const base = {
  kind: 'phase7.pointsto.local',
  binaryId: 'bin',
  functionId: 'A',
  architectureId: 'arm64',
  architectureSemanticVersion: '1',
  snapshotId: 'snap',
  analyzerId: 'phase7.pointsto.a2-local',
  analyzerVersion: '1.2.0',
  semanticSchemaVersion: '2',
  cfgVersion: '2',
  ssaVersion: '2',
  memorySsaVersion: '2',
};

test('#6243 pointsto.local declares calleeSummaries as a dependency class', () => {
  assert.equal(dependencyClassFor('phase7.pointsto.local').includes('calleeSummaries'), true);
  assert.ok(PHASE7_DEPENDENCY_CLASSES['phase7.pointsto.local'].includes('calleeSummaries'));
});

test('#6243 differing callee summary identities change the artifact identity', () => {
  const v1 = createPhase7ArtifactDescriptor({ ...base, calleeSummaryIds: ['B@summary-v1'] });
  const v2 = createPhase7ArtifactDescriptor({ ...base, calleeSummaryIds: ['B@summary-v2'] });
  assert.notEqual(v1.artifactId, v2.artifactId);
});

test('#6243 the descriptor stays deterministic without callee summaries', () => {
  const first = createPhase7ArtifactDescriptor({ ...base });
  const second = createPhase7ArtifactDescriptor({ ...base });
  assert.equal(first.artifactId, second.artifactId);
});
