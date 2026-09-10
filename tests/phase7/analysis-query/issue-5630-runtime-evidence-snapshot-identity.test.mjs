import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/product-evidence-adapter.js';
import { createRuntimeEvidenceRecord } from '../../../js/runtime-evidence/index.js';
import { runtimePlatformForApp, resetAppRuntime } from '../../../js/runtime/app-runtime.js';

function makeApp() {
  const store = new Map([
    ['fileInfo', { hash: 'hash-5630', binaryId: 'bin-5630', slices: [] }],
    ['capability', { architecture: 'arm64', semanticVersion: 'test-v1' }],
  ]);
  return {
    store: { get: (key) => store.get(key) ?? null },
    backend: { gen: 0 },
    symbols: { gen: 0, functionEvidence: () => null, nameAt: () => null, nameEvidence: () => null },
  };
}

const ADDRESS = 0x1000n;
const QUERY = { address: '0x1000' };
const SLICE = 'slice:-1:-:arm64';

async function collectRows(api, snapshot) {
  const result = await api.evidence(snapshot, QUERY, { offset: 0, limit: 5000 }, {});
  return Array.isArray(result?.value) ? result.value : [];
}

test('runtime evidence recorded after snapshot() makes that snapshot stale (#5630)', async () => {
  const app = makeApp();
  const platform = await runtimePlatformForApp(app);
  const adapter = createAppAnalysisQueryAdapter(app);
  const api = new AnalysisQueryAPI(adapter);

  const before = await api.snapshot();
  const rowsBefore = await collectRows(api, before);
  assert.ok(rowsBefore.every((row) => row.kind !== 'runtime-observation'), 'precondition: no runtime rows yet');

  platform._recordEvidence(createRuntimeEvidenceRecord({
    function: ADDRESS,
    binaryHash: 'hash-5630',
    sliceIdentity: SLICE,
    verdict: 'confirmed',
    kind: 'trace',
  }));

  const after = await api.snapshot();
  assert.notEqual(
    before.snapshotId,
    after.snapshotId,
    'snapshot identity must change when runtime evidence appears (#5630)',
  );

  const rowsAfter = await collectRows(api, after);
  assert.ok(rowsAfter.some((row) => row.kind === 'trace' && row.verdict === 'confirmed'), 'runtime row projected after recording');

  // The pre-record snapshot is now stale: queries that reuse it must fail
  // closed instead of silently returning different rows for the same id.
  await assert.rejects(
    () => api.evidence(before, QUERY, {}, {}),
    (error) => error?.code === 'analysis-snapshot-stale' || error?.name === 'AnalysisSnapshotStaleError',
  );
});

test('identity is stable when no runtime evidence changed (#5630 control)', async () => {
  const app = makeApp();
  const adapter = createAppAnalysisQueryAdapter(app);
  const api = new AnalysisQueryAPI(adapter);
  const first = await api.snapshot();
  const second = await api.snapshot();
  assert.equal(first.snapshotId, second.snapshotId);
});

test('4096-cap shift replacement with identical id/kind/verdict/timestamp still invalidates the snapshot (#5630 R1 #7)', async () => {
  const app = makeApp();
  const platform = await runtimePlatformForApp(app);
  const adapter = createAppAnalysisQueryAdapter(app);
  const api = new AnalysisQueryAPI(adapter);

  // Fill the corpus to its cap with records sharing one identity tuple
  // (id/kind/verdict/timestamp identical) but distinct visible payloads.
  const shared = { binaryHash: 'hash-5630', sliceIdentity: SLICE, verdict: 'confirmed', kind: 'trace', timestamp: '2026-09-09T00:00:00.000Z', sessionId: 'session-cap', function: ADDRESS };
  for (let i = 0; i < 4096; i++) {
    platform._recordEvidence(createRuntimeEvidenceRecord({ ...shared, observedState: { returnValue: `filler-${i}` } }));
  }
  assert.equal(platform.evidence.length, 4096, 'precondition: corpus at cap');

  const before = await api.snapshot();
  const rowsBefore = await collectRows(api, before);
  const firstRowBefore = rowsBefore.find((row) => row.kind === 'trace');
  assert.ok(firstRowBefore, 'precondition: runtime rows visible');
  assert.equal(
    JSON.stringify(firstRowBefore.evidence?.observedState),
    JSON.stringify({ returnValue: 'filler-0' }),
    'precondition: evicted slot shows the oldest payload',
  );

  // Shift+push: the new record repeats the SAME identity tuple of the evicted
  // head row but carries a different visible payload. The projected evidence()
  // rows change, so snapshot identity must change too — a field-subset digest
  // would keep the old snapshotId alive over mutated rows (R1 review).
  platform._recordEvidence(createRuntimeEvidenceRecord({ ...shared, observedState: { returnValue: 'replacement' } }));
  assert.equal(platform.evidence.length, 4096, 'cap evicted exactly one record');

  await assert.rejects(
    () => api.evidence(before, QUERY, {}, {}),
    (error) => error?.code === 'analysis-snapshot-stale' || error?.name === 'AnalysisSnapshotStaleError',
    'same-tuple replacement under the cap must not survive the stale check',
  );

  const fresh = await api.snapshot();
  const rowsAfter = await collectRows(api, fresh);
  const replacementRow = rowsAfter.find((row) => row.kind === 'trace' && row.evidence?.observedState?.returnValue === 'replacement');
  assert.ok(replacementRow, 'replacement payload visible on a fresh snapshot');
  assert.notEqual(before.snapshotId, fresh.snapshotId, 'identity reflects the payload replacement');
});

