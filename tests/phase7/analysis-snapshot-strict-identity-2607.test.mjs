import assert from 'node:assert/strict';
import {
  createAnalysisSnapshot,
  AnalysisSnapshotStaleError,
} from '../../js/analysis/query/snapshot.js';
import { AnalysisQueryAPI } from '../../js/analysis/query/api.js';

const invalidRevisionValues = ['1', '', null, true, false, 1n, {}, []];
for (const projectRevision of invalidRevisionValues) {
  assert.throws(
    () => createAnalysisSnapshot({ binaryId: 'bin', projectRevision, analysisEpoch: 1 }),
    (error) => error instanceof TypeError && error.message === 'analysis-snapshot-project-revision-invalid',
    `projectRevision must reject ${String(projectRevision)} (${typeof projectRevision})`,
  );
}

const invalidEpochValues = ['1', '', null, true, false, 1n, {}, []];
for (const analysisEpoch of invalidEpochValues) {
  assert.throws(
    () => createAnalysisSnapshot({ binaryId: 'bin', projectRevision: 1, analysisEpoch }),
    (error) => error instanceof TypeError && error.message === 'analysis-snapshot-epoch-invalid',
    `analysisEpoch must reject ${String(analysisEpoch)} (${typeof analysisEpoch})`,
  );
}

const valid = createAnalysisSnapshot({ binaryId: 'bin', projectRevision: 0, analysisEpoch: Number.MAX_SAFE_INTEGER });
assert.equal(valid.projectRevision, 0);
assert.equal(valid.analysisEpoch, Number.MAX_SAFE_INTEGER);

{
  const snapshot = createAnalysisSnapshot({ binaryId: 'bin', projectRevision: 1, analysisEpoch: 2 });
  const api = new AnalysisQueryAPI({
    async currentIdentity() {
      return { binaryId: 'bin', projectRevision: '1', analysisEpoch: 2, artifactVersions: {} };
    },
    async binaryInfo() {
      return { value: { format: 'test' }, status: { completeness: 'complete' } };
    },
  });
  await assert.rejects(api.binaryInfo(snapshot), (error) => error instanceof AnalysisSnapshotStaleError && error.code === 'analysis-snapshot-stale');
}

{
  const snapshot = createAnalysisSnapshot({ binaryId: 'bin', projectRevision: 1, analysisEpoch: 1 });
  const api = new AnalysisQueryAPI({
    async currentIdentity() {
      return { binaryId: 'bin', projectRevision: 1, analysisEpoch: true, artifactVersions: {} };
    },
  });
  await assert.rejects(api.binaryInfo(snapshot), (error) => error instanceof AnalysisSnapshotStaleError && error.code === 'analysis-snapshot-stale');
}

console.log('phase7 strict analysis snapshot identity regression (#2607): PASS');
