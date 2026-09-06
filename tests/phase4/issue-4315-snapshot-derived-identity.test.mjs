import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalysisSnapshot } from '../../js/core/identity/snapshot.js';

const input = {
  binaryId: 'binary-A', projectRevision: '7', analysisEpoch: '11',
  artifactVersions: { semantic: '2' }, createdAt: '2026-09-07T00:00:00.000Z',
};

test('an explicit snapshot ID must match its canonical analysis-state tuple', () => {
  const canonical = createAnalysisSnapshot(input);
  assert.throws(() => createAnalysisSnapshot({ ...input, snapshotId: 'snapshot_forged' }), {
    name: 'TypeError', message: 'snapshot-identity-mismatch',
  });
  assert.deepEqual(createAnalysisSnapshot({ ...input, snapshotId: canonical.snapshotId }), canonical);
  assert.deepEqual(createAnalysisSnapshot(JSON.parse(JSON.stringify(canonical))), canonical);
});

for (const patch of [{ binaryId: 'binary-B' }, { projectRevision: '8' }, { analysisEpoch: '12' }, { artifactVersions: { semantic: '3' } }]) {
  test(`a supplied snapshot ID cannot hide changed ${Object.keys(patch)[0]}`, () => {
    const canonical = createAnalysisSnapshot(input);
    assert.notEqual(createAnalysisSnapshot({ ...input, ...patch }).snapshotId, canonical.snapshotId);
    assert.throws(() => createAnalysisSnapshot({ ...input, ...patch, snapshotId: canonical.snapshotId }), /snapshot-identity-mismatch/);
  });
}

test('snapshot defaults, wall-clock independence and exact large revisions are unchanged', () => {
  const canonical = createAnalysisSnapshot(input);
  for (const snapshotId of [null, undefined]) {
    assert.equal(createAnalysisSnapshot({ ...input, snapshotId }).snapshotId, canonical.snapshotId);
  }
  assert.equal(createAnalysisSnapshot({ ...input, createdAt: 'other-time' }).snapshotId, canonical.snapshotId);
  const revision = 9007199254740993n;
  const large = createAnalysisSnapshot({ ...input, projectRevision: revision, analysisEpoch: revision });
  assert.equal(createAnalysisSnapshot({ ...input, projectRevision: String(revision), analysisEpoch: String(revision), snapshotId: large.snapshotId }).snapshotId, large.snapshotId);
  assert.equal(Object.isFrozen(large), true);
});

test('supplied ID validation stays primitive and never invokes coercion', () => {
  let coerced = false;
  for (const snapshotId of ['', ' ', 0, false, ['snapshot'], { toString() { coerced = true; return 'snapshot'; } }]) {
    assert.throws(() => createAnalysisSnapshot({ ...input, snapshotId }), /snapshot-id-required/);
  }
  assert.equal(coerced, false);
});
