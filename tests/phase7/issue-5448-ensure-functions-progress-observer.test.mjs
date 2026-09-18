// Regression for #5448: App.ensureFunctions() attached the progress observer
// to the backend callback with a truthiness check (`onProgress && ...`), so
// truthy non-functions (true, {}, []) were invoked by the backend at the first
// progress tick and aborted function discovery with a raw TypeError.
// Contract now: the observer is normalized exactly like ensureProgram/
// ensureStrings — functions pass through, an options object's `.onProgress`
// is honored, and every other shape is inert (no callback registered).
import assert from 'node:assert/strict';
import { App } from '../../js/app.js';
import { EMPTY_INDEX } from '../../js/symbols.js';

const execRegion = { id: 'text', section: '__text', vmAddr: 0x1000n, size: 0x100n, exec: true };

function makeApp(backend) {
  const instance = Object.create(App.prototype);
  instance.backend = { gen: 1, ...backend };
  instance.symbolsReady = null;
  instance.symbols = EMPTY_INDEX;
  instance.store = { get: (key) => (key === 'regions' ? [execRegion] : null) };
  instance.viewer = { setSymbols() {} };
  return instance;
}

async function runEnsureFunctions(onProgress) {
  const delivered = [];
  const app = makeApp({
    guessFunctions: async (_regionId, _share, progress) => {
      if (progress) progress({ done: 1, all: 1 });
      return { starts: [], complete: true };
    },
  });
  const sym = await app.ensureFunctions(execRegion, onProgress);
  return { sym, delivered };
}

// 1. The issue's scenario: `onProgress: true` must not explode.
{
  const { sym } = await runEnsureFunctions(true);
  assert.ok(sym, 'function discovery completes without a raw TypeError');
}

// 2. Other truthy junk is inert too.
{
  const { sym } = await runEnsureFunctions({});
  assert.ok(sym);
  const { sym: sym2 } = await runEnsureFunctions([]);
  assert.ok(sym2);
}

// 3. A real function callback still receives progress events.
{
  const events = [];
  const { sym } = await runEnsureFunctions((p) => events.push(p));
  assert.ok(sym);
  assert.equal(events.length, 1, 'the backend progress tick reaches a callable observer');
  assert.equal(events[0].phase, 'functions');
  assert.equal(events[0].region, 'text');
}

// 4. The options-object spelling routes `.onProgress` (ensureProgram parity).
{
  const events = [];
  const { sym } = await runEnsureFunctions({ onProgress: (p) => events.push(p) });
  assert.ok(sym);
  assert.equal(events.length, 1);
}

// 5. A non-callable `.onProgress` inside an options object is inert, not fatal.
{
  const { sym } = await runEnsureFunctions({ onProgress: true });
  assert.ok(sym);
}

// 6. Absent observer keeps the previous behavior (no callback, still works).
{
  const { sym } = await runEnsureFunctions(undefined);
  assert.ok(sym);
}

console.log('issue-5448 ensure-functions progress observer normalization: ok');
