import assert from 'node:assert/strict';
import { ScopeController, scopeAllowsTool } from '../js/ai/control/scope.js';
import { collectAddresses as registryCollectAddresses } from '../js/ai/tools/registry-core.js';

// Current function A: [0x1000, 0x1100). B at 0x2000 is outside function scope.
const snapshot = {
  currentFunction: { address: '0x1000', range: { start: '0x1000', end: '0x1100' } },
};

// Guard 1: ScopeController must see functions[] entries as addresses.
assert.equal(
  scopeAllowsTool(snapshot, 'function', 'find_constant', { value: 123, functions: ['0x2000'], limit: 100 }),
  false,
  'functions[] outside the current function must not pass function scope',
);
assert.equal(
  scopeAllowsTool(snapshot, 'function', 'explain_evidence', { evidenceIds: ['ev1'], functions: ['0x2000'] }),
  false,
  'explain_evidence functions[] outside the current function must not pass function scope',
);
assert.equal(
  scopeAllowsTool(snapshot, 'function', 'find_constant', { value: 123, functions: ['0x1000'], limit: 100 }),
  true,
  'functions[] inside the current function must still pass function scope',
);

// The controller instance path enforces the same boundary.
{
  const controller = new ScopeController(snapshot, 'function');
  assert.throws(
    () => controller.assertToolCall('find_constant', { value: 1, functions: ['0x2000'] }),
    (error) => error?.type === 'scope_violation',
  );
}

// Guard 2: ToolRegistry address collection must see functions[] entries.
{
  const found = registryCollectAddresses({ value: 123, functions: ['0x2000'], limit: 100 });
  assert.ok(found.includes('0x2000'), `registry must collect functions[] addresses, got ${JSON.stringify(found)}`);
}

console.log('issue-5126-functions-scope-boundary: ok');
