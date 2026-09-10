import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/product-adapter.js';

function appWithProber(calls) {
  const pending = [];
  const app = {
    backend: { gen: 1 },
    programRegions() { return []; },
    symbols: {
      functionCount: 0,
      functionStartsComplete: false,
      functionDiscovery: null,
      addFunctions() {},
    },
  };
  app.ensureFunctions = function (region) {
    calls.push(region?.id);
    return Promise.resolve({ starts: [], complete: true, discoveryComplete: true });
  };
  return app;
}

test('#5580 structured and canonical region ids never share one discovery producer', async () => {
  const calls = [];
  const app = appWithProber(calls);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // The first producer stays pending so the second request must hit the
  // single-flight map to be shared — settlement would legitimately re-run.
  app.ensureFunctions = function (region) {
    calls.push(region?.id);
    return calls.length === 1 ? gate : Promise.resolve({ starts: [], complete: true, discoveryComplete: true });
  };
  createAppAnalysisQueryAdapter(app);
  const a = app.ensureFunctions({ id: ['text'], exec: true });
  const b = app.ensureFunctions({ id: 'text', exec: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 2, `structured ['text'] and canonical 'text' must start separate producers while the first is pending, saw ${calls.length}`);
  assert.deepEqual(calls.map(String), ['text', 'text']);
  release({ starts: [], complete: true, discoveryComplete: true });
  await Promise.all([a, b]);
});

test('#5580 the same canonical region id still single-flights', async () => {
  const calls = [];
  const app = appWithProber(calls);
  createAppAnalysisQueryAdapter(app);
  const a = app.ensureFunctions({ id: 'text', exec: true });
  const b = app.ensureFunctions({ id: 'text', exec: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1, `identical canonical requests must share one producer, saw ${calls.length}`);
  await Promise.all([a, b]);
});

test('#5580 discovery key distinguishes structured ids among program regions', async () => {
  // Regions from programRegions() participate in the key: a structured id
  // there must not collide with its stringified spelling either.
  const calls = [];
  const app = appWithProber(calls);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  app.ensureFunctions = function (region) {
    calls.push(region?.id);
    return calls.length === 1 ? gate : Promise.resolve({ starts: [], complete: true, discoveryComplete: true });
  };
  app.programRegions = () => [{ id: ['text'], exec: true }];
  createAppAnalysisQueryAdapter(app);
  const a = app.ensureFunctions({ id: ['text'], exec: true });
  const b = app.ensureFunctions({ id: 'text', exec: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 2, `program-region structured id must not collide with the canonical spelling, saw ${calls.length}`);
  release({ starts: [], complete: true, discoveryComplete: true });
  await Promise.all([a, b]);
});
