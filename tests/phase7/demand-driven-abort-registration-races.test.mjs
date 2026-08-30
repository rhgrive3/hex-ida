import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../js/analysis/demand-driven-runtime.js', import.meta.url), 'utf8');
const waitStart = source.indexOf('function waitForShared(entry, signal)');
const waitEnd = source.indexOf('function mergeMapCounts', waitStart);
const wait = source.slice(waitStart, waitEnd);
assert.match(wait, /addEventListener\('abort', onAbort, \{ once: true \}\);\n    if \(signal\?\.aborted\) \{ onAbort\(\); return; \}\n    entry\.promise\.then/);

const scheduleStart = source.indexOf('function scheduleBackgroundIdentity(signal)');
const scheduleEnd = source.indexOf('function installWorkerBackedIdentity', scheduleStart);
const schedule = source.slice(scheduleStart, scheduleEnd);
assert.match(schedule, /addEventListener\('abort', onAbort, \{ once:true \}\);\n    if \(signal\?\.aborted\) \{ onAbort\(\); return; \}\n    if \(typeof requestIdleCallback/);

const shapesStart = source.indexOf('function installMultiRegionShapes(app)');
const shapesEnd = source.indexOf('function installCancellableFunctionDiscovery', shapesStart);
const shapes = source.slice(shapesStart, shapesEnd);
assert.match(shapes, /const onAbort = \(\) => \{ signal\?\.removeEventListener\('abort', onAbort\); request\.cancel\?\.\(\); reject\(abortError\(signal\)\); \};/);
assert.match(shapes, /addEventListener\('abort', onAbort, \{ once:true \}\);\n              if \(signal\?\.aborted\) \{ onAbort\(\); return; \}\n              Promise\.resolve\(request\)/);

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
