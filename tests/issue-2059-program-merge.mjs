import assert from 'node:assert/strict';

import { KIND, mergeProgramScans } from '../js/program.js';

const scan = {
  regionId:'text',
  vmAddr:0x1000n,
  words:1,
  kinds:new Uint8Array([KIND.RET]),
  kindsCovered:1,
  callFrom:new BigUint64Array(0),
  callTo:new BigUint64Array(0),
  refFrom:new BigUint64Array(0),
  refTo:new BigUint64Array(0),
  refKind:new Uint8Array(0),
  completeness:{ complete:true, reasons:[] },
};

const inferred = mergeProgramScans([scan]);
assert.equal(inferred.complete, true);
assert.equal(inferred.truncated, false);
assert.deepEqual(inferred.completeness.reasons, []);
assert.equal(inferred.completeness.regionCount, 1);
assert.equal(inferred.completeness.expectedRegionCount, null);

const expected = mergeProgramScans([scan], {
  regions:[{ id:'text', vmAddr:0x1000n, size:4n }],
});
assert.equal(expected.complete, true);
assert.equal(expected.completeness.expectedRegionCount, 1);

const missing = mergeProgramScans([scan], {
  regions:[
    { id:'text', vmAddr:0x1000n, size:4n },
    { id:'cold', vmAddr:0x2000n, size:4n },
  ],
});
assert.equal(missing.complete, false);
assert.ok(missing.completeness.reasons.includes('program-region-unscanned:cold'));

console.log('issue #2059 program merge completeness regressions passed');
