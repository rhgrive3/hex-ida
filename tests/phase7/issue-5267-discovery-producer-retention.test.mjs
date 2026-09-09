import assert from 'node:assert/strict';
import { installDemandDrivenAnalysis, __demandDrivenInternalsForTests } from '../../js/analysis/demand-driven-runtime.js';

// #5267: settled success producers must be bounded, not retained forever.
// Drive N discoveries across distinct epochs and assert the producer map
// converges to the bounded budget instead of accumulating one entry per epoch.

function makeApp() {
  const regions = [{ id: 'text', exec: true, size: 64 }];
  const app = {
    backend: {
      gen: 0,
      guessFunctions: async (regionId, limit) => ({
        starts: [0x1000n, 0x2000n],
        discoveryComplete: true,
      }),
    },
    symbols: null,
    store: new Map([['regions', regions], ['currentRegion', regions[0]]]),
  };
  app.store.get = (key) => app.store.get;
  return app;
}

function freshSymbols(gen) {
  return {
    gen,
    functionCount: 2,
    functionStartsComplete: false,
    addFunctions() {},
  };
}

function symbolsFor(app, gen) {
  const symbols = freshSymbols(gen);
  symbols.functionDiscovery = { complete: true, attempted: true, regionSetKey: 'text', regions: [], reasons: [] };
  return symbols;
}

const app = makeApp();
installDemandDrivenAnalysis(app);
const producers = __demandDrivenInternalsForTests.discoveryProducersByApp.get(app);
assert.ok(producers instanceof Map, 'discovery producers map must be registered for tests');

const RUNS = 40;
for (let epoch = 1; epoch <= RUNS; epoch++) {
  app.backend.gen = epoch;
  // Short-circuit contract: the epoch's symbols already record a completed
  // discovery over the same region set, so ensureFunctions must not consult
  // the producer map for past epochs' keys.
  app.symbols = symbolsFor(app, epoch);
  await app.ensureFunctions({ id: 'text', exec: true, size: 64 });
}

assert.ok(
  producers.size <= 32,
  `settled discovery producers must be bounded (got ${producers.size} after ${RUNS} epochs)`,
);

// In-flight producers are never evicted by pruning: start one, verify the
// pending entry coexists with settled entries, then let it settle.
app.backend.gen = 999;
let releaseGuess;
app.backend.guessFunctions = () => new Promise((resolve) => { releaseGuess = resolve; });
app.symbols = freshSymbols(999);
const pending = app.ensureFunctions({ id: 'text', exec: true, size: 64 });
await new Promise((resolve) => setTimeout(resolve, 0));
const inFlight = [...producers.values()].filter((entry) => entry.settled !== true);
assert.equal(inFlight.length, 1, 'exactly the new producer must be in flight');
releaseGuess({ starts: [0x3000n], discoveryComplete: true });
await pending;
assert.ok(
  [...producers.values()].every((entry) => entry.settled === true),
  'after settle+prune only settled entries may remain',
);

console.log('phase7 demand issue-5267 discovery producer retention bounded: PASS');