test('runtime reset invalidates snapshots taken before the reset (#5630 R1 #8)', async () => {
  const app = makeApp();
  const platform = await runtimePlatformForApp(app);
  const adapter = createAppAnalysisQueryAdapter(app);
  const api = new AnalysisQueryAPI(adapter);

  platform._recordEvidence(createRuntimeEvidenceRecord({
    function: ADDRESS,
    binaryHash: 'hash-5630',
    sliceIdentity: SLICE,
    verdict: 'confirmed',
    kind: 'trace',
  }));
  const before = await api.snapshot();
  assert.ok((await collectRows(api, before)).some((row) => row.kind === 'trace'), 'precondition: row visible');

  await resetAppRuntime(app);

  await assert.rejects(
    () => api.evidence(before, QUERY, {}, {}),
    (error) => error?.code === 'analysis-snapshot-stale' || error?.name === 'AnalysisSnapshotStaleError',
    'a reset runtime must not be live-read through a pre-reset snapshot',
  );

  const after = await api.snapshot();
  assert.notEqual(before.snapshotId, after.snapshotId, 'identity changes across runtime reset');
  assert.ok((await collectRows(api, after)).every((row) => row.kind !== 'runtime-observation' && row.kind !== 'trace'), 'reset corpus is empty');
});

test('records outside the binary/slice filter stay invisible to both rows and identity (#5630 R1 #9 control)', async () => {
  const app = makeApp();
  const platform = await runtimePlatformForApp(app);
  const adapter = createAppAnalysisQueryAdapter(app);
  const api = new AnalysisQueryAPI(adapter);

  const baseline = await api.snapshot();

  // Wrong binaryHash: filtered out of runtimeEvidenceForApp, so it must not
  // leak into the projected rows nor into the snapshot identity dimension.
  platform._recordEvidence(createRuntimeEvidenceRecord({
    function: ADDRESS,
    binaryHash: 'some-other-binary',
    sliceIdentity: SLICE,
    verdict: 'confirmed',
    kind: 'trace',
  }));
  const withForeignRecord = await api.snapshot();
  assert.equal(baseline.snapshotId, withForeignRecord.snapshotId, 'foreign-binary record does not perturb identity');
  assert.ok((await collectRows(api, withForeignRecord)).every((row) => row.kind !== 'trace'), 'foreign-binary record is not projected');

  // Matching binaryHash but wrong sliceIdentity: same fail-closed filtering.
  platform._recordEvidence(createRuntimeEvidenceRecord({
    function: ADDRESS,
    binaryHash: 'hash-5630',
    sliceIdentity: 'slice:7:uuid-x:arm64',
    verdict: 'confirmed',
    kind: 'trace',
  }));
  const withForeignSlice = await api.snapshot();
  assert.equal(baseline.snapshotId, withForeignSlice.snapshotId, 'foreign-slice record does not perturb identity');
  assert.ok((await collectRows(api, withForeignSlice)).every((row) => row.kind !== 'trace'), 'foreign-slice record is not projected');

  // The in-corpus record still invalidates the baseline (already covered by
  // the first test; here as the positive control for this fixture).
  platform._recordEvidence(createRuntimeEvidenceRecord({
    function: ADDRESS,
    binaryHash: 'hash-5630',
    sliceIdentity: SLICE,
    verdict: 'confirmed',
    kind: 'trace',
  }));
  const withMatching = await api.snapshot();
  assert.notEqual(baseline.snapshotId, withMatching.snapshotId, 'matching record does change identity');
});
