import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { AnalysisSnapshotStaleError } from '../../../js/analysis/query/snapshot.js';

const identity = { binaryId: 'binary-A', projectRevision: 0, analysisEpoch: 1, artifactVersions: {} };
const customError = Object.assign(new Error('deadline'), { name: 'DeadlineError', code: 'deadline', detail: { value: 1 } });
const reasons = [customError, new Error('stop'), 'turn-replaced', { kind: 'closed' }, 0, false, '', null, Symbol('stop')];

async function rejectsExactly(promise, reason) {
  let rejected = false;
  await promise.then(() => assert.fail('operation did not reject'), (error) => {
    rejected = true;
    assert.equal(error, reason, 'preserve the supplied reason, not just its message');
  });
  assert.equal(rejected, true);
}

for (const boundary of ['snapshot-before', 'snapshot-after', 'query-before', 'query-pre-identity', 'query-after-adapter', 'query-post-identity']) {
  test(`#4280 exact reason survives ${boundary}`, async () => {
    for (const reason of reasons) {
      const controller = new AbortController();
      let identities = 0;
      let queries = 0;
      const api = new AnalysisQueryAPI({
        async currentIdentity() {
          identities++;
          if ((boundary === 'snapshot-after' && identities === 1)
            || (boundary === 'query-pre-identity' && identities === 2)
            || (boundary === 'query-post-identity' && identities === 3)) controller.abort(reason);
          return identity;
        },
        async binaryInfo() {
          queries++;
          if (boundary === 'query-after-adapter') controller.abort(reason);
          return { value: { format: 'test' }, status: { completeness: 'complete' } };
        },
      });
      if (boundary.startsWith('snapshot')) {
        if (boundary === 'snapshot-before') controller.abort(reason);
        await rejectsExactly(api.snapshot({ signal: controller.signal }), reason);
        if (boundary === 'snapshot-before') assert.equal(identities, 0);
      } else {
        const snapshot = await api.snapshot();
        if (boundary === 'query-before') controller.abort(reason);
        await rejectsExactly(api.binaryInfo(snapshot, { signal: controller.signal }), reason);
        if (boundary === 'query-before' || boundary === 'query-pre-identity') assert.equal(queries, 0);
      }
    }
  });
}

test('#4280 standard AbortSignal default and legacy missing-reason fallback remain AbortErrors', async () => {
  const api = new AnalysisQueryAPI({ currentIdentity: () => identity });
  const controller = new AbortController();
  controller.abort();
  await rejectsExactly(api.snapshot({ signal: controller.signal }), controller.signal.reason);
  for (const signal of [{ aborted: true }, { aborted: true, reason: undefined }]) {
    await assert.rejects(api.snapshot({ signal }), (error) => error.name === 'AbortError');
  }
});

test('#4280 successful queries and stale-snapshot errors keep their own semantics', async () => {
  let current = identity;
  const api = new AnalysisQueryAPI({
    currentIdentity: () => current,
    binaryInfo: () => ({ value: 'known', status: { completeness: 'complete' } }),
  });
  const snapshot = await api.snapshot();
  assert.equal((await api.binaryInfo(snapshot)).value, 'known');
  current = { ...identity, analysisEpoch: 2 };
  await assert.rejects(api.binaryInfo(snapshot), AnalysisSnapshotStaleError);
});
