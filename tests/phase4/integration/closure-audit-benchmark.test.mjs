import assert from 'node:assert/strict';
import { runClosureAuditBenchmark } from '../../../tools/benchmarks/closure-audit-final-20260831.mjs';

const metrics = runClosureAuditBenchmark();
assert.equal(metrics.localQuery.totalRegions, 512);
assert.equal(metrics.localQuery.calleesRegionsBeforeFirstPage, 1);
assert.equal(metrics.localQuery.xrefsRegionsBeforeFirstPage, 2);
assert.equal(metrics.localQuery.xrefsUnscannedRegions, 510);
assert.equal(metrics.recognition.denominatorFunctions, 350000);
assert.equal(metrics.recognition.ordinaryOpenRecognitionStarts, 0);
assert.deepEqual(metrics.binaryIdentity.fixtureSizes, [100,500,1024].map((m) => m * 1024 * 1024));
assert.equal(metrics.diffBaseline.denominatorFunctions, 350000);
assert.equal(metrics.diffBaseline.mainRealmFunctionObjectsAllocated, 0);

console.log('closure audit synthetic benchmark contract: PASS', JSON.stringify(metrics));
