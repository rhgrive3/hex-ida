import assert from 'node:assert/strict';
import { classifyFeaturesAndEngineAsync } from '../js/features.js';

// #4760: a truthy-but-non-numeric options.chunkSize ({} / ['bad'] / 'bad' /
// new Number(NaN)) used to fall through `options.chunkSize || 1000` and then
// poison Math.min/Math.max into NaN. Because `i % NaN === 0` is never true, the
// async classifier stopped yielding to the event loop entirely: onProgress never
// fired and an event-loop AbortSignal could not be observed mid-scan.
//
// Expected: chunkSize only enters the existing 100..5000 clamp when it is a
// primitive finite number; anything else fails closed to the default 1000.

function corpus(total, unityIndex) {
  return Array.from({ length: total }, (_, i) => ({
    addr: BigInt(i),
    text: i === unityIndex ? 'UnityEngine purchase payment' : 'ordinary noise text',
  }));
}

async function yieldCount(chunkSize, total = 3000) {
  let done = 0;
  await classifyFeaturesAndEngineAsync(corpus(total, total - 1), {
    chunkSize,
    onProgress() { done++; },
  });
  return done;
}

// 1. Malformed truthy chunkSize must still yield at every 1000-item boundary,
//    i.e. it must fail closed to the default 1000 rather than become NaN.
const defaultYields = await yieldCount(1000);
assert.ok(defaultYields > 0, 'baseline default chunkSize must yield to the event loop');
for (const bad of [{}, ['bad'], 'bad', new Number(NaN)]) {
  const yields = await yieldCount(bad);
  assert.equal(yields, defaultYields,
    `malformed chunkSize ${JSON.stringify(String(bad))} must fail closed to the default yield cadence`);
}

// 2. Valid finite numbers keep the existing 100..5000 clamp (low and high).
assert.equal(await yieldCount(50, 250), await yieldCount(100, 250),
  'chunkSize below the floor must clamp to 100');
assert.equal(await yieldCount(100, 250), 2, 'clamped 100 must yield at i=100 and i=200 for 250 items');
assert.equal(await yieldCount(99999, 6000), await yieldCount(5000, 6000),
  'chunkSize above the ceiling must clamp to 5000');
assert.equal(await yieldCount(5000, 6000), 1, 'clamped 5000 must yield once for 6000 items');

// 3. Mid-loop cancellation must be observable across a restored yield boundary:
//    aborting inside onProgress stops the scan before the trailing engine token.
const ac = new AbortController();
let progressFires = 0;
const cancelled = await classifyFeaturesAndEngineAsync(corpus(5000, 4999), {
  chunkSize: {},
  signal: ac.signal,
  onProgress() {
    progressFires++;
    ac.abort();
  },
});
assert.equal(progressFires, 1, 'cancellation must be observed at the first restored yield boundary');
assert.equal(cancelled.engine, null, 'a mid-loop abort must stop before the trailing engine token');
assert.ok(!cancelled.features.some((f) => f.items.some((it) => it.addr === 4999n)),
  'a cancelled scan must not classify strings past the abort point');

// 4. Classification results themselves are unchanged by the fix: malformed and
//    default chunkSize both run to completion and agree exactly.
const withMalformed = await classifyFeaturesAndEngineAsync(corpus(3000, 2999), { chunkSize: {} });
const withDefault = await classifyFeaturesAndEngineAsync(corpus(3000, 2999), { chunkSize: 1000 });
assert.equal(withMalformed.engine?.id, 'unity');
assert.equal(withDefault.engine?.id, 'unity');
assert.deepEqual(
  withMalformed.features.map((f) => [f.id, f.items.length]),
  withDefault.features.map((f) => [f.id, f.items.length]),
  'fail-closed chunkSize must not change feature/engine classification',
);

console.log('issue-4760-features-chunksize-nan-yield: ok');
