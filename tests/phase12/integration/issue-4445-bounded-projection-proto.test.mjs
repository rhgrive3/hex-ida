import assert from 'node:assert/strict';

import {
  boundedProjection,
  projectBounded,
  projectDetail,
  projectSearch,
} from '../../../js/ai/tools/projections/index.js';
import { jsonSafe } from '../../../js/ai/validation.js';

function hostileResult() {
  return JSON.parse('{"safe":1,"__proto__":{"injected":"yes"},"nested":{"__proto__":{"nestedInjected":true},"value":2}}');
}

function assertSafeProjection(value, label) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype, `${label} keeps the ordinary safe prototype`);
  assert.equal(Object.hasOwn(value, '__proto__'), true, `${label} preserves __proto__ as data`);
  assert.deepEqual(value.__proto__, { injected: 'yes' }, `${label} keeps the input data value`);
  assert.equal(value.injected, undefined, `${label} has no inherited attacker value`);
  assert.equal(Object.getPrototypeOf(value.nested), Object.prototype, `${label} nested prototype stays safe`);
  assert.equal(Object.hasOwn(value.nested, '__proto__'), true, `${label} nested __proto__ stays data`);
  assert.deepEqual(value.nested.__proto__, { nestedInjected: true }, `${label} keeps nested data`);
  assert.equal(value.nested.nestedInjected, undefined, `${label} has no nested inherited attacker value`);
}

assert.equal(Object.prototype.injected, undefined, 'the global prototype is clean before the projection');
assertSafeProjection(boundedProjection(hostileResult()), 'boundedProjection');
assertSafeProjection(projectBounded(hostileResult()), 'projectBounded');
assertSafeProjection(jsonSafe(projectBounded(hostileResult())), 'jsonSafe(projectBounded)');
assertSafeProjection(projectSearch({ results: [hostileResult()] }).results[0], 'projectSearch');

const detail = projectDetail({ record: hostileResult() });
assertSafeProjection(detail.record, 'projectDetail.record');
assert.equal(Object.prototype.injected, undefined, 'projection never mutates Object.prototype');

console.log('issue-4445 bounded projection prototype safety tests passed');
