import assert from 'node:assert/strict';
import { createResourceBudget, assertBudgetComplete } from '../../../js/phase12/resource-budget.js';

const controller = new AbortController();
const budget = createResourceBudget({ signal: controller.signal });
controller.abort(new Error('test-cancel'));

assert.equal(budget.checkpoint(), false);
assert.equal(budget.stopped?.status, 'partial');
assert.equal(budget.stopped?.reason, 'cancelled');
assert.throws(
  () => assertBudgetComplete(budget),
  (error) => error?.code === 'phase12-resource-limit' && error?.reason === 'cancelled',
);

const live = createResourceBudget();
assert.equal(live.checkpoint(), true);
assert.equal(live.stopped, null);
assert.equal(assertBudgetComplete(live), true);

console.log('phase12 resource budget cancellation: ok');

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxNodes: 100_000,
  maxEntries: 100_000,
  maxWork: 1_000_000,
  maxDepth: 128,
  maxOutputBytes: 8 * 1024 * 1024,
});

let coercionCalls = 0;
const customCoercion = {
  valueOf() {
    coercionCalls++;
    return 1;
  },
};
const malformedLimits = [
  ['structured', { value: 1 }],
  ['string', '1'],
  ['boolean', true],
  ['array', ['1']],
  ['boxed-number', new Number(1)],
  ['custom-coercion', customCoercion],
  ['symbol', Symbol('limit')],
  ['bigint', 1n],
  ['zero', 0],
  ['negative', -1],
  ['fraction', 1.5],
  ['nan', Number.NaN],
  ['infinity', Number.POSITIVE_INFINITY],
];

for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
  for (const [label, value] of malformedLimits) {
    const candidate = createResourceBudget({ [name]: value });
    assert.equal(candidate.limits[name], fallback, `invalid ${name} ${label} must use its fallback`);
  }
}
assert.equal(coercionCalls, 0, 'invalid limits must not invoke user coercion hooks');

const CONSUMERS = [
  ['consumeBytes', 'bytes', 'resource-limit-bytes'],
  ['consumeNodes', 'nodes', 'resource-limit-nodes'],
  ['consumeEntries', 'entries', 'resource-limit-entries'],
  ['consumeWork', 'work', 'resource-limit-work'],
  ['consumeOutputBytes', 'outputBytes', 'resource-limit-output'],
];
const malformedAmounts = [
  ['structured', { value: 1 }],
  ['string', '1'],
  ['boolean', true],
  ['array', ['1']],
  ['boxed-number', new Number(1)],
  ['custom-coercion', customCoercion],
  ['symbol', Symbol('amount')],
  ['bigint', 1n],
  ['negative', -1],
  ['fraction', 1.5],
  ['nan', Number.NaN],
  ['infinity', Number.POSITIVE_INFINITY],
];

for (const [method, usageKey, reason] of CONSUMERS) {
  for (const [label, amount] of malformedAmounts) {
    const candidate = createResourceBudget();
    assert.equal(candidate[method](amount), false, `invalid ${method} ${label} must stop`);
    assert.equal(candidate.stopped?.status, 'partial');
    assert.equal(candidate.stopped?.reason, reason);
    assert.equal(candidate.snapshot().usage[usageKey], 0);
    assert.equal(candidate[method](0), false, 'an invalid amount must leave the budget stopped');
    assert.doesNotThrow(() => JSON.stringify(candidate.snapshot()), 'stop details stay JSON-safe');
  }
}
assert.equal(coercionCalls, 0, 'invalid amounts must not invoke user coercion hooks');

for (const [method, usageKey, reason] of CONSUMERS) {
  const limitKey = {
    bytes: 'maxBytes',
    nodes: 'maxNodes',
    entries: 'maxEntries',
    work: 'maxWork',
    outputBytes: 'maxOutputBytes',
  }[usageKey];
  const candidate = createResourceBudget({ [limitKey]: 2 });
  assert.equal(candidate[method](0), true, `${method} accepts a zero amount`);
  assert.equal(candidate.snapshot().usage[usageKey], 0);
  assert.equal(candidate[method](1), true);
  assert.equal(candidate[method](1), true);
  assert.equal(candidate.snapshot().usage[usageKey], 2);
  assert.equal(candidate[method](1), false);
  assert.equal(candidate.stopped?.reason, reason);
}

for (const [method, limitKey] of [
  ['consumeNodes', 'maxNodes'],
  ['consumeEntries', 'maxEntries'],
  ['consumeWork', 'maxWork'],
]) {
  const candidate = createResourceBudget({ [limitKey]: 1 });
  assert.equal(candidate[method](), true, `${method} keeps its default unit amount`);
}

const depth = createResourceBudget({ maxDepth: 2 });
assert.equal(depth.checkDepth(0), true);
assert.equal(depth.checkDepth(2), true);
assert.equal(depth.checkDepth(3), false);
assert.equal(depth.stopped?.reason, 'resource-limit-depth');
assert.equal(depth.checkDepth(0), false, 'depth limit stops subsequent checks');

for (const [label, value] of malformedAmounts) {
  const candidate = createResourceBudget({ maxDepth: 2 });
  assert.equal(candidate.checkDepth(value), false, `invalid depth ${label} must stop`);
  assert.equal(candidate.stopped?.reason, 'resource-limit-depth');
  assert.equal(candidate.checkDepth(0), false);
  assert.doesNotThrow(() => JSON.stringify(candidate.snapshot()), 'depth stop details stay JSON-safe');
}

console.log('phase12 resource budget typed numeric contract: ok');
