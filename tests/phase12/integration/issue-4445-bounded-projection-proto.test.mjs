import assert from 'node:assert/strict';
import { boundedProjection, projectBounded, projectDetail, projectSearch } from '../../../js/ai/tools/projections/index.js';
import { jsonSafe } from '../../../js/ai/validation.js';
function hostileResult() { return JSON.parse('{"safe":1,"__proto__":{"injected":"yes"},"nested":{"__proto__":{"nestedInjected":true},"value":2}}'); }
function assertSafeProjection(value, label) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype, `${label} keeps the ordinary safe prototype`);
  assert.equal(Object.hasOwn(value, '__proto__'), true, `${label} preserves __proto__ as data`);
  assert.deepEqual(value.__proto__, { injected: 'yes' });
  assert.equal(value.injected, undefined);
  assert.equal(Object.getPrototypeOf(value.nested), Object.prototype);
  assert.equal(Object.hasOwn(value.nested, '__proto__'), true);
  assert.deepEqual(value.nested.__proto__, { nestedInjected: true });
  assert.equal(value.nested.nestedInjected, undefined);
}
assert.equal(Object.prototype.injected, undefined);
assertSafeProjection(boundedProjection(hostileResult()), 'boundedProjection');
assertSafeProjection(projectBounded(hostileResult()), 'projectBounded');
assertSafeProjection(jsonSafe(projectBounded(hostileResult())), 'jsonSafe(projectBounded)');
assertSafeProjection(projectSearch({ results: [hostileResult()] }).results[0], 'projectSearch');
assertSafeProjection(projectDetail({ record: hostileResult() }).record, 'projectDetail.record');
assert.equal(Object.prototype.injected, undefined);
console.log('issue-4445 bounded projection prototype safety tests passed');
