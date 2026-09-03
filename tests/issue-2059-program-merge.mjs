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

// #3416: a cancelled regional scan is evidence that the aggregate is
// incomplete. It must not disappear just because cancelled scans contribute no
// edges/kinds to the merged payload.
const cancelledScan = {
  ...scan,
  regionId:'cold',
  vmAddr:0x2000n,
  cancelled:true,
};
const cancelled = mergeProgramScans([scan, cancelledScan]);
assert.equal(cancelled.complete, false);
assert.equal(cancelled.truncated, true);
assert.ok(cancelled.completeness.reasons.includes('cold:cancelled'));
assert.equal(cancelled.completeness.regionCount, 1, 'cancelled scan is not counted as successfully scanned');

// The expected-region route remains fail-closed for the same cancellation and
// retains the existing unscanned-region evidence in addition to cancellation.
const cancelledExpected = mergeProgramScans([scan, cancelledScan], {
  regions:[
    { id:'text', vmAddr:0x1000n, size:4n },
    { id:'cold', vmAddr:0x2000n, size:4n },
  ],
});
assert.equal(cancelledExpected.complete, false);
assert.ok(cancelledExpected.completeness.reasons.includes('cold:cancelled'));
assert.ok(cancelledExpected.completeness.reasons.includes('program-region-unscanned:cold'));

// #4546: expected regions with id:null must match actual address range rather than relying solely on counts.
const anonymousExpectedMismatch = mergeProgramScans([scan], {
  regions:[{ id:null, vmAddr:0n, size:4n }],
});
assert.equal(anonymousExpectedMismatch.complete, false, '#4546: mismatched anonymous address must not be complete');
assert.ok(anonymousExpectedMismatch.completeness.reasons.some((r) => r.startsWith('program-region-unscanned:')));

const anonymousExpectedMatch = mergeProgramScans([scan], {
  regions:[{ id:null, vmAddr:0x1000n, size:4n }],
});
assert.equal(anonymousExpectedMatch.complete, true, '#4546: matching anonymous address must be complete');

// #4934: structured / boolean / string values in options.limits must not coerce to numbers.
const scanWithEdges = {
  ...scan,
  callCount: 10,
  callFrom: new BigUint64Array(10),
  callTo: new BigUint64Array(10),
  refCount: 10,
  refFrom: new BigUint64Array(10),
  refTo: new BigUint64Array(10),
  refKind: new Uint8Array(10),
};
const structuredLimits = mergeProgramScans([scanWithEdges], {
  limits: {
    calls: true,
    refs: ['2'],
    kindWords: '3',
  },
});
assert.equal(structuredLimits.completeness.limits.calls, 10, '#4934: calls:true must fallback to default limits and retain available edges');
assert.equal(structuredLimits.completeness.limits.refs, 10, '#4934: refs:["2"] must fallback to default limits and retain available edges');
assert.equal(structuredLimits.completeness.limits.kindWords, 16 * 1024 * 1024, '#4934: kindWords:"3" must fallback to default');

const validLimits = mergeProgramScans([scanWithEdges], {
  limits: {
    calls: 5,
    refs: 5,
    kindWords: 100,
  },
});
assert.equal(validLimits.completeness.limits.calls, 5, '#4934: safe integer limits are respected');
assert.equal(validLimits.completeness.limits.refs, 5, '#4934: safe integer limits are respected');

console.log('issue #2059/#3416/#4546/#4934 program merge completeness regressions passed');
