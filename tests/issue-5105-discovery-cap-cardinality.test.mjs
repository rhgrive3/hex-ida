import test from 'node:test';
import assert from 'node:assert/strict';
import { __symmetricWorkspaceInternalsForTests } from '../js/diff/symmetric-workspace-runtime.js';

// #5105: discoverBaselineFunctions() used DISCOVERY_GLOBAL_CAP only as the
// requested `share` handed to backend.guessFunctions(), never as an ingestion
// bound. A backend returning more `starts` than the requested limit was
// ingested verbatim via symbols.addFunctions(), so the 400000 global cap could
// be exceeded and the completion claim trusted despite lost/overflowing
// results.

const DISCOVERY_GLOBAL_CAP = 400000;

function fixture({ functionCount = 0, known = [], responses = {}, onGuess = null, regions = null } = {}) {
  const guessCalls = [];
  const addedBatches = [];
  const symbols = {
    functionStartsComplete: false,
    functionCount,
    known: new Set(known),
    addFunctions(starts) {
      addedBatches.push([...starts]);
      let added = 0;
      for (const start of starts) {
        if (this.known.has(start)) continue;
        this.known.add(start);
        added++;
      }
      this.functionCount += added;
      return added;
    },
  };
  const backend = {
    guessFunctions(regionId, share, report) {
      guessCalls.push({ regionId, share });
      onGuess?.(regionId, report);
      const response = responses[regionId];
      return {
        cancel() {},
        then(resolve, reject) {
          if (response instanceof Error) reject(response);
          else resolve(response);
        },
      };
    },
  };
  return {
    symbols,
    guessCalls,
    addedBatches,
    baseline: {
      symbols,
      backend,
      slice: {
        regions: regions || [
          { id: 'text-a', vmAddr: '0x1000', size: 0x1000, exec: true },
          { id: 'text-b', vmAddr: '0x2000', size: 0x1000, exec: true },
        ],
      },
    },
  };
}

const singleRegion = [{ id: 'text-a', vmAddr: '0x1000', size: 0x1000, exec: true }];

test('5105: backend over-returning the last budget unit cannot push the global count past the cap', async () => {
  const { baseline, symbols, guessCalls, addedBatches } = fixture({
    functionCount: DISCOVERY_GLOBAL_CAP - 1,
    regions: singleRegion,
    responses: { 'text-a': { starts: [0x1234n, 0x5678n], discoveryComplete: true } },
  });
  await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.deepEqual(guessCalls.map((call) => call.share), [1], 'the request limit stays the proportional share');
  assert.ok(addedBatches.every((batch) => batch.length <= 1), 'no batch may exceed the remaining budget');
  assert.ok(symbols.functionCount <= DISCOVERY_GLOBAL_CAP, `functionCount ${symbols.functionCount} must not exceed ${DISCOVERY_GLOBAL_CAP}`);
});

test('5105: a limit-respecting backend response keeps existing behavior', async () => {
  const { baseline, symbols, addedBatches } = fixture({
    regions: singleRegion,
    responses: { 'text-a': { starts: [0x1n, 0x2n, 0x3n], discoveryComplete: true } },
  });
  const out = await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.deepEqual(addedBatches, [[0x1n, 0x2n, 0x3n]], 'in-budget results are ingested verbatim');
  assert.equal(symbols.functionCount, 3);
  assert.equal(out.functionDiscovery.complete, true);
  assert.deepEqual(out.functionDiscovery.reasons, []);
});

test('5105: an over-limit response is never treated as complete even when the backend claims discoveryComplete', async () => {
  const { baseline, symbols } = fixture({
    functionCount: DISCOVERY_GLOBAL_CAP - 1,
    regions: singleRegion,
    responses: { 'text-a': { starts: [0x1234n, 0x5678n], discoveryComplete: true } },
  });
  const out = await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.equal(out.functionStartsComplete, false, 'the demotion must reach functionStartsComplete');
  assert.equal(out.functionDiscovery.complete, false);
  assert.equal(out.functionDiscovery.capped, true);
  assert.ok(out.functionDiscovery.regions[0].complete === false, 'the region row must record the truncation');
  assert.ok(out.functionDiscovery.regions[0].capped === true, 'the region row must record capped');
  assert.ok(
    out.functionDiscovery.reasons.includes('text-a:backend-result-exceeds-budget'),
    `excess-returns must be recorded as a truncation reason, got ${JSON.stringify(out.functionDiscovery.reasons)}`,
  );
  assert.equal(symbols.functionCount, DISCOVERY_GLOBAL_CAP, 'exactly the budgeted unit is ingested');
});

