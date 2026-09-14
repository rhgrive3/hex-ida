import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTools, pageRows } from '../../../js/agent/tools.js';

for (const malformed of ['false', 'true', [], {}, 0, 1]) {
  for (const nested of [false, true]) {
    test(`malformed ${JSON.stringify(malformed)} ${nested ? 'nested' : 'top-level'} completeness never proves exhaustion`, async () => {
      const meta = nested ? { completeness: { complete: malformed } } : { complete: malformed };
      const tools = createAgentTools({ searchFunctions: async () => ({ results: ['observed'], ...meta }) });
      const result = await tools.search_functions('x');
      assert.deepEqual(result.results, ['observed']);
      assert.equal(result.complete, false);
      assert.equal(result.truncated, true);
      assert.equal(result.total, null);
      assert.equal(result.coverage, null);
      assert.equal(result.reason, 'invalid-completeness');
      assert.equal(result.completeness.complete, false);
    });
  }
}

test('valid booleans, missing metadata and nullish inference remain supported', () => {
  assert.equal(pageRows({ results: [1], complete: true }, 10).complete, true);
  assert.equal(pageRows({ results: [1], complete: false }, 10).complete, false);
  assert.equal(pageRows([1], 10).complete, true);
  assert.equal(pageRows({ results: [1], complete: null }, 10).complete, true);
  assert.equal(pageRows({ results: [], complete: true, total: 0 }, 10).total, 0);
});

test('negative and malformed metadata cannot be overridden by another positive flag', () => {
  for (const meta of [
    { complete: true, completeness: { complete: false } },
    { complete: true, completeness: { complete: 'false' } },
    { complete: true, truncated: true },
    { complete: true, truncated: 'false' },
  ]) assert.equal(pageRows({ results: [1], ...meta }, 10).complete, false);
});

test('invalid total still invalidates completeness', () => {
  const result = pageRows({ results: [1], complete: true, total: ['1'] }, 10);
  assert.equal(result.complete, false);
  assert.equal(result.total, null);
  assert.equal(result.reason, 'invalid-total');
});
