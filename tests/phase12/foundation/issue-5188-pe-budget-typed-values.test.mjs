import assert from 'node:assert/strict';
import { createPEMetadataBudget } from '../../../js/binary/pe-loader-core.js';

// #5188 — PE metadata budget limits and take() costs are typed evidence.
// Number() coercion previously let structured values ('16', ['1'], true)
// shrink analysis coverage, and `used[key] + cost[key]` string-concatenated
// malformed costs into the published used counters.

const image = { metadata:{}, warnings:[] };
const budget = createPEMetadataBudget(image, {
  limits: { records:['1'], operations:true, stringBytes:'16' },
});
assert.equal(budget.limits.records, 250000, 'array-valued limit falls back');
assert.equal(budget.limits.operations, 2000000, 'boolean limit falls back');
assert.equal(budget.limits.stringBytes, 16777216, 'string limit falls back');
for (const value of Object.values(budget.limits)) {
  assert.equal(typeof value, 'number');
  assert.ok(Number.isSafeInteger(value) && value > 0);
}

// A malformed cost rejects the take, stops the budget, and keeps the
// counters typed numbers — never '01' string drift.
const strict = createPEMetadataBudget({ metadata:{}, warnings:[] }, {});
assert.equal(strict.take({ records:'1', operations:'1' }), false);
assert.equal(strict.stopped, true);
assert.equal(strict.used.records, 0);
assert.equal(strict.used.operations, 0);

const strictImage = { metadata:{}, warnings:[] };
const strict2 = createPEMetadataBudget(strictImage, {});
strict2.take({ operations: [] }, 'probe');
assert.deepEqual(strictImage.metadata.peMetadata.reasons, ['budget:probe:operations']);
assert.equal(strictImage.warnings[0], 'PE metadata budget exhausted: probe:operations');

// Valid typed costs still account normally.
const ok = createPEMetadataBudget({ metadata:{}, warnings:[] }, { limits:{ records:5, operations:100 } });
assert.equal(ok.take({ records:1, operations:2 }), true);
assert.deepEqual(ok.used, { inputBytes:0, records:1, objects:0, stringBytes:0, operations:2, estimatedHeapBytes:0 });
// A missing cost key stays optional; an explicit typed zero is a no-op.
assert.equal(ok.take({ records:0 }), true);
assert.equal(ok.used.records, 1);
// Exhaustion still trips at the typed limit.
assert.equal(ok.take({ records:10 }), false);
assert.equal(ok.stopped, true);

console.log('pe metadata budget typed limits/costs #5188: PASS');
