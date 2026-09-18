import assert from 'node:assert/strict';
import { classifyString } from '../js/features.js';
import { classifyFeaturesAndEngineAsync } from '../js/features.js';

const N = 2500;
const DEFAULT_CHUNK = 1000;
const MARKER_INDEX = 2400;

function corpus(markerIndex = -1) {
  return Array.from({ length: N }, (_, i) => ({
    addr: BigInt(i),
    text: i === markerIndex ? 'login account password' : `zz${i}`,
  }));
}

for (let i = 0; i < N; i++) {
  assert.deepEqual(classifyString(`zz${i}`), [], `filler zz${i} must not carry feature evidence`);
}
assert.deepEqual(classifyString('login account password').map((h) => h.id), ['login']);

// AC1/AC2/AC4: a truthy-but-non-numeric chunkSize must not collapse the internal
// chunk to NaN; it must fall back to the default 1000 chunk and keep yielding.
for (const malformed of [{}, ['bad'], new Number(NaN)]) {
  const label = Array.isArray(malformed) ? "['bad']" : Object.prototype.toString.call(malformed);
  let progress = 0;
  const result = await classifyFeaturesAndEngineAsync(corpus(MARKER_INDEX), {
    chunkSize: malformed,
    onProgress: () => { progress++; },
  });
  assert.ok(progress > 0,
    `truthy malformed chunkSize ${label} must fall back to the default 1000 chunk, not NaN`);
  assert.equal(result.count, N, `classification of ${label} must still cover every string`);
  assert.ok(result.features.some((f) => f.id === 'login'),
    `a full ${label} scan must retain the late marker's feature evidence`);
}

// AC4: the async contract is an event-loop yield per chunk. A malformed value must
// still return control to the event loop, provable by an external timer that only
// runs if the classification loop awaits somewhere in the middle.
for (const malformed of [{}, ['bad'], new Number(NaN)]) {
  const label = Array.isArray(malformed) ? "['bad']" : Object.prototype.toString.call(malformed);
  let yielded = false;
  const probe = setTimeout(() => { yielded = true; }, 0);
  await classifyFeaturesAndEngineAsync(corpus(), { chunkSize: malformed });
  clearTimeout(probe);
  assert.ok(yielded,
    `malformed chunkSize ${label} must yield to the event loop at chunk boundaries`);
}

// AC5: an AbortSignal raised across a chunk yield must be observed before the next
// chunk, stopping the scan so a late marker is never classified.
for (const malformed of [{}, ['bad'], new Number(NaN)]) {
  const label = Array.isArray(malformed) ? "['bad']" : Object.prototype.toString.call(malformed);
  const controller = new AbortController();
  let progress = 0;
  const result = await classifyFeaturesAndEngineAsync(corpus(MARKER_INDEX), {
    chunkSize: malformed,
    signal: controller.signal,
    onProgress() { progress++; if (progress === 1) controller.abort(); },
  });
  assert.equal(progress, 1,
    `abort at the first ${label} boundary must stop before a second boundary is reached`);
  assert.ok(!result.features.some((f) => f.id === 'login'),
    `a cancel observed during a ${label} yield must stop the scan before the late marker`);
}

// AC1/AC2: non-finite primitive numbers must fall back to the default too, keeping yields.
for (const nonFinite of [NaN, Infinity, -Infinity]) {
  let progress = 0;
  await classifyFeaturesAndEngineAsync(corpus(), { chunkSize: nonFinite, onProgress: () => { progress++; } });
  assert.ok(progress > 0,
    `non-finite chunkSize ${String(nonFinite)} must not remove per-chunk yields`);
}

// AC3: valid finite numbers keep the existing 100..5000 clamp and floor behavior.
{
  const items = Array.from({ length: 250 }, (_, i) => ({ addr: BigInt(i), text: `zz${i}` }));
  let lower = 0;
  await classifyFeaturesAndEngineAsync(items, { chunkSize: 5, onProgress: () => { lower++; } });
  assert.equal(lower, 2, 'chunkSize below 100 must clamp up to 100 (boundaries at 100,200)');

  let upper = 0;
  await classifyFeaturesAndEngineAsync(items, { chunkSize: 100000, onProgress: () => { upper++; } });
  assert.equal(upper, 0, 'chunkSize above 5000 must clamp down to 5000 (no boundary within 250)');

  let exact = 0;
  await classifyFeaturesAndEngineAsync(corpus(), { chunkSize: DEFAULT_CHUNK, onProgress: () => { exact++; } });
  assert.equal(exact, 2, 'valid chunkSize 1000 must keep boundaries at 1000 and 2000');
}

// AC3: a finite fractional request must floor to an integer chunk and keep yielding.
{
  let progress = 0;
  await classifyFeaturesAndEngineAsync(corpus(), { chunkSize: 1000.5, onProgress: () => { progress++; } });
  assert.equal(progress, 2, 'fractional chunkSize must floor to 1000 and yield at 1000,2000');
}

// AC6: the chunkSize value must never change the classification result itself.
{
  const items = corpus(MARKER_INDEX);
  const valid = await classifyFeaturesAndEngineAsync(items, { chunkSize: DEFAULT_CHUNK });
  const malformed = await classifyFeaturesAndEngineAsync(items, { chunkSize: {} });
  assert.deepEqual(malformed, valid, 'malformed chunkSize must not change feature/engine results');
}

console.log('issue-4760 async chunkSize finite-number fallback regressions: PASS');
