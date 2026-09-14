import assert from 'node:assert/strict';
import { installDemandDrivenAnalysis, __demandDrivenInternalsForTests } from '../../js/analysis/demand-driven-runtime.js';

// #5267: successful discovery producers retain epoch-local symbol closures.
// Exercise the real producer path from fresh incomplete symbols, then prove the
// settled producer cache converges to its existing 32-entry budget.

const CACHE_BUDGET = 32;
let activeRegions = [{ id: 'text', exec: true, size: 64 }];
let guessCalls = 0;

function completedGuess(start = 0x1000n) {
  return { starts: [start], discoveryComplete: true };
}

const app = {
  backend: {
    gen: 0,
    guessFunctions: async () => {
      guessCalls++;
      return completedGuess(0x1000n + BigInt(guessCalls));
    },
  },
  symbols: null,
  programRegions: () => activeRegions,
};

function freshSymbols(gen) {
  return {
    gen,
    functionCount: 0,
    functionStartsComplete: false,
    addFunctions(starts) {
      this.functionCount += starts.length;
    },
  };
}

installDemandDrivenAnalysis(app);

const RUNS = 40;
for (let epoch = 1; epoch <= RUNS; epoch++) {
  app.backend.gen = epoch;
  app.symbols = freshSymbols(epoch);
  const value = await app.ensureFunctions(activeRegions[0]);
  assert.equal(value, app.symbols);
  assert.equal(value.functionDiscovery?.complete, true,
    `epoch ${epoch}: real guessFunctions success must publish complete discovery`);
  assert.equal(value.functionStartsComplete, true);
}
assert.equal(guessCalls, RUNS,
  'every fresh incomplete epoch must traverse the real discovery producer path');

const producers = __demandDrivenInternalsForTests.discoveryProducersByApp.get(app);
assert.ok(producers instanceof Map, 'discovery producers map must be registered for focused retention checks');
assert.equal(
  producers.size,
  CACHE_BUDGET,
  `settled discovery producers must converge to ${CACHE_BUDGET} entries after ${RUNS} successful epochs`,
);
assert.ok([...producers.values()].every((entry) => entry.settled === true),
  'steady-state retained producer entries must all be settled');
assert.equal(producers.has('1:text'), false, 'oldest settled epoch must be evicted');
assert.equal(producers.has(`${RUNS}:text`), true, 'newest settled epoch must remain cached');

// Completed-symbol fast path must stay ahead of the producer map: same epoch,
// same symbols, and same region must not re-run discovery after cache pruning.
{
  const beforeCalls = guessCalls;
  const beforeSize = producers.size;
  const value = await app.ensureFunctions(activeRegions[0]);
  assert.equal(value, app.symbols);
  assert.equal(guessCalls, beforeCalls, 'completed-symbol fast path must not create another producer');
  assert.equal(producers.size, beforeSize, 'completed-symbol fast path must not mutate producer retention');
}

// Same-key simultaneous consumers must continue to single-flight one producer
// and both remain attached until that producer settles.
{
  app.backend.gen = 100;
  activeRegions = [{ id: 'shared', exec: true, size: 64 }];
  app.symbols = freshSymbols(100);
  let releaseShared;
  let sharedGuessCalls = 0;
  app.backend.guessFunctions = () => {
    sharedGuessCalls++;
    const request = new Promise((resolve) => { releaseShared = resolve; });
    request.cancel = () => {};
    return request;
  };

  const first = app.ensureFunctions(activeRegions[0]);
  const second = app.ensureFunctions(activeRegions[0]);
  assert.equal(sharedGuessCalls, 1, 'same-key simultaneous consumers must share one guessFunctions request');
  const inFlight = [...producers.values()].filter((entry) => entry.settled !== true);
  assert.equal(inFlight.length, 1, 'exactly one shared producer must be in flight');
  assert.equal(inFlight[0].waiters, 2, 'both simultaneous consumers must remain attached');

  releaseShared(completedGuess(0x3000n));
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right, 'simultaneous consumers must observe the same settled symbols object');
  assert.equal(left.functionDiscovery?.complete, true);
  assert.ok(producers.size <= CACHE_BUDGET, 'shared settle must converge to the cache budget');

  const beforeFastPath = sharedGuessCalls;
  await app.ensureFunctions(activeRegions[0]);
  assert.equal(sharedGuessCalls, beforeFastPath,
    'post-settle completed-symbol fast path must not re-run the shared producer');
}

// A burst may temporarily exceed the settled-cache budget while all producers
// are in flight. Pruning must never evict live work, and every settle races the
// same pruning rule so the map converges without requiring a later insertion.
{
  app.backend.gen = 200;
  const releases = [];
  let raceGuessCalls = 0;
  app.backend.guessFunctions = () => {
    raceGuessCalls++;
    let release;
    const request = new Promise((resolve) => { release = resolve; });
    request.cancel = () => {};
    releases.push(release);
    return request;
  };

  const pending = [];
  for (let index = 0; index < RUNS; index++) {
    activeRegions = [{ id: `race-${index}`, exec: true, size: 64 }];
    app.symbols = freshSymbols(200);
    pending.push(app.ensureFunctions(activeRegions[0]));
  }

  assert.equal(raceGuessCalls, RUNS, 'burst must create one producer for each distinct region-set key');
  assert.equal(
    [...producers.values()].filter((entry) => entry.settled !== true).length,
    RUNS,
    'all burst producers must remain retained while in flight',
  );
  assert.equal(producers.size, RUNS,
    'in-flight work may temporarily exceed the settled cache budget rather than being evicted');

  for (let index = 0; index < releases.length; index++) {
    releases[index](completedGuess(0x4000n + BigInt(index)));
  }
  await Promise.all(pending);

  assert.equal(producers.size, CACHE_BUDGET,
    'settle-race pruning must converge to the cache budget without another insertion');
  assert.ok([...producers.values()].every((entry) => entry.settled === true),
    'after burst settlement every retained entry must be settled');
}

console.log('phase7 demand issue-5267 discovery producer retention bounded: PASS');
