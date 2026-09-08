import assert from 'node:assert/strict';
import { AIRuntime } from '../../../js/ai/runtime.js';

const runtime = new AIRuntime({
  planner: false,
  sessionStore: { sessions: new Map(), delete: async () => true },
});
const exactSession = { id: 'foo', confirmedFindings: [], hypotheses: [] };
const suffixCollisionSession = { id: 'bar::foo', confirmedFindings: [], hypotheses: [] };

const exactA = runtime.storesFor(exactSession, 'bin-A');
const exactB = runtime.storesFor(exactSession, 'bin-B');
const suffixCollision = runtime.storesFor(suffixCollisionSession, 'bin-C');

assert.equal(runtime.storeNamespaces.size, 3);
await runtime.releaseSession('foo');

assert.equal(runtime.storeNamespaces.has('bin-A::foo'), false, 'exact session namespace must be released');
assert.equal(runtime.storeNamespaces.has('bin-B::foo'), false, 'all binary namespaces for the exact session must be released');
assert.equal(runtime.storeNamespaces.has('bin-C::bar::foo'), true, 'suffix-colliding session namespace must survive');
assert.equal(runtime.storesFor(suffixCollisionSession, 'bin-C'), suffixCollision, 'surviving session must keep its namespace stores');
assert.notEqual(runtime.storesFor(exactSession, 'bin-A'), exactA, 'released session must receive a fresh namespace on reuse');
assert.notEqual(runtime.storesFor(exactSession, 'bin-B'), exactB, 'released session must receive fresh stores for every released binary namespace');

await runtime.releaseSession('bar::foo');
assert.equal(runtime.storeNamespaces.has('bin-C::bar::foo'), false, 'colliding session must release only when its exact id is requested');

console.log('[phase12] issue #3664 AI runtime exact session namespace release passed');
