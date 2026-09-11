import test from 'node:test';
import assert from 'node:assert/strict';
import { __symmetricWorkspaceInternalsForTests } from '../js/diff/symmetric-workspace-runtime.js';

// #5558: baseline function discovery debited the global discovery budget with
// the RAW per-region guessFunctions() result length, but SymbolIndex
// .addFunctions() deduplicates known starts and returns the count actually
// added. Duplicate re-discovery (a normal outcome when heuristic region scans
// overlap partial metadata) could therefore exhaust the global budget and skip
// not-yet-scanned regions with `function-global-budget`.

const DISCOVERY_GLOBAL_CAP = 400000;

function fixture(symbolsOverrides = {}) {
  const guessCalls = [];
  const addedCalls = [];
  const symbols = {
    functionStartsComplete: false,
    functionCount: DISCOVERY_GLOBAL_CAP - 1, // one unit of global budget left
    addFunctions(starts, opts) {
      addedCalls.push([...starts]);
      return 0; // every returned start is already known -> nothing new added
    },
    ...symbolsOverrides,
  };
  const backend = {
    guessFunctions(regionId, share, onProgress) {
      guessCalls.push(regionId);
      return {
        cancel() {},
        then(resolve, reject) {
          resolve(regionId === 'text-a'
            ? { starts: [0x1234n], discoveryComplete: true } // 1 duplicate re-discovery
            : { starts: [0x9999n, 0x999an, 0x999bn], discoveryComplete: true });
        },
      };
    },
  };
  return {
    symbols,
    backend,
    guessCalls,
    addedCalls,
    baseline: {
      symbols,
      backend,
      slice: {
        regions: [
          { id: 'text-a', vmAddr: '0x1000', size: 0x1000, exec: true },
          { id: 'text-b', vmAddr: '0x2000', size: 0x1000, exec: true },
        ],
      },
    },
  };
}

test('5558: duplicate re-discovery does not burn the global discovery budget', async () => {
  const { baseline, guessCalls, addedCalls } = fixture();
  const out = await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  const discovery = out.functionDiscovery;
  assert.deepEqual(guessCalls, ['text-a', 'text-b'], 'the later region must still be scanned');
  assert.equal(addedCalls.length, 2, 'both regions must feed the symbol index');
  assert.equal(discovery.regions[1].skipped, undefined, 'text-b must not be skipped for budget');
  assert.deepEqual(discovery.reasons, [], 'no function-global-budget truncation may be recorded');
  assert.equal(discovery.complete, true);
});

test('5558: genuinely new discoveries still debit the budget', async () => {
  const { baseline, guessCalls } = fixture({
    addFunctions(starts) { return starts.length; }, // all discoveries are new
  });
  const out = await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.deepEqual(guessCalls, ['text-a'], 'the single unit of budget is spent on text-a');
  assert.equal(out.functionDiscovery.regions[1].skipped, true, 'text-b is skipped once the budget is truly exhausted');
  assert.ok(out.functionDiscovery.reasons.some((reason) => reason.includes('function-global-budget')));
});
