// Regression for #5416: each optional function-boundary source is tried
// independently. A priority source throwing must not skip the remaining
// fallbacks, or function scope collapses to the start address.
import assert from 'node:assert/strict';
import { createTurnSnapshot } from '../js/ai/control/snapshot.js';
import { ScopeController } from '../js/ai/control/scope.js';

// 1. The priority source throwing still reaches symbols.functionAt.
{
  const snapshot = createTurnSnapshot({
    currentAddress: 0x1000n,
    functionRange() { throw new Error('temporary provider failure'); },
    symbols: { functionAt() { return { start: 0x1000n, end: 0x1100n, name: 'f' }; } },
  }, { scope: 'function' });
  assert.deepEqual(snapshot.currentFunction.range, { start: '0x1000', end: '0x1100' });
}

// 2. Both optional sources throwing still reaches program.functionRange.
{
  const snapshot = createTurnSnapshot({
    currentAddress: 0x1000n,
    functionRange() { throw new Error('boom'); },
    symbols: { functionAt() { throw new Error('boom'); } },
    program: { functionRange() { return { start: 0x1000n, end: 0x1200n }; } },
  }, { scope: 'function' });
  assert.deepEqual(snapshot.currentFunction.range, { start: '0x1000', end: '0x1200' });
}

// 3. All sources throwing keeps the prior fail-closed single-address range.
{
  const snapshot = createTurnSnapshot({
    currentAddress: 0x1000n,
    functionRange() { throw new Error('boom'); },
  }, { scope: 'function' });
  assert.deepEqual(snapshot.currentFunction.range, { start: '0x1000', end: null });
}

// 4. With a recovered fallback, function scope authorizes interior addresses.
{
  const snapshot = createTurnSnapshot({
    currentAddress: 0x1000n,
    functionRange() { throw new Error('temporary provider failure'); },
    symbols: { functionAt() { return { start: 0x1000n, end: 0x1100n, name: 'f' }; } },
  }, { scope: 'function' });
  const scope = new ScopeController(snapshot, 'function');
  assert.equal(scope.scopeContainsAddress('function', '0x10f8'), true, 'interior addresses stay in scope when a fallback boundary exists');
  assert.equal(scope.scopeContainsAddress('function', '0x1104'), false);
}

console.log('issue #5416 function-range fallback chain regressions PASS');
