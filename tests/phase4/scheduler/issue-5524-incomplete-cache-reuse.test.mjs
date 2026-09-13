import assert from 'node:assert/strict';
import {
  ArtifactStore,
  MemoryArtifactBackend,
  createArtifactDescriptor,
} from '../../../js/core/artifacts/index.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/analysis-scheduler.js';

function descriptor(name) {
  return createArtifactDescriptor({
    binaryId:'bin_phase4_scheduler_5524',
    artifactKind:'phase4-scheduler-incomplete-cache-fixture',
    producerId:'issue-5524-regression',
    producerVersion:'1',
    versions:{ loader:'fixture-1' },
    relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false },
    config:{ name },
  });
}

async function request(scheduler, d, completeness, calls, marker = completeness) {
  return scheduler.request({
    descriptor:d,
    completeness,
    produce:async () => {
      calls.count++;
      return { marker };
    },
  });
}

// A scheduler-produced incomplete artifact is valid cache state. Repeating the
// same requirement must reuse it without re-running the producer, deleting the
// row, or accounting the row as corruption.
for (const cachePath of ['hot', 'cold']) {
  for (const completeness of ['partial', 'bounded', 'truncated', 'unsupported']) {
    const backend = new MemoryArtifactBackend();
    const store = new ArtifactStore({ backend });
    const scheduler = new AnalysisScheduler({ store });
    const d = descriptor(`${cachePath}-${completeness}`);
    const calls = { count:0 };

    const first = await request(scheduler, d, completeness, calls);
    assert.equal(first.reused, false);
    assert.equal(first.record.completeness, completeness);
    if (cachePath === 'cold') store.evictHot(d.artifactId);

    const second = await request(scheduler, d, completeness, calls);
    assert.equal(second.reused, true, `${cachePath} ${completeness} cache entry must be reusable by the same requirement`);
    assert.equal(second.record.completeness, completeness);
    assert.equal(calls.count, 1, `${cachePath} ${completeness} hit must not invoke the producer twice`);
    assert.equal(store.stats().corruptions, 0, `${cachePath} ${completeness} hit must not be corruption`);
    assert.equal(store.stats().backend.deletes, 0, `${cachePath} ${completeness} hit must not delete the valid row`);
    assert.equal(scheduler.stats().cacheHits, 1);
  }
}

// A complete artifact remains strong enough for an incomplete request and must
// preserve the existing warm-cache behavior.
{
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend() });
  const scheduler = new AnalysisScheduler({ store });
  const d = descriptor('complete-satisfies-partial');
  const completeCalls = { count:0 };
  const partialCalls = { count:0 };
  await request(scheduler, d, 'complete', completeCalls, 'complete');
  const result = await request(scheduler, d, 'partial', partialCalls, 'partial');
  assert.equal(result.reused, true);
  assert.equal(result.record.completeness, 'complete');
  assert.equal(completeCalls.count, 1);
  assert.equal(partialCalls.count, 0);
}

// A stricter complete request must not reuse a cached partial result. Preserve
// ArtifactStore's existing strict-read invalidation contract for that mismatch.
{
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend() });
  const scheduler = new AnalysisScheduler({ store });
  const d = descriptor('partial-then-complete');
  const partialCalls = { count:0 };
  const completeCalls = { count:0 };
  await request(scheduler, d, 'partial', partialCalls, 'partial');
  const result = await request(scheduler, d, 'complete', completeCalls, 'complete');
  assert.equal(result.reused, false);
  assert.equal(result.record.completeness, 'complete');
  assert.equal(partialCalls.count, 1);
  assert.equal(completeCalls.count, 1);
  assert.equal(store.stats().corruptions, 1, 'strict complete reads keep the existing artifact-incomplete invalidation contract');
}

// Non-total incomplete states do not satisfy each other (#3813). The scheduler
// must reject the warm mismatch, replace it safely, and never return it as a
// cache hit for the later requirement.
{
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend() });
  const scheduler = new AnalysisScheduler({ store });
  const d = descriptor('partial-then-bounded');
  const partialCalls = { count:0 };
  const boundedCalls = { count:0 };
  await request(scheduler, d, 'partial', partialCalls, 'partial');
  const result = await request(scheduler, d, 'bounded', boundedCalls, 'bounded');
  assert.equal(result.reused, false);
  assert.equal(result.record.completeness, 'bounded');
  assert.equal(result.payload.marker, 'bounded');
  assert.equal(partialCalls.count, 1);
  assert.equal(boundedCalls.count, 1);
  assert.equal(scheduler.stats().cacheHits, 0, 'incompatible incomplete state must not be a scheduler cache hit');
  assert.equal(store.stats().corruptions, 1, 'cross-state replacement keeps the existing strict invalidation path');
}

console.log('issue #5524 scheduler incomplete cache reuse: PASS');
