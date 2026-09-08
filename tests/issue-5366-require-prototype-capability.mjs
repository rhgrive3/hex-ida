// Regression for #5366: DebugAdapter.require() decided capability support with
// a bare property access on a plain-object capability map, so any name
// inherited truthy from Object.prototype ('__proto__', 'toString',
// 'constructor', …) passed the guard even though it is not a real capability.
// Contract now: require() only admits names in the finite DEBUG_CAPABILITIES
// set whose canonical value is exactly true; every other name — including
// prototype-inherited ones — fails closed with DebugAdapterError('unsupported').
import assert from 'node:assert/strict';
import { DebugAdapter, DEBUG_CAPABILITIES } from '../js/debug/adapter.js';

const adapter = new DebugAdapter({ id: 'test', capabilities: new Set(['readMemory']) });

assert.equal(DEBUG_CAPABILITIES.includes('__proto__'), false);
assert.equal(DEBUG_CAPABILITIES.includes('toString'), false);
assert.equal(DEBUG_CAPABILITIES.includes('constructor'), false);

for (const inherited of ['__proto__', 'toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
  assert.throws(
    () => adapter.require(inherited),
    (error) => error.code === 'unsupported' && error.details?.capability === inherited,
    `prototype-inherited capability ${inherited} must be rejected`,
  );
}

assert.throws(
  () => adapter.require('definitely-unsupported'),
  (error) => error.code === 'unsupported',
  'arbitrary unknown capability names must stay rejected',
);

adapter.require('readMemory');
for (const key of DEBUG_CAPABILITIES) {
  if (key === 'readMemory' || key === 'connect' || key === 'disconnect') continue;
  assert.throws(
    () => adapter.require(key),
    (error) => error.code === 'unsupported',
    `capability ${key} (false) must keep its existing reject semantics`,
  );
}
