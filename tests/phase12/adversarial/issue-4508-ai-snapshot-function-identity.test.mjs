import assert from 'node:assert/strict';
import { createTurnSnapshot, createSnapshotContext } from '../../../js/ai/control/snapshot.js';
import { ScopeController } from '../../../js/ai/control/scope.js';
import { ContextBroker } from '../../../js/ai/context/broker.js';
import { createHexToolRegistry } from '../../../js/ai/tools/index.js';

// #4508: a cursor inside a function must not become the function identity.
const local = {
  currentAddress: 0x1010n,
  activeFunction: { address: 0x1000n, name: 'f' },
  functionRange() { return { start: 0x1000n, end: 0x1100n }; },
  binaryId: 'issue-4508',
};
const snapshot = createTurnSnapshot(local, { scope: 'function' });
const scope = new ScopeController(snapshot, 'function');
const context = createSnapshotContext(local, snapshot, scope);

assert.equal(snapshot.currentAddress, '0x1010', 'cursor location must remain available independently');
assert.equal(snapshot.currentFunction.address, '0x1000', 'containing function identity must use its start');
assert.deepEqual(snapshot.currentFunction.range, { start: '0x1000', end: '0x1100' });
assert.equal(scope.scopeContainsFunction('function', '0x1000'), true);
assert.equal(scope.scopeContainsFunction('function', '0x1010'), false, 'an interior instruction is not a function identity');
assert.equal(scope.scopeContainsAddress('function', '0x1010'), true, 'the cursor remains inside the function address range');

assert.equal(context.currentAddress, 0x1010n, 'snapshot context must preserve the cursor');
assert.equal(context.activeFunction.address, 0x1000n, 'snapshot context must preserve function identity');
assert.equal(context.activeFunction.start, 0x1000n);

const broker = new ContextBroker(context);
const modelContext = broker.buildModelContext({
  request: { scope: 'function' }, snapshot, effectiveScope: 'function', includeHistory: false,
});
assert.equal(modelContext.context.current.address, '0x1010', 'model context must expose the cursor location');
assert.equal(modelContext.context.current.function.address, '0x1000', 'model context function identity must use the start');

const registry = createHexToolRegistry(context);
const selectionContext = await registry.execute('get_selection_context', {}, { scope: 'function' });
assert.equal(selectionContext.result.functionAddress, '0x1000', 'current-function tools must use function identity, not cursor');

// If there is no explicit function object, an exact lookup/range start is the
// next authority. The cursor remains a fallback only when no boundary exists.
const rangeOnly = createTurnSnapshot({
  currentAddress: 0x2010n,
  functionRange() { return { start: 0x2000n, end: 0x2100n }; },
}, { scope: 'function' });
assert.equal(rangeOnly.currentAddress, '0x2010');
assert.equal(rangeOnly.currentFunction.address, '0x2000');
assert.deepEqual(rangeOnly.currentFunction.range, { start: '0x2000', end: '0x2100' });

const atFunctionStart = createTurnSnapshot({
  currentAddress: 0x3000n,
  activeFunction: { address: 0x3000n, name: 'entry' },
  functionRange() { return { start: 0x3000n, end: 0x3010n }; },
}, { scope: 'function' });
assert.equal(atFunctionStart.currentAddress, '0x3000');
assert.equal(atFunctionStart.currentFunction.address, '0x3000', 'cursor-at-start behavior remains unchanged');

console.log('issue #4508 AI snapshot function identity: PASS');
