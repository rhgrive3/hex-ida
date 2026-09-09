import test from 'node:test';
import assert from 'node:assert/strict';
import { InvestigationService, __investigationInternalsForTests } from '../../js/analysis/investigation-service.js';

const { captureAnalysisBinding, analysisBindingCurrent } = __investigationInternalsForTests;

function baseApp(overrides = {}) {
  const region = { id:'text', exec:true, vmAddr:0n, size:4n };
  return {
    backend:{ gen:1 },
    analysisEpoch:1,
    fields:null,
    program:null,
    shapes:null,
    symbols:{ gen:1 },
    store:{ get(key) { return key === 'sliceIndex' ? 0 : null; } },
    codeRegion(){ return region; },
    programRegions(){ return [region]; },
    ...overrides,
  };
}

function stubService(app) {
  const service = new InvestigationService(app);
  service.collectStrings = async () => Object.assign([], { complete:true });
  service.buildProgram = async () => null;
  return service;
}

test('#5330 program publication during snapshot await invalidates prepareGoal binding', async () => {
  const app = baseApp();
  app.analysisQueries = {
    async snapshot() {
      app.program = { gen:1, graphCompleteness:{ complete:true } };
      return { snapshotId:'snapshot-after-program-publication' };
    },
  };
  const service = stubService(app);

  await assert.rejects(
    service.prepareGoal({ id:'custom', expects:{} }),
    (error) => error?.code === 'ANALYSIS_SNAPSHOT_STALE',
  );
});

test('#5330 shapes publication during snapshot await invalidates prepareGoal binding', async () => {
  const app = baseApp();
  app.analysisQueries = {
    async snapshot() {
      app.shapes = new Map([['late', { offset:0 }]]);
      return { snapshotId:'snapshot-after-shapes-publication' };
    },
  };
  const service = stubService(app);
  service.collectShapes = async () => null;
  service.ensureMetadata = async () => ({ fields:null, complete:true });

  await assert.rejects(
    service.prepareGoal({ id:'hp', expects:{ numeric:true } }),
    (error) => error?.code === 'ANALYSIS_SNAPSHOT_STALE',
  );
});

test('#5330 nullable artifact identity detects both publication and replacement', () => {
  const app = baseApp();
  const empty = captureAnalysisBinding(app);
  assert.equal(analysisBindingCurrent(app, empty), true);

  app.program = { gen:1 };
  assert.equal(analysisBindingCurrent(app, empty), false, 'program null -> object must stale');
  app.program = null;
  app.shapes = new Map();
  assert.equal(analysisBindingCurrent(app, empty), false, 'shapes null -> object must stale');
  app.shapes = null;
  app.fields = {};
  assert.equal(analysisBindingCurrent(app, empty), false, 'fields null -> object must remain stale');
});

test('#5330 object replacement remains stale for program and shapes', () => {
  const program = { gen:1 };
  const shapes = new Map();
  const app = baseApp({ program, shapes });
  const binding = captureAnalysisBinding(app);
  assert.equal(analysisBindingCurrent(app, binding), true);

  app.program = { gen:1 };
  assert.equal(analysisBindingCurrent(app, binding), false, 'program object A -> object B must stale');
  app.program = null;
  assert.equal(analysisBindingCurrent(app, binding), false, 'program object -> null must stale');
  app.program = program;
  app.shapes = new Map();
  assert.equal(analysisBindingCurrent(app, binding), false, 'shapes object A -> object B must stale');
  app.shapes = null;
  assert.equal(analysisBindingCurrent(app, binding), false, 'shapes object -> null must stale');
});

test('#5330 null and absent properties represent the same missing artifact', () => {
  const app = baseApp();
  delete app.fields;
  delete app.program;
  delete app.shapes;
  const binding = captureAnalysisBinding(app);
  assert.equal(analysisBindingCurrent(app, binding), true);

  app.fields = null;
  app.program = null;
  app.shapes = null;
  assert.equal(analysisBindingCurrent(app, binding), true);
});

test('#5330 unchanged artifact identities remain current', () => {
  const fields = {};
  const program = { gen:1 };
  const shapes = new Map();
  const app = baseApp({ fields, program, shapes });
  const binding = captureAnalysisBinding(app);
  assert.equal(analysisBindingCurrent(app, binding), true);
});

test('#5330 unpublished partial program binding remains valid when canonical app.program differs', () => {
  const symbols = { gen:1 };
  const published = { symbols, gen:1, graphCompleteness:{ complete:true } };
  const partial = { symbols, gen:1, graphCompleteness:{ complete:false } };
  const app = baseApp({ symbols, program:published });
  const binding = captureAnalysisBinding(app, { program:partial });

  assert.equal(binding.programPublished, false);
  assert.equal(analysisBindingCurrent(app, binding), true, 'budget-scoped partial program may be bound without replacing canonical app.program');
});
