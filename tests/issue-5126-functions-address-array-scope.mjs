import assert from 'node:assert/strict';

import { buildSemanticModel } from '../js/blocks.js';
import { ScopeController } from '../js/ai/control/scope.js';
import { collectAddresses as registryCollectAddresses } from '../js/ai/tools/registry-core.js';
import { createHexToolRegistry } from '../js/ai/tools/registry-base.js';

const A = 0x1000n;
const B = 0x2000n;
const C = 0x3000n;
const emptyModel = buildSemanticModel([{ row: 0, address: A, mn: 'ret', ops: '' }], [], []);

const snapshot = {
  binaryId: 'content:hash-5126:0',
  currentFunction: { address: '0x1000', range: { start: '0x1000', end: '0x1100' } },
  selection: null,
  neighborhood: ['0x1000', '0x2000'],
};

function isScopeViolation(error) {
  return error?.type === 'scope_violation' || /scope/i.test(error?.message || '');
}

function harness(scope) {
  const analyzed = [];
  const controller = new ScopeController(snapshot, scope);
  const context = {
    binaryId: snapshot.binaryId,
    candidateFunctions: [],
    analyze: async (address) => { analyzed.push(BigInt(address)); return emptyModel; },
    scopeAllowsTool: (requested, tool, args) => controller.scopeAllowsTool(requested, tool, args),
    scopeContainsAddress: (requested, address) => controller.scopeContainsAddress(requested, address),
    scopeContainsFunction: (requested, address) => controller.scopeContainsFunction(requested, address),
  };
  return { registry: createHexToolRegistry(context), analyzed };
}

// Guard 1: ScopeController must treat every functions[] element as an address
// bound to the function boundary, not as an opaque array.
{
  const functionScope = new ScopeController(snapshot, 'function');
  assert.equal(functionScope.scopeAllowsTool('function', 'find_constant', { value: 123, functions: ['0x1000'], limit: 100 }), true);
  assert.equal(functionScope.scopeAllowsTool('function', 'find_constant', { value: 123, functions: ['0x2000'], limit: 100 }), false,
    '#5126 functions[] outside the current function must not pass function scope');
  assert.equal(functionScope.scopeAllowsTool('function', 'explain_evidence', { evidenceIds: ['ev-1'], functions: ['0x2000'] }), false,
    '#5126 explain_evidence functions[] must bind to the same boundary');
  assert.throws(
    () => functionScope.assertToolCall('find_constant', { value: 123, functions: ['0x2000'] }),
    isScopeViolation,
  );
  const neighborhoodScope = new ScopeController(snapshot, 'neighborhood');
  assert.equal(neighborhoodScope.scopeAllowsTool('neighborhood', 'find_constant', { value: 123, functions: ['0x2000'] }), true);
  assert.equal(neighborhoodScope.scopeAllowsTool('neighborhood', 'find_constant', { value: 123, functions: ['0x3000'] }), false,
    '#5126 neighborhood scope must stay inside the admitted neighborhood');
}

// Guard 2: ToolRegistry address collection must see functions[] elements.
{
  const found = registryCollectAddresses({ value: 123, functions: ['0x2000'], limit: 100 });
  assert.ok(found.includes('0x2000'), `#5126 registry must collect functions[] addresses, got ${JSON.stringify(found)}`);
}

// Decisive counter-example, executed through the real tool boundary.
{
  const { registry, analyzed } = harness('function');
  await assert.rejects(
    () => registry.execute('find_constant', { value: 123, functions: ['0x2000'], limit: 100 }, { scope: 'function' }),
    isScopeViolation,
    '#5126 function scope must reject an out-of-function candidate',
  );
  assert.ok(!analyzed.includes(B), '#5126 the rejected candidate must never reach analysis');
}
{
  const { registry } = harness('function');
  const result = await registry.execute('find_constant', { value: 123, functions: ['0x1000'], limit: 100 }, { scope: 'function' });
  assert.equal(result.tool, 'find_constant');
}
{
  const { registry, analyzed } = harness('function');
  await assert.rejects(
    () => registry.execute('explain_evidence', { evidenceIds: ['ev-1'], functions: ['0x2000'] }, { scope: 'function' }),
    isScopeViolation,
  );
  assert.ok(!analyzed.includes(B));
}
{
  const { registry, analyzed } = harness('neighborhood');
  await registry.execute('find_constant', { value: 123, functions: ['0x2000'], limit: 100 }, { scope: 'neighborhood' });
  assert.ok(analyzed.includes(B), 'an admitted neighbor stays readable');
  const rejected = harness('neighborhood');
  await assert.rejects(
    () => rejected.registry.execute('find_constant', { value: 123, functions: ['0x3000'], limit: 100 }, { scope: 'neighborhood' }),
    isScopeViolation,
  );
  assert.ok(!rejected.analyzed.includes(C));
}

// Wider scopes keep legitimate cross-function requests.
for (const scope of ['binary', 'project']) {
  const { registry, analyzed } = harness(scope);
  await registry.execute('find_constant', { value: 123, functions: ['0x2000', '0x3000'], limit: 100 }, { scope });
  assert.deepEqual(analyzed, [B, C], `${scope} scope must preserve cross-function analysis`);
}

// Scalar address/functionAddress guards must not regress, and the documented
// non-address `start` exemption for inspect_function_region must survive.
{
  const functionScope = new ScopeController(snapshot, 'function');
  assert.equal(functionScope.scopeAllowsTool('function', 'get_function', { functionAddress: '0x1000' }), true);
  assert.equal(functionScope.scopeAllowsTool('function', 'get_function', { functionAddress: '0x2000' }), false);
  assert.equal(functionScope.scopeAllowsTool('function', 'get_xrefs', { address: '0x1050' }), true);
  assert.equal(functionScope.scopeAllowsTool('function', 'inspect_function_region', { functionAddress: '0x1000', view: 'assembly', start: 4, count: 8 }), true);
  assert.throws(
    () => functionScope.assertToolCall('get_semantic_facts', { functionAddress: '0x2000' }),
    isScopeViolation,
  );
  assert.deepEqual(registryCollectAddresses({ functionAddress: '0x2000', limit: 10 }), ['0x2000']);
}

console.log('issue-5126-functions-address-array-scope: ok');
