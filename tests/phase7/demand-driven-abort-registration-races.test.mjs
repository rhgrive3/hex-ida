import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../js/analysis/demand-driven-runtime.js', import.meta.url), 'utf8');
const waitStart = source.indexOf('function waitForShared(entry, signal)');
const waitEnd = source.indexOf('function mergeMapCounts', waitStart);
const wait = source.slice(waitStart, waitEnd);
assert.match(wait, /addEventListener\('abort', onAbort, \{ once: true \}\);\n    entry\.promise\.then/);
assert.match(wait, /if \(signal\?\.aborted && !settled\) onAbort\(\);/);
assert.match(wait, /if \(!entry\.settled && entry\.waiters === 0\) \{\n        entry\.cancelled = true;\n        entry\.cancel\?\.\(\);/);

const scheduleStart = source.indexOf('function scheduleBackgroundIdentity(signal)');
const scheduleEnd = source.indexOf('function installWorkerBackedIdentity', scheduleStart);
const schedule = source.slice(scheduleStart, scheduleEnd);
assert.match(schedule, /addEventListener\('abort', onAbort, \{ once:true \}\);\n    if \(signal\?\.aborted\) \{ onAbort\(\); return; \}\n    if \(typeof requestIdleCallback/);

const shapesStart = source.indexOf('function installMultiRegionShapes(app)');
const shapesEnd = source.indexOf('function installCancellableFunctionDiscovery', shapesStart);
const shapes = source.slice(shapesStart, shapesEnd);
// The shared shapes producer must not capture the creating consumer's signal:
// per-consumer waits delegate to waitForShared so one consumer's abort cannot
// cancel the producer out from under the remaining waiters (#5266/#5320/#5334).
assert.match(shapes, /if \(app\.shapesBusy && app\.shapesBusyEpoch === epoch && !app\.shapesBusy\.cancelled\) return waitForShared\(app\.shapesBusy, signal\);/);
assert.match(shapes, /promise:null, settled:false, cancelled:false, waiters:0,/);
assert.match(shapes, /finally\(\(\) => \{ if \(app\.shapesBusy === entry\) \{ app\.shapesBusy = null; app\.shapesBusyEpoch = -1; \} \}\);/);
assert.match(shapes, /return waitForShared\(entry, signal\);/);
assert.doesNotMatch(shapes, /return app\.shapesBusy;/);
assert.doesNotMatch(shapes, /reject\(abortError\(signal\)\)/);
// Producer-side abort wiring keeps the same registration-race discipline the
// old consumer-captured wiring had: once:true listener plus a synchronous
// aborted recheck driving the same handler, so an abort landing between
// backend request creation and listener registration still cancels it.
assert.match(shapes, /const onAbort = \(\) => request\.cancel\?\.\(\);/);
assert.match(shapes, /producerController\.signal\.addEventListener\('abort', onAbort, \{ once:true \}\);\n          if \(producerController\.signal\.aborted\) request\.cancel\?\.\(\);/);
assert.match(shapes, /const onProducerAbort = \(\) => \{ producerController\.signal\.removeEventListener\('abort', onProducerAbort\); reject\(abortError\(producerController\.signal\)\); \};/);
assert.match(shapes, /producerController\.signal\.addEventListener\('abort', onProducerAbort, \{ once:true \}\);\n              if \(producerController\.signal\.aborted\) \{ onProducerAbort\(\); return; \}/);

// Model the registration-edge behavior with a signal that becomes aborted
// synchronously during listener registration. A post-registration recheck
// must observe it and invoke the same abort handler exactly once.
let abortedCalls = 0;
const signal = {
  aborted:false,
  addEventListener(_type, _listener) { this.aborted = true; },
  removeEventListener() {},
};
const onAbort = () => { abortedCalls++; };
signal.addEventListener('abort', onAbort, { once:true });
if (signal.aborted) onAbort();
assert.equal(abortedCalls, 1);

console.log('demand-driven abort registration race tests passed');
