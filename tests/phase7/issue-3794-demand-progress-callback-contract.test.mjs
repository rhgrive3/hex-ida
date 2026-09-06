import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

const region = { id:'text', exec:true, size:16n };

function makeShapesApp() {
  const app = {
    backend: {
      gen:1,
      valueShapes(_regionId, onProgress) {
        onProgress?.({ done:1, all:1 });
        const request = Promise.resolve({ count:0 });
        request.cancel = () => {};
        return request;
      },
    },
    programRegions:() => [region],
  };
  installDemandDrivenAnalysis(app);
  return app;
}

function makeFunctionsApp() {
  const symbols = {
    functionCount:0,
    functionStartsComplete:false,
    functionDiscovery:{ complete:false },
    addFunctions() {},
  };
  const app = {
    backend: {
      gen:1,
      guessFunctions(_regionId, _limit, onProgress) {
        onProgress?.({ done:1, all:1 });
        const request = Promise.resolve({ starts:[], complete:true });
        request.cancel = () => {};
        return request;
      },
    },
    symbols,
    programRegions:() => [region],
  };
  installDemandDrivenAnalysis(app);
  return app;
}

for (const bad of [true, {}, []]) {
  test(`#3794 shapes ignore non-callable onProgress (${Object.prototype.toString.call(bad)})`, async () => {
    const app = makeShapesApp();
    await assert.doesNotReject(app.ensureShapes({ onProgress:bad }));
  });

  test(`#3794 function discovery ignores non-callable onProgress (${Object.prototype.toString.call(bad)})`, async () => {
    const app = makeFunctionsApp();
    await assert.doesNotReject(app.ensureFunctions(region, { onProgress:bad }));
    assert.equal(app.symbols.functionStartsComplete, true);
  });
}

test('#3794 valid progress callbacks preserve payloads', async () => {
  const shapeEvents = [];
  const shapes = makeShapesApp();
  await shapes.ensureShapes({ onProgress:(event) => shapeEvents.push(event) });
  assert.deepEqual(shapeEvents, [{ phase:'shapes', region:'text', done:1, all:1 }]);

  const functionEvents = [];
  const functions = makeFunctionsApp();
  await functions.ensureFunctions(region, { onProgress:(event) => functionEvents.push(event) });
  assert.deepEqual(functionEvents, [{ phase:'functions', region:'text', done:1, all:1 }]);
});

test('#3794 legacy direct callback forms remain supported', async () => {
  const shapeEvents = [];
  const shapes = makeShapesApp();
  await shapes.ensureShapes((event) => shapeEvents.push(event));
  assert.equal(shapeEvents.length, 1);
  assert.equal(shapeEvents[0].phase, 'shapes');

  const functionEvents = [];
  const functions = makeFunctionsApp();
  await functions.ensureFunctions(region, (event) => functionEvents.push(event));
  assert.equal(functionEvents.length, 1);
  assert.equal(functionEvents[0].phase, 'functions');
});

test('#3794 nullish progress handlers remain no-ops', async () => {
  const shapes = makeShapesApp();
  await assert.doesNotReject(shapes.ensureShapes({ onProgress:null }));

  const functions = makeFunctionsApp();
  await assert.doesNotReject(functions.ensureFunctions(region, { onProgress:undefined }));
});
