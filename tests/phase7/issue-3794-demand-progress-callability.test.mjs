import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

const region = { id:'text', exec:true, size:4n, vmAddr:0n };
const malformedCallbacks = [true, {}, [], 'progress', 1];

function shapesApp() {
  const app = {
    backend: {
      gen:1,
      valueShapes(_regionId, onProgress) {
        onProgress({ done:1, all:1 });
        return Promise.resolve({ count:0 });
      },
    },
    programRegions() { return [region]; },
  };
  installDemandDrivenAnalysis(app);
  return app;
}

function functionsApp() {
  const app = {
    backend: {
      gen:1,
      guessFunctions(_regionId, _share, onProgress) {
        const request = Promise.resolve().then(() => {
          onProgress({ done:1, all:1 });
          return { starts:[], discoveryComplete:true };
        });
        request.cancel = () => {};
        return request;
      },
    },
    symbols: {
      gen:0,
      functionCount:0,
      functionStartsComplete:false,
      funcs:[],
      functionAt() { return null; },
      addFunctions() {},
    },
    programRegions() { return [region]; },
  };
  installDemandDrivenAnalysis(app);
  return app;
}

test('#3794 non-callable shapes progress is advisory and never aborts analysis', async () => {
  for (const onProgress of malformedCallbacks) {
    const app = shapesApp();
    await assert.doesNotReject(app.ensureShapes({ onProgress }));
  }
});

test('#3794 callable shapes progress keeps its payload', async () => {
  const app = shapesApp();
  const seen = [];
  await app.ensureShapes({ onProgress:(payload) => seen.push(payload) });
  assert.deepEqual(seen, [{ phase:'shapes', region:'text', done:1, all:1 }]);
});

test('#3794 non-callable function-discovery progress remains a no-op', async () => {
  for (const onProgress of malformedCallbacks) {
    const app = functionsApp();
    await assert.doesNotReject(app.ensureFunctions(region, { onProgress }));
  }
});

test('#3794 callable function-discovery progress keeps its payload', async () => {
  const app = functionsApp();
  const seen = [];
  await app.ensureFunctions(region, { onProgress:(payload) => seen.push(payload) });
  assert.deepEqual(seen, [{ phase:'functions', region:'text', done:1, all:1 }]);
});
