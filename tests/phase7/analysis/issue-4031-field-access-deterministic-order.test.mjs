// Regression for #4031: field-access aggregate order must follow canonical
// region order, not the completion order of parallel backend requests.
import assert from 'node:assert/strict';
import { fieldAccessAcrossExecutableRegions, clearFieldAccessArtifacts } from '../../../js/analysis/field-access-artifact.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  promise.cancel = () => {};
  return { promise, resolve };
}

async function runWithCompletionOrder(order, { concurrency = 2, incomplete = null } = {}) {
  const pending = new Map();
  const started = [];
  let releaseStarted;
  const allStarted = new Promise((resolve) => { releaseStarted = resolve; });
  const regions = ['r0', 'r1', 'r2'].map((id) => ({ id, exec:true, size:16n }));
  const backend = {
    fieldAccess({ regionId }) {
      if (regionId === 'r0') {
        return Promise.resolve({
          results:[{ row:'r0-a' }, { row:'r0-b' }],
          complete:incomplete !== 'r0',
          reason:incomplete === 'r0' ? 'r0-partial' : null,
        });
      }
      const d = deferred();
      pending.set(regionId, d);
      started.push(regionId);
      if (started.length === 2) releaseStarted();
      return d.promise;
    },
  };
  const app = {
    backend,
    codeRegion:() => regions[0],
    store:new Map([['regions', regions]]),
  };
  const partials = [];
  const resultPromise = fieldAccessAcrossExecutableRegions(app, 0n, 4, {
    concurrency,
    onPartial:(value) => partials.push(value),
  });

  if (concurrency > 1) {
    await allStarted;
    for (const id of order) {
      pending.get(id).resolve({
        results:[{ row:`${id}-a` }, { row:`${id}-b` }],
        complete:incomplete !== id,
        reason:incomplete === id ? `${id}-partial` : null,
      });
      await Promise.resolve();
    }
  } else {
    // With one worker, r2 is not requested until r1 settles.
    while (!pending.has('r1')) await Promise.resolve();
    pending.get('r1').resolve({ results:[{ row:'r1-a' }, { row:'r1-b' }], complete:true });
    while (!pending.has('r2')) await Promise.resolve();
    pending.get('r2').resolve({ results:[{ row:'r2-a' }, { row:'r2-b' }], complete:true });
  }

  const result = await resultPromise;
  clearFieldAccessArtifacts(backend);
  return { result, partials };
}

const expectedRows = ['r0-a', 'r0-b', 'r1-a', 'r1-b', 'r2-a', 'r2-b'];

{
  const slowR1 = await runWithCompletionOrder(['r2', 'r1']);
  assert.deepEqual(slowR1.result.results.map((row) => row.row), expectedRows,
    'final results follow region order even when r2 completes before r1');
  assert.deepEqual(slowR1.result.scannedRegionIds, ['r0', 'r1', 'r2']);
  assert.deepEqual(slowR1.partials.at(-1).results.map((row) => row.row), expectedRows,
    'the partial publication for the same completed set is deterministic');
  assert.deepEqual(slowR1.partials.at(-1).scannedRegionIds, ['r0', 'r1', 'r2']);
}

{
  const slowR2 = await runWithCompletionOrder(['r1', 'r2']);
  assert.deepEqual(slowR2.result.results.map((row) => row.row), expectedRows);
  assert.deepEqual(slowR2.result.scannedRegionIds, ['r0', 'r1', 'r2']);
}

{
  const serial = await runWithCompletionOrder([], { concurrency:1 });
  assert.deepEqual(serial.result.results.map((row) => row.row), expectedRows,
    'concurrency must not change final artifact order');
  assert.deepEqual(serial.result.scannedRegionIds, ['r0', 'r1', 'r2']);
}

{
  const parallel3 = await runWithCompletionOrder(['r2', 'r1'], { concurrency:3 });
  assert.deepEqual(parallel3.result.results.map((row) => row.row), expectedRows,
    'concurrency=3 keeps the same deterministic artifact order');
  assert.deepEqual(parallel3.result.scannedRegionIds, ['r0', 'r1', 'r2']);
}

{
  const incomplete = await runWithCompletionOrder(['r2', 'r1'], { concurrency:2, incomplete:'r1' });
  assert.equal(incomplete.result.complete, false, 'source incompleteness remains fail-closed');
  assert.equal(incomplete.result.reason, 'r1-partial');
  assert.deepEqual(incomplete.result.unscannedRegionIds, []);
  assert.deepEqual(incomplete.result.results.map((row) => row.row), expectedRows,
    'incomplete source metadata must not reintroduce completion-order result ordering');
}

{
  // Preserve the pre-existing Map/Set collapse semantics if malformed input
  // contains a duplicate region id: canonical ordering must not duplicate rows.
  let r1Calls = 0;
  const regions = [
    { id:'r0', exec:true, size:16n },
    { id:'r1', exec:true, size:16n },
    { id:'r1', exec:true, size:16n },
  ];
  const backend = {
    fieldAccess({ regionId }) {
      if (regionId === 'r0') return Promise.resolve({ results:[{ row:'r0' }], complete:true });
      r1Calls++;
      return Promise.resolve({ results:[{ row:`r1-${r1Calls}` }], complete:true });
    },
  };
  const app = { backend, codeRegion:() => regions[0], store:new Map([['regions', regions]]) };
  const result = await fieldAccessAcrossExecutableRegions(app, 0n, 4, { concurrency:1 });
  assert.deepEqual(result.scannedRegionIds, ['r0', 'r1']);
  assert.deepEqual(result.results.map((row) => row.row), ['r0', 'r1-2']);
  clearFieldAccessArtifacts(backend);
}

console.log('issue #4031 field-access deterministic ordering regressions PASS');