test('5105: multiple regions combined never breach the global cap', async () => {
  const { baseline, symbols, guessCalls } = fixture({
    functionCount: DISCOVERY_GLOBAL_CAP - 2,
    responses: {
      'text-a': { starts: [0x1n, 0x2n, 0x3n, 0x4n, 0x5n], discoveryComplete: true },
      'text-b': { starts: [0x6n, 0x7n, 0x8n, 0x9n, 0xAn], discoveryComplete: true },
    },
  });
  await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.ok(symbols.functionCount <= DISCOVERY_GLOBAL_CAP, `functionCount ${symbols.functionCount} must not exceed ${DISCOVERY_GLOBAL_CAP}`);
  assert.deepEqual(guessCalls.map((call) => call.share), [1, 1], 'each region requests its own share');
  assert.equal(guessCalls.length, 2, 'both regions are still scanned');
});

test('5105: duplicate starts debit the budget by the actually-added count', async () => {
  const { baseline, symbols, addedBatches } = fixture({
    functionCount: DISCOVERY_GLOBAL_CAP - 3,
    known: [0x1n],
    regions: singleRegion,
    responses: { 'text-a': { starts: [0x1n, 0x2n, 0x3n], discoveryComplete: true } },
  });
  const out = await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.deepEqual(addedBatches, [[0x1n, 0x2n, 0x3n]], 'a share-respecting batch is forwarded whole to the index');
  assert.equal(symbols.functionCount, DISCOVERY_GLOBAL_CAP - 1, 'only the two genuinely new starts are counted');
  assert.equal(out.functionDiscovery.complete, true);
  assert.deepEqual(out.functionDiscovery.reasons, []);
});

test('5105: once the cap is reached no further region backend is started', async () => {
  const { baseline, guessCalls } = fixture({
    functionCount: DISCOVERY_GLOBAL_CAP,
    responses: { 'text-a': { starts: [0x1n], discoveryComplete: true } },
  });
  const out = await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.deepEqual(guessCalls, [], 'guessFunctions must not be called after the cap is exhausted');
  assert.equal(out.functionDiscovery.regions[0].skipped, true);
  assert.equal(out.functionDiscovery.regions[1].skipped, true);
  assert.ok(out.functionDiscovery.reasons.includes('function-global-budget:text-a'));
  assert.ok(out.functionDiscovery.reasons.includes('function-global-budget:text-b'));
});

test('5105: a malformed non-array starts payload fails closed without ingestion', async () => {
  const { baseline, symbols, addedBatches } = fixture({
    regions: singleRegion,
    responses: { 'text-a': { starts: { length: 2 }, discoveryComplete: true } },
  });
  const out = await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.deepEqual(addedBatches, [], 'nothing may reach addFunctions for a malformed response');
  assert.equal(symbols.functionCount, 0);
  assert.equal(out.functionDiscovery.complete, false);
  assert.ok(out.functionDiscovery.reasons.includes('text-a:backend-result-malformed'));
});

test('5105: over-limit responses whose ingested window was pure duplicates keep the #5558 dedupe policy', async () => {
  const { baseline, symbols, addedBatches } = fixture({
    functionCount: DISCOVERY_GLOBAL_CAP - 1,
    known: [0x9999n, 0x999an, 0x999bn],
    regions: [{ id: 'text-a', vmAddr: '0x1000', size: 0x1000, exec: true }],
    responses: { 'text-a': { starts: [0x9999n, 0x999an, 0x999bn], discoveryComplete: true } },
  });
  const out = await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.ok(addedBatches.every((batch) => batch.length <= 1), 'ingestion remains bounded by the budget');
  assert.equal(symbols.functionCount, DISCOVERY_GLOBAL_CAP - 1, 'duplicates debit nothing');
  assert.equal(out.functionDiscovery.complete, true, 'a budget slack response with no new starts stays complete');
  assert.deepEqual(out.functionDiscovery.reasons, []);
});

test('5105: cancellation behavior is preserved', async () => {
  const controller = new AbortController();
  controller.abort();
  const { baseline } = fixture({ responses: { 'text-a': { starts: [], discoveryComplete: true } } });
  await assert.rejects(
    __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
});

test('5105: discovery failure behavior is preserved', async () => {
  const { baseline } = fixture({ responses: { 'text-a': new Error('boom') } });
  const out = await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {});
  assert.equal(out.functionDiscovery.regions[0].error, true);
  assert.equal(out.functionDiscovery.complete, false);
  assert.ok(out.functionDiscovery.reasons.includes('text-a:function-discovery-failed'));
});

test('5105: progress reporting behavior is preserved', async () => {
  const seen = [];
  const { baseline } = fixture({
    regions: singleRegion,
    responses: { 'text-a': { starts: [0x1n], discoveryComplete: true } },
    onGuess: (regionId, report) => report?.({ done: 1, all: 1, region: regionId }),
  });
  await __symmetricWorkspaceInternalsForTests.discoverBaselineFunctions(baseline, {
    onProgress: (event) => seen.push(event),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].phase, 'baseline-functions');
  assert.equal(seen[0].region, 'text-a');
});
