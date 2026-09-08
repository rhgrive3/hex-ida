// Regression for #5433: the parallel region-scan worker count may only be set
// by a primitive finite number. Structured or boolean values fall back to the
// published default of 2 instead of becoming the authority.
import assert from 'node:assert/strict';
import { fieldAccessAcrossExecutableRegions } from '../../../js/analysis/field-access-artifact.js';

function makeApp() {
  let active = 0;
  let peak = 0;
  const app = {
    store: new Map([['regions', [
      { id: 'r0', exec: true, size: 16n },
      { id: 'r1', exec: true, size: 16n },
      { id: 'r2', exec: true, size: 16n },
      { id: 'r3', exec: true, size: 16n },
      { id: 'r4', exec: true, size: 16n },
    ]]]),
    backend: {
      // The active region (r0) is the fast path and resolves immediately;
      // background regions resolve after a short delay so peak parallelism is
      // observable while every worker stays busy.
      fieldAccess(request) {
        if (request.regionId === 'r0') return Promise.resolve({ results: [], complete: true });
        return new Promise((resolve) => {
          active++;
          peak = Math.max(peak, active);
          setTimeout(() => { active--; resolve({ results: [], complete: true }); }, 40);
        });
      },
    },
    stats: { get peak() { return peak; } },
  };
  return app;
}

async function peakFor(concurrency) {
  const app = makeApp();
  await fieldAccessAcrossExecutableRegions(app, 0n, 4, { concurrency });
  return app.stats.peak;
}

// Structured values fall back to the default 2 workers.
assert.equal(await peakFor(['3']), 2, 'array concurrency must fall back to the default 2');
assert.equal(await peakFor({ workers: 3 }), 2, 'object concurrency must fall back to the default 2');
assert.equal(await peakFor(true), 2, 'boolean concurrency must fall back to the default 2, not Number(true)===1');

// Valid primitive numbers keep the existing 1..3 clamp/floor.
assert.equal(await peakFor(3), 3, 'valid primitive concurrency keeps its clamp');
assert.equal(await peakFor(1), 1, 'valid primitive concurrency keeps its floor');
assert.equal(await peakFor(0), 1, 'zero clamps to the minimum');
assert.equal(await peakFor(undefined), 2, 'the omitted option keeps the default 2');

console.log('issue #5433 field-access concurrency identity regressions PASS');
