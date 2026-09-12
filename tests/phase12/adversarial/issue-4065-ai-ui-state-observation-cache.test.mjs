import assert from 'node:assert/strict';
import { createHexToolRegistry } from '../../../js/ai/tools/index.js';
import { ToolRegistry } from '../../../js/ai/tools/registry-core.js';
import { ObservationStore } from '../../../js/ai/tools/storage/observation-store.js';

function selectionAt(address) {
  return {
    start: address,
    end: address + 4n,
    instructions: [{ address, mnemonic: 'nop', operands: '' }],
  };
}

let searchCalls = 0;
function contextAt(address) {
  return {
    binaryIdentity: 'issue-4065-binary',
    analysisRevision: 'analysis:1',
    currentAddress: address,
    selection: selectionAt(address),
    // get_current_function can still expose the requested address when analysis
    // is unavailable; that is enough to prove whether the callback ran.
    analyze: async () => null,
    searchFunctions: async () => {
      searchCalls += 1;
      return [{ address: 0x3000n, name: 'stable' }];
    },
  };
}

const store = new ObservationStore({ context: contextAt(0x1000n) });

const firstRegistry = createHexToolRegistry(contextAt(0x1000n), { observationStore: store });
const firstSelection = await firstRegistry.execute('get_selection_context', {}, { scope: 'binary' });
assert.notEqual(firstSelection.cached, true);
assert.equal(firstSelection.result.functionAddress, '0x1000');
assert.equal(firstSelection.result.selection.start, '0x1000');

const firstCurrent = await firstRegistry.execute('get_current_function', {}, { scope: 'binary' });
assert.notEqual(firstCurrent.cached, true);
assert.equal(firstCurrent.result.address, '0x1000');

const firstSearch = await firstRegistry.execute('search_functions', { query: 'stable', limit: 10 }, { scope: 'binary' });
assert.notEqual(firstSearch.cached, true);
assert.equal(searchCalls, 1);

// Same binary + analysis revision, but a fresh turn at a different UI state.
// Reusing ObservationStore is intentional; only snapshot-dependent tool cache
// entries must stop crossing this boundary.
const secondRegistry = createHexToolRegistry(contextAt(0x2000n), { observationStore: store });
const secondSelection = await secondRegistry.execute('get_selection_context', {}, { scope: 'binary' });
assert.notEqual(secondSelection.cached, true, 'selection-dependent result must be recomputed after navigation');
assert.equal(secondSelection.result.functionAddress, '0x2000');
assert.equal(secondSelection.result.selection.start, '0x2000');

const secondCurrent = await secondRegistry.execute('get_current_function', {}, { scope: 'binary' });
assert.notEqual(secondCurrent.cached, true, 'current-function result must be recomputed after navigation');
assert.equal(secondCurrent.result.address, '0x2000');

// Non-UI deterministic work keeps the existing cross-turn cache behavior.
const secondSearch = await secondRegistry.execute('search_functions', { query: 'stable', limit: 10 }, { scope: 'binary' });
assert.equal(secondSearch.cached, true);
assert.equal(searchCalls, 1);

// Disabling cache reuse must not drop observation/detail provenance.
for (const result of [firstSelection, firstCurrent, secondSelection, secondCurrent]) {
  assert.ok(result.detailRef, 'snapshot-dependent reads must still produce detail records');
  const record = store.get(result.detailRef);
  assert.ok(record, 'detail records must remain dereferenceable');
  assert.equal(record.cacheKey, null, 'snapshot-dependent observations must not enter the reusable cache');
}
assert.ok(store.get(secondSearch.detailRef).cacheKey, 'ordinary deterministic observations remain cacheable');

assert.equal(firstRegistry.get('get_current_function').deterministic, true, 'UI reads remain deterministic within one snapshot');
assert.equal(firstRegistry.get('get_selection_context').deterministic, true, 'UI reads remain deterministic within one snapshot');
assert.equal(firstRegistry.get('get_current_function').cacheable, false, 'current-function cache policy is separate from determinism');
assert.equal(firstRegistry.get('get_selection_context').cacheable, false, 'selection cache policy is separate from determinism');

// A custom definition must not be able to re-enable reusable caching for a
// reserved snapshot-dependent tool name. This keeps the policy authoritative
// at the registry boundary rather than relying on each built-in definition.
let customCalls = 0;
const customStore = new ObservationStore({ context: contextAt(0x1000n) });
function customRegistryAt(address) {
  const registry = new ToolRegistry({ context: contextAt(address), observationStore: customStore });
  registry.register({
    name: 'get_current_function',
    cacheable: true,
    execute: async (_args, { context }) => {
      customCalls += 1;
      return { address: `0x${context.currentAddress.toString(16)}` };
    },
  });
  return registry;
}

const customFirstRegistry = customRegistryAt(0x1000n);
assert.equal(customFirstRegistry.get('get_current_function').cacheable, false, 'reserved tool name must override custom cacheable:true');
const customFirst = await customFirstRegistry.execute('get_current_function', {}, { scope: 'binary' });
assert.equal(customFirst.result.address, '0x1000');
assert.notEqual(customFirst.cached, true);
assert.equal(customStore.get(customFirst.detailRef).cacheKey, null);

const customSecondRegistry = customRegistryAt(0x2000n);
assert.equal(customSecondRegistry.get('get_current_function').cacheable, false);
const customSecond = await customSecondRegistry.execute('get_current_function', {}, { scope: 'binary' });
assert.equal(customSecond.result.address, '0x2000', 'custom reserved tool must observe the new UI snapshot');
assert.notEqual(customSecond.cached, true);
assert.equal(customStore.get(customSecond.detailRef).cacheKey, null);
assert.equal(customCalls, 2, 'custom reserved tool must recompute on each snapshot');

console.log('issue #4065 AI UI-state ObservationStore cache: PASS');
