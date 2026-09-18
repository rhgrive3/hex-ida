import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisSnapshot, assertAnalysisSnapshot } from '../../js/analysis/query/snapshot.js';
import { AnalysisQueryAPI } from '../../js/analysis/query/api.js';

test('#4963 a padded binaryId snapshot is rejected as non-canonical instead of self-contradicting', () => {
  const canonical = createAnalysisSnapshot({
    binaryId: 'bin-1',
    projectRevision: 0,
    analysisEpoch: 0,
    artifactVersions: {},
  });

  assert.doesNotThrow(() => assertAnalysisSnapshot(canonical), 'canonical snapshots stay valid');

  const external = { ...canonical, binaryId: '  bin-1  ' };
  assert.throws(
    () => assertAnalysisSnapshot(external),
    (error) => error instanceof TypeError && error.message === 'analysis-snapshot-binary-id-noncanonical',
  );
});

test('#4963 the query API fails closed on a non-canonical binaryId instead of a confusing stale error', async () => {
  const canonical = createAnalysisSnapshot({
    binaryId: 'bin-1',
    projectRevision: 0,
    analysisEpoch: 0,
    artifactVersions: {},
  });
  const api = new AnalysisQueryAPI({
    async currentIdentity() {
      return { binaryId: 'bin-1', projectRevision: 0, analysisEpoch: 0, artifactVersions: {} };
    },
    async binaryInfo() {
      return { value: { ok: true }, status: { completeness: 'complete' } };
    },
  });

  await assert.doesNotReject(() => api.binaryInfo(canonical), 'canonical snapshot queries fine');

  const external = { ...canonical, binaryId: '  bin-1  ' };
  await assert.rejects(
    () => api.binaryInfo(external),
    (error) => error instanceof TypeError && error.message === 'analysis-snapshot-binary-id-noncanonical',
  );
});
