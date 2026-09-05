import assert from 'node:assert/strict';
import { __symmetricWorkspaceInternalsForTests } from '../js/diff/symmetric-workspace-runtime.js';

// Issue #5105: discoverBaselineFunctions() enforces DISCOVERY_GLOBAL_CAP
// (400000) only as the requested backend limit, but ingests every returned
// start. A backend returning more than the requested share pushes the symbol
// index past the global bound.

const { discoverBaselineFunctions } = __symmetricWorkspaceInternalsForTests;
assert.equal(typeof discoverBaselineFunctions, 'function', 'discoverBaselineFunctions must stay reachable for tests');

const makeBaseline = ({ functionCount, starts }) => {
  const accepted = [];
  const symbols = {
    functionStartsComplete: false,
    functionCount,
    addFunctions(startsToAdd) {
      accepted.push(...startsToAdd);
      this.functionCount += startsToAdd.length;
    },
  };
  const baseline = {
    symbols,
    slice: {
      regions: [{ id: 'text', exec: true, zerofill: false, vmAddr: 0n, size: 16n }],
    },
    backend: {
      async guessFunctions(_regionId, _limit) {
        return { starts, discoveryComplete: true };
      },
    },
  };
  return { baseline, symbols, accepted };
};

// The exact counterexample from the issue: 1 slot left, backend returns 2.
{
  const { baseline, symbols, accepted } = makeBaseline({ functionCount: 399999, starts: [0n, 4n] });
  await discoverBaselineFunctions(baseline);
  assert.equal(accepted.length, 1, 'ingestion must be bounded by the remaining global budget');
  assert.ok(symbols.functionCount <= 400000, `global cap must hold, got ${symbols.functionCount}`);
  assert.equal(symbols.functionStartsComplete, false, 'over-cap truncation must not report complete discovery');
  assert.ok((symbols.functionDiscovery?.reasons || []).some((reason) => /budget|cap/.test(reason)), 'truncation must carry a budget reason');
}

// A compliant backend response is unaffected.
{
  const { baseline, symbols, accepted } = makeBaseline({ functionCount: 10, starts: [0n, 4n, 8n] });
  await discoverBaselineFunctions(baseline);
  assert.equal(accepted.length, 3, 'in-budget responses must be fully ingested');
  assert.equal(symbols.functionCount, 13);
  assert.equal(symbols.functionStartsComplete, true, 'complete backend discovery must still report complete');
}

// A wildly over-cap response cannot blow past the bound by an arbitrary width.
{
  const { baseline, symbols, accepted } = makeBaseline({ functionCount: 399990, starts: Array.from({ length: 500 }, (_, i) => BigInt(i * 4)) });
  await discoverBaselineFunctions(baseline);
  assert.equal(accepted.length, 10, 'ingestion must stop at the remaining budget');
  assert.ok(symbols.functionCount <= 400000, `global cap must hold, got ${symbols.functionCount}`);
  assert.equal(symbols.functionStartsComplete, false);
}

console.log('issue #5105 discovery global cap: PASS');
