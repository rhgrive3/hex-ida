import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installDemandDrivenAnalysis,
  __demandDrivenInternalsForTests,
} from '../../../js/analysis/demand-driven-runtime.js';

const REGION = { id:'text', exec:true, vmAddr:0x1000n, size:0x100n };

function invalidIdentity(error, code) {
  return error instanceof TypeError && error.message === code;
}

test('#4020 recognition cache identity never coerces structured generations', async () => {
  let recognitionCalls = 0;
  const app = {
    backend:{ gen:['7'] },
    symbols:{ gen:2 },
    knowledge:{ revision:3 },
    async ensureRecognition() {
      recognitionCalls++;
      const value = { call:recognitionCalls };
      this.recognition = value;
      return value;
    },
  };
  installDemandDrivenAnalysis(app);

  await assert.rejects(
    app.ensureRecognition(),
    (error) => invalidIdentity(error, 'demand-analysis-epoch-invalid'),
  );
  assert.equal(recognitionCalls, 0, 'invalid generation must not start or populate recognition');

  app.backend.gen = 7;
  const canonical = await app.ensureRecognition();
  assert.equal(canonical.call, 1);
  assert.equal(await app.ensureRecognition(), canonical, 'canonical generation keeps its recognition cache hit');
  assert.equal(recognitionCalls, 1, 'canonical generation gets one producer result and reuses it');
});

test('#4020 recognition key validates every generation component before cache authority', () => {
  const base = { backend:{ gen:1 }, symbols:{ gen:2 }, knowledge:{ revision:3 } };
  assert.doesNotThrow(() => __demandDrivenInternalsForTests.recognitionInputKey(base));
  const coercionTrap = { valueOf() { throw new Error('numeric coercion must not run'); } };
  for (const [field, app, code] of [
    ['analysis-array', { ...base, backend:{ gen:['1'] } }, 'demand-analysis-epoch-invalid'],
    ['analysis-string', { ...base, backend:{ gen:'1' } }, 'demand-analysis-epoch-invalid'],
    ['analysis-boolean', { ...base, backend:{ gen:true } }, 'demand-analysis-epoch-invalid'],
    ['analysis-object', { ...base, backend:{ gen:coercionTrap } }, 'demand-analysis-epoch-invalid'],
    ['symbols', { ...base, symbols:{ gen:'2' } }, 'demand-symbol-generation-invalid'],
    ['knowledge', { ...base, knowledge:{ revision:true } }, 'demand-knowledge-revision-invalid'],
  ]) {
    assert.throws(
      () => __demandDrivenInternalsForTests.recognitionInputKey(app),
      (error) => invalidIdentity(error, code),
      `${field} identity must fail closed without JavaScript coercion`,
    );
  }
});

test('#4020 structured slice index is rejected before ObjC metadata routing', async () => {
  let objcCalls = 0;
  let recognitionCalls = 0;
  let sliceIndex = ['1'];
  let routedSlice = null;
  const app = {
    backend:{ gen:1 },
    symbols:{ gen:0 },
    knowledge:{ revision:0 },
    store:{ get(key) { return key === 'sliceIndex' ? sliceIndex : null; } },
    async ensureObjc(index) { objcCalls++; routedSlice = index; return {}; },
    async ensureRecognition() { recognitionCalls++; return { ok:true }; },
  };
  installDemandDrivenAnalysis(app);

  await assert.rejects(
    app.ensureRecognition(),
    (error) => invalidIdentity(error, 'demand-slice-index-invalid'),
  );
  assert.equal(objcCalls, 0, 'malformed slice must not route to ensureObjc(1)');
  assert.equal(recognitionCalls, 0, 'recognition must not run on malformed routing identity');

  sliceIndex = 1;
  await app.ensureRecognition();
  assert.equal(objcCalls, 1, 'canonical slice still performs metadata bootstrap');
  assert.equal(routedSlice, 1, 'canonical slice reaches ensureObjc without conversion');
  assert.equal(recognitionCalls, 1);
});

test('#4020 shapes cache rejects structured epoch instead of sharing with canonical epoch', async () => {
  let shapeCalls = 0;
  const app = {
    backend:{
      gen:['4'],
      valueShapes() { shapeCalls++; return Promise.resolve({ count:0, complete:true, capped:false, unsupported:false }); },
    },
    programRegions() { return [REGION]; },
  };
  installDemandDrivenAnalysis(app);

  await assert.rejects(
    app.ensureShapes(),
    (error) => invalidIdentity(error, 'demand-analysis-epoch-invalid'),
  );
  assert.equal(shapeCalls, 0, 'invalid epoch must not start or populate a shape producer');

  app.backend.gen = 4;
  const canonical = await app.ensureShapes();
  assert.equal(await app.ensureShapes(), canonical, 'canonical epoch keeps the shape cache hit');
  assert.equal(shapeCalls, 1, 'canonical epoch must run one shape producer and reuse it');
});

test('#4020 function discovery rejects structured epoch before single-flight/cache authority', async () => {
  let discoveryCalls = 0;
  const symbols = {
    gen:0,
    functionCount:0,
    functionStartsComplete:false,
    functionDiscovery:null,
    addFunctions() {},
  };
  const app = {
    backend:{
      gen:['9'],
      guessFunctions() {
        discoveryCalls++;
        return Promise.resolve({ starts:[], complete:true, discoveryComplete:true });
      },
    },
    symbols,
    programRegions() { return [REGION]; },
  };
  installDemandDrivenAnalysis(app);

  await assert.rejects(
    app.ensureFunctions(REGION),
    (error) => invalidIdentity(error, 'demand-analysis-epoch-invalid'),
  );
  assert.equal(discoveryCalls, 0, 'invalid epoch must not start or populate discovery');
  assert.equal(symbols.functionDiscovery, null);

  app.backend.gen = 9;
  await app.ensureFunctions(REGION);
  await app.ensureFunctions(REGION);
  assert.equal(discoveryCalls, 1, 'canonical epoch must run one discovery producer and reuse its result');
  assert.equal(symbols.functionDiscovery?.attempted, true);
});
