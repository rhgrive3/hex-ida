import test from 'node:test';
import assert from 'node:assert/strict';
import { __symmetricWorkspaceInternalsForTests } from '../js/diff/symmetric-workspace-runtime.js';

// #5105: discoverBaselineFunctions used the computed `share` only as the
// requested limit for backend.guessFunctions() and ingested the whole
// returned `starts` array without validating its cardinality. A backend that
// returns more starts than requested pushed SymbolIndex past
// DISCOVERY_GLOBAL_CAP, and an over-budget response was still recorded as a
// complete region. The consumer must bound ingestion and record the excess
// fail-closed instead of trusting the backend's self-restraint.

const DISCOVERY_GLOBAL_CAP = 400000;

function fixture({ functionCount, regions, respond }) {
  const guessCalls = [];
  const ingested = [];
  const symbols = {
    functionStartsComplete: false,
    functionCount,
    addFunctions(starts) {
      ingested.push([...starts]);
      this.functionCount += starts.length;
      return starts.length; // every returned start is new
    },
  };
  const backend = {
    guessFunctions(regionId, share, onProgress) {
      guessCalls.push({ regionId, share });
      try { onProgress?.({ done: 1, all: 1 }); } catch { /* observer only */ }
      return Promise.resolve({ starts: respond(regionId, share), discoveryComplete: true });
    },
  };
  return {
    symbols,
    guessCalls,
    ingested,
    baseline: {
      symbols,
      backend,
      slice: { regions },
    },
  };
}

const TEXT = { id: 'text', vmAddr: '0x1000', size: 0x1000, exec: true };

test('5105: a backend over-return past the remaining global budget cannot exceed DISCOVERY_GLOBAL_CAP', async () => {
  const { symbols, ingested, baseline } = fixture({
    functionCount: DISCOVERY_GLOBAL_CAP - 1,
    regions: [TEXT],
    respond: () => [0x1n, 0x2n], // 2 starts for a share of 1
  });
  await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.ok(symbols.functionCount <= DISCOVERY_GLOBAL_CAP,
    `global cap must hold, saw ${symbols.functionCount}`);
  assert.deepEqual(ingested[0], [0x1n], 'only budgeted starts may reach the symbol index');
});

test('5105: an excess response is never recorded as a complete region', async () => {
  const { symbols, baseline } = fixture({
    functionCount: DISCOVERY_GLOBAL_CAP - 1,
    regions: [TEXT],
    respond: () => [0x1n, 0x2n],
  });
  await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  const discovery = symbols.functionDiscovery;
  assert.equal(discovery.complete, false, 'an over-returned response must demote completeness');
  assert.equal(discovery.regions[0].complete, false);
  assert.ok(discovery.reasons.some((reason) => reason.includes('backend-result-exceeds-budget')),
    `the excess must be recorded as a truncation reason, saw ${JSON.stringify(discovery.reasons)}`);
  assert.equal(symbols.functionStartsComplete, false);
});

test('5105: backends honoring the requested share keep existing behavior', async () => {
  const { symbols, guessCalls, baseline } = fixture({
    functionCount: DISCOVERY_GLOBAL_CAP - 1,
    regions: [TEXT],
    respond: (_regionId, share) => [0x1n].slice(0, share), // exactly one start
  });
  await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.deepEqual(guessCalls, [{ regionId: 'text', share: 1 }]);
  assert.equal(symbols.functionCount, DISCOVERY_GLOBAL_CAP);
  assert.equal(symbols.functionDiscovery.complete, true);
  assert.deepEqual(symbols.functionDiscovery.reasons, []);
});

test('5105: multiple regions together never ingest past the global cap', async () => {
  const { symbols, baseline } = fixture({
    functionCount: DISCOVERY_GLOBAL_CAP - 3,
    regions: [
      { id: 'text-a', vmAddr: '0x1000', size: 0x1000, exec: true },
      { id: 'text-b', vmAddr: '0x2000', size: 0x1000, exec: true },
    ],
    respond: (regionId, share) => regionId === 'text-a'
      ? [0xa1n, 0xa2n, 0xa3n, 0xa4n, 0xa5n] // 5-way over-return against share 3
      : [0xb1n, 0xb2n, 0xb3n, 0xb4n].slice(0, share),
  });
  await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.ok(symbols.functionCount <= DISCOVERY_GLOBAL_CAP,
    `multi-region ingestion must stay capped, saw ${symbols.functionCount}`);
  assert.equal(symbols.functionDiscovery.complete, false);
});

test('5105: once the global cap is exhausted, no further region scan starts', async () => {
  const guessCalls = [];
  const symbols = {
    functionStartsComplete: false,
    functionCount: DISCOVERY_GLOBAL_CAP - 1,
    addFunctions(starts) {
      this.functionCount += starts.length;
      return starts.length;
    },
  };
  const baseline = {
    symbols,
    backend: {
      guessFunctions(regionId, share) {
        guessCalls.push(regionId);
        // A wildly over-returning backend burns nothing beyond the share.
        return Promise.resolve({ starts: Array.from({ length: 10 }, (_, i) => BigInt(0x100 + i)), discoveryComplete: true });
      },
    },
    slice: {
      regions: [
        { id: 'text-a', vmAddr: '0x1000', size: 0x1000, exec: true },
        { id: 'text-b', vmAddr: '0x2000', size: 0x1000, exec: true },
      ],
    },
  };
  await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.deepEqual(guessCalls, ['text-a'], 'the exhausted budget must skip later regions');
  assert.equal(symbols.functionCount, DISCOVERY_GLOBAL_CAP);
  assert.equal(baseline.symbols.functionDiscovery.regions[1].skipped, true);
});

test('5105: duplicate-heavy over-return keeps budget accounting debit-by-added explicit', async () => {
  const symbols = {
    functionStartsComplete: false,
    functionCount: DISCOVERY_GLOBAL_CAP - 2,
    addFunctions(starts) {
      // Deduplicate against already-known starts and debit by the new count.
      const fresh = starts.filter((s) => s !== 0x77n);
      this.functionCount += fresh.length;
      return fresh.length;
    },
  };
  let started = 0;
  const baseline = {
    symbols,
    backend: {
      guessFunctions(regionId) {
        started++;
        return Promise.resolve({ starts: [0x77n, 0x77n, 0x77n, 0x77n, 0x77n], discoveryComplete: true });
      },
    },
    slice: {
      regions: [
        { id: 'text-a', vmAddr: '0x1000', size: 0x1000, exec: true },
        { id: 'text-b', vmAddr: '0x2000', size: 0x1000, exec: true },
      ],
    },
  };
  await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.equal(started, 2, 'duplicate-only returns must not burn the budget (#5558 semantics preserved)');
  assert.ok(symbols.functionCount <= DISCOVERY_GLOBAL_CAP);
});

test('5105: cancellation and discovery-failure behavior are preserved', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions({
      symbols: { functionStartsComplete: false, functionCount: 0, addFunctions: () => 0 },
      backend: { guessFunctions: () => Promise.resolve({ starts: [], discoveryComplete: true }) },
      slice: { regions: [TEXT] },
    }, { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
  const symbols = { functionStartsComplete: false, functionCount: 0, addFunctions: () => 0 };
  await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions({
    symbols,
    backend: { guessFunctions: () => Promise.reject(new Error('backend exploded')) },
    slice: { regions: [TEXT] },
  }, {});
  assert.equal(symbols.functionDiscovery.complete, false);
  assert.ok(symbols.functionDiscovery.reasons.some((r) => r.includes('function-discovery-failed')));
});
