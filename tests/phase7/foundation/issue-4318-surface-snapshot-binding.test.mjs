import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalysisSurface } from '../../../js/analysis/index.js';
import { buildFixture } from '../corpus/fixtures.mjs';

function surface(options = {}) {
  const built = buildFixture('stack-disjoint');
  return createAnalysisSurface({
    ir: built.ir, cfg: built.cfg, ssa: built.ssa, memorySsa: built.memorySsa,
    snapshotId: 'snapshot-A', resolveRegion: built.resolveRegion,
    options: { snapshotId: 'snapshot-B', ...options },
  });
}

test('construction options cannot relabel the cached local summary', () => {
  const s = surface();
  const result = s.functionSummary();
  assert.equal(s.snapshotId, 'snapshot-A');
  assert.equal(result.status.snapshotId, 'snapshot-A');
  assert.equal(result.summary.status.snapshotId, 'snapshot-A');
  assert.strictEqual(s.functionSummary(), result);
});

test('per-query options cannot relabel an uncached summary', () => {
  const s = surface();
  const result = s.functionSummary({ snapshotId: 'snapshot-C' });
  assert.equal(result.status.snapshotId, 'snapshot-A');
  assert.equal(result.summary.status.snapshotId, 'snapshot-A');
});

test('escape analysis and memory effects retain the surface snapshot', () => {
  const s = surface();
  const escape = s.escape();
  assert.notEqual(escape.status.stopReason, 'dependency-missing', 'exercise analyzeEscape, not the surface fallback');
  assert.equal(escape.status.snapshotId, 'snapshot-A');
  assert.equal(s.memoryEffects().status.snapshotId, 'snapshot-A');
});

test('surface-bound resolver cannot be replaced by tuning options', () => {
  const wrongResolver = () => assert.fail('unbound resolver must not run');
  const s = surface({ resolveRegion: wrongResolver });
  const a = s.functionSummary();
  const b = s.functionSummary({ resolveRegion: wrongResolver });
  assert.equal(a.summary.memoryWriteRegions.length, 2);
  assert.deepEqual(b.summary.memoryWriteRegions, a.summary.memoryWriteRegions);
});

test('query-local cancellation still works without changing the snapshot or cache', () => {
  const s = surface();
  const live = s.functionSummary();
  const controller = new AbortController();
  controller.abort();
  const cancelled = s.functionSummary({ snapshotId: 'snapshot-C', signal: controller.signal });
  assert.equal(cancelled.summary, null);
  assert.equal(cancelled.status.stopReason, 'cancelled');
  assert.equal(cancelled.status.snapshotId, 'snapshot-A');
  assert.strictEqual(s.functionSummary(), live);
});
