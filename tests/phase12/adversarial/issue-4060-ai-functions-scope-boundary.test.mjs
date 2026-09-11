import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../../../js/blocks.js';
import { ScopeController } from '../../../js/ai/control/scope.js';
import { createHexToolRegistry } from '../../../js/ai/tools/registry.js';
import { AIError } from '../../../js/ai/schema.js';

const CURRENT = 0x1000n;
const NEIGHBOR = 0x1800n;
const OUTSIDE = 0x2000n;

const snapshot = Object.freeze({
  currentFunction: Object.freeze({
    address: '0x1000',
    range: Object.freeze({ start: '0x1000', end: '0x1100' }),
  }),
  neighborhood: Object.freeze(['0x1800']),
});

function guard(scope = 'function') {
  return new ScopeController(snapshot, scope);
}

function modelAt(address) {
  return buildSemanticModel([
    { row: 0, address, mn: 'mov', ops: 'w0, #123' },
    { row: 1, address: address + 4n, mn: 'ret', ops: '' },
  ], [], []);
}

function isScopeViolation(error) {
  return error instanceof AIError && error.type === 'scope_violation';
}

function makeRegistry({ controller = guard('function'), bypassController = false } = {}) {
  const analyzed = [];
  const context = {
    binaryId: 'bin-4060',
    analysisRevision: 'r1',
    candidateFunctions: [],
    analyze: async (address) => {
      const value = BigInt(address);
      analyzed.push(value);
      return modelAt(value);
    },
    addressExists: async () => true,
    scopeAllowsTool: bypassController
      ? () => true
      : (scope, tool, args) => controller.scopeAllowsTool(scope, tool, args),
    scopeContainsAddress: (scope, address) => controller.scopeContainsAddress(scope, address),
    scopeContainsFunction: (scope, address) => controller.scopeContainsFunction(scope, address),
  };
  return { registry: createHexToolRegistry(context, { maxFunctions: 8 }), analyzed };
}

test('#4060 ScopeController treats find_constant.functions[] as function addresses', () => {
  const controller = guard('function');
  assert.equal(controller.scopeAllowsTool('function', 'find_constant', { value: 123, functions: ['0x1000'] }), true);
  assert.equal(controller.scopeAllowsTool('function', 'find_constant', { value: 123, functions: ['0x2000'] }), false);
  assert.equal(controller.scopeAllowsTool('function', 'find_constant', { value: 123, functions: ['0x1000', '0x2000'] }), false);
  // functions[] carries function identities, not arbitrary addresses inside the current range.
  assert.equal(controller.scopeAllowsTool('function', 'find_constant', { value: 123, functions: ['0x1004'] }), false);
});

test('#4060 ScopeController applies the same functions[] boundary to explain_evidence', () => {
  const controller = guard('function');
  assert.equal(controller.scopeAllowsTool('function', 'explain_evidence', { evidenceIds: ['e1'], functions: ['0x1000'] }), true);
  assert.equal(controller.scopeAllowsTool('function', 'explain_evidence', { evidenceIds: ['e1'], functions: ['0x2000'] }), false);
});

test('#4060 neighborhood accepts an allowed function but rejects an unrelated function', () => {
  const controller = guard('neighborhood');
  assert.equal(controller.scopeAllowsTool('neighborhood', 'find_constant', { value: 123, functions: ['0x1800'] }), true);
  assert.equal(controller.scopeAllowsTool('neighborhood', 'find_constant', { value: 123, functions: ['0x2000'] }), false);
});

test('#4060 actual createHexToolRegistry rejects outside functions before analysis', async () => {
  const { registry, analyzed } = makeRegistry();
  await assert.rejects(
    () => registry.execute('find_constant', { value: 123, functions: ['0x2000'], limit: 10 }, { scope: 'function' }),
    isScopeViolation,
  );
  assert.deepEqual(analyzed, []);
});

test('#4060 registry address guard independently sees functions[]', async () => {
  const { registry, analyzed } = makeRegistry({ bypassController: true });
  await assert.rejects(
    () => registry.execute('explain_evidence', { evidenceIds: ['e1'], functions: ['0x2000'], limit: 10 }, { scope: 'function' }),
    isScopeViolation,
  );
  assert.deepEqual(analyzed, []);
});

test('#4060 registry function identity guard rejects an interior address even if address-range guard would allow it', async () => {
  const { registry, analyzed } = makeRegistry({ bypassController: true });
  await assert.rejects(
    () => registry.execute('find_constant', { value: 123, functions: ['0x1004'], limit: 10 }, { scope: 'function' }),
    isScopeViolation,
  );
  assert.deepEqual(analyzed, []);
});

test('#4060 hostile structured function entries fail closed without coercion hooks', async () => {
  let conversions = 0;
  const hostile = {
    [Symbol.toPrimitive]() { conversions++; return '0x1000'; },
    toString() { conversions++; return '0x1000'; },
  };
  const controller = guard('function');
  assert.equal(controller.scopeAllowsTool('function', 'find_constant', { value: 123, functions: [hostile] }), false);
  assert.equal(conversions, 0);

  const { registry, analyzed } = makeRegistry();
  await assert.rejects(
    () => registry.execute('find_constant', { value: 123, functions: [hostile], limit: 10 }, { scope: 'function' }),
    (error) => error instanceof AIError && error.type === 'invalid_tool_call',
  );
  assert.equal(conversions, 0);
  assert.deepEqual(analyzed, []);
});

test('#4060 legal current-function and broad-scope requests keep working', async () => {
  const local = makeRegistry();
  const localResult = await local.registry.execute('find_constant', { value: 123, functions: ['0x1000'], limit: 10 }, { scope: 'function' });
  assert.equal(localResult.tool, 'find_constant');
  assert.deepEqual(local.analyzed, [CURRENT]);

  const broad = makeRegistry({ controller: guard('binary') });
  const broadResult = await broad.registry.execute('find_constant', { value: 123, functions: ['0x2000'], limit: 10 }, { scope: 'binary' });
  assert.equal(broadResult.tool, 'find_constant');
  assert.deepEqual(broad.analyzed, [OUTSIDE]);
});

// Keep constants exercised so accidental fixture edits cannot silently change the intended topology.
assert.equal(NEIGHBOR, 0x1800n);
