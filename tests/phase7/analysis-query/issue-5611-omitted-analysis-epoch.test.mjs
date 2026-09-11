import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';

function adapterWithIdentity(identity) {
  return {
    async currentIdentity() { return { ...identity }; },
    async binaryInfo() { return { value: { ok: true }, status: { completeness: 'complete' }, page: null }; },
  };
}

test('an adapter that omits analysisEpoch is not instantly stale: undefined defaults to 0 like projectRevision (#5611)', async () => {
  const identity = {
    binaryId: 'bin-5611',
    projectRevision: 0,
    artifactVersions: {},
    // analysisEpoch deliberately omitted — the adapter does not track an epoch.
  };
  const api = new AnalysisQueryAPI(adapterWithIdentity(identity));
  const snapshot = await api.snapshot();

  assert.equal(snapshot.analysisEpoch, 0, 'createAnalysisSnapshot defaults the omitted epoch to 0');

  // Nothing changed between snapshot() and the query: the identity returned by
  // the adapter is byte-identical, so the fresh snapshot must NOT be stale.
  const result = await api.binaryInfo(snapshot, {});
  assert.equal(result?.value?.ok, true, 'a fresh snapshot with an omitted epoch must be queryable (#5611)');
});

test('a genuinely changed analysisEpoch still fails closed as stale (#5611 control)', async () => {
  let epoch = 0;
  const adapter = {
    async currentIdentity() {
      return { binaryId: 'bin-5611-control', projectRevision: 0, artifactVersions: {}, analysisEpoch: epoch };
    },
    async binaryInfo() { return { value: { ok: true }, status: { completeness: 'complete' }, page: null }; },
  };
  const api = new AnalysisQueryAPI(adapter);
  const snapshot = await api.snapshot();
  epoch = 1;
  await assert.rejects(
    () => api.binaryInfo(snapshot, {}),
    (error) => error.name === 'AnalysisSnapshotStaleError',
    'an actual epoch bump must still be detected as staleness',
  );
});

test('an explicit null analysisEpoch still fails closed (#5611 control)', async () => {
  const adapter = adapterWithIdentity({ binaryId: 'bin-5611-null', projectRevision: 0, artifactVersions: {}, analysisEpoch: null });
  const api = new AnalysisQueryAPI(adapter);
  await assert.rejects(
    () => api.snapshot(),
    (error) => error instanceof TypeError,
    'null is not undefined: an adapter explicitly reporting null is rejected at snapshot creation',
  );
});
