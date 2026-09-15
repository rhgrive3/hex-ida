import test from 'node:test';
import assert from 'node:assert/strict';

import { InvestigationService } from '../../js/analysis/investigation-service.js';

// #5279: `ensureMetadata()` ran the ObjC/Swift producers under
// `Promise.allSettled()` and then discarded the settled results, so a producer
// rejection still returned a "success" metadata object. `completenessFor()`
// had no metadata dimension at all, so a metadata-dependent goal published
// `complete:true` over missing ObjC/Swift evidence, and that flag propagated to
// typed candidates.

const region = { id:'text', exec:true, vmAddr:0n, size:4n };

function fixtureApp(overrides = {}) {
  return {
    backend:{ gen:1 },
    analysisEpoch:1,
    fields:null,
    objcModel:null,
    swiftModel:null,
    program:null,
    shapes:null,
    symbols:{ gen:1 },
    store:{ get:(key) => (key === 'sliceIndex' ? 0 : null) },
    codeRegion:() => region,
    programRegions:() => [region],
    analysisQueries:{
      snapshot:async () => ({ snapshotId:'snapshot-5279' }),
      binaryInfo:async () => ({}),
    },
    ...overrides,
  };
}

function serviceFor(app) {
  const service = new InvestigationService(app);
  service.collectStrings = async () => Object.assign([], { complete:true });
  // #8809 sync: #5284's canonical program binding requires the built
  // program to carry the published symbols identity; an unbound program is
  // rejected as ANALYSIS_SNAPSHOT_STALE before the metadata assertions run.
  // #8809 sync: the #5284 binding rejects unpublished artifacts, so the
  // stubs must publish program/shapes onto the app like the real producers.
  service.buildProgram = async () => {
    const program = { gen:1, symbols:app.symbols, graphCompleteness:{ complete:true } };
    app.program = program;
    return program;
  };
  service.collectShapes = async () => {
    if (app.shapes) return app.shapes;
    const shapes = Object.assign(new Map(), { complete:true });
    app.shapes = shapes;
    return shapes;
  };
  return service;
}

const metadataGoal = { id:'hp', text:'hp field', expects:{ numeric:true } };
const plainGoal = { id:'custom', text:'nothing typed', expects:{} };

test('#5279 ObjC producer rejection makes a metadata-dependent goal partial', async () => {
  const app = fixtureApp({
    ensureObjc:async () => { throw new Error('objc parse failed'); },
    ensureSwift:async () => ({ ok:true }),
  });
  const context = await serviceFor(app).prepareGoal(metadataGoal);

  assert.equal(context.metadata.complete, false, 'metadata coverage must report the producer failure');
  assert.equal(context.completeness.complete, false, 'a metadata-dependent goal must not publish complete');
  assert.ok(context.completeness.reasons.some((reason) => /objc/i.test(reason)),
    `the failing producer must be named in reasons, got ${JSON.stringify(context.completeness.reasons)}`);
});

test('#5279 Swift producer rejection makes a metadata-dependent goal partial', async () => {
  const app = fixtureApp({
    ensureObjc:async () => ({ ok:true }),
    ensureSwift:async () => { throw new Error('swift parse failed'); },
  });
  const context = await serviceFor(app).prepareGoal(metadataGoal);

  assert.equal(context.metadata.complete, false);
  assert.equal(context.completeness.complete, false);
  assert.ok(context.completeness.reasons.some((reason) => /swift/i.test(reason)),
    `the failing producer must be named in reasons, got ${JSON.stringify(context.completeness.reasons)}`);
});

test('#5279 both producers failing keeps both reasons and never promotes to complete', async () => {
  const app = fixtureApp({
    ensureObjc:async () => { throw new Error('objc parse failed'); },
    ensureSwift:async () => { throw new Error('swift parse failed'); },
  });
  const context = await serviceFor(app).prepareGoal(metadataGoal);

  assert.equal(context.completeness.complete, false);
  assert.ok(context.completeness.reasons.some((reason) => /objc/i.test(reason)));
  assert.ok(context.completeness.reasons.some((reason) => /swift/i.test(reason)));
});

test('#5279 successful producers with complete evidence stay complete', async () => {
  const fields = { classCount:1 };
  const objcModel = { classes:[] };
  const swiftModel = { types:[] };
  const app = fixtureApp({
    fields,
    objcModel,
    swiftModel,
    ensureObjc:async () => { app.fields = fields; app.objcModel = objcModel; return objcModel; },
    ensureSwift:async () => { app.swiftModel = swiftModel; return swiftModel; },
  });
  const context = await serviceFor(app).prepareGoal(metadataGoal);

  assert.equal(context.metadata.complete, true);
  assert.deepEqual(context.metadata.reasons, []);
  assert.equal(context.completeness.complete, true,
    `all-complete evidence must stay complete, got ${JSON.stringify(context.completeness.reasons)}`);
  assert.deepEqual(context.completeness.reasons, []);
});

test('#5279 a goal that needs no metadata keeps producer failures out of the denominator', async () => {
  let objcRuns = 0;
  const app = fixtureApp({
    ensureObjc:async () => { objcRuns++; throw new Error('objc parse failed'); },
    ensureSwift:async () => { throw new Error('swift parse failed'); },
  });
  const service = serviceFor(app);
  const context = await service.prepareGoal(plainGoal);

  // #8809 sync: for a goal without metadata demand the current contract
  // collects no producer evidence at all (the producers must not run), so
  // there is no recorded producer failure to observe; the guarantee under
  // test is that completeness stays complete and no unused producer work
  // is requested.
  assert.equal(context.metadata.complete, undefined, 'metadata is not collected for a goal that does not demand it');
  assert.equal(context.completeness.complete, true,
    `a goal without metadata demand must not inherit metadata reasons, got ${JSON.stringify(context.completeness.reasons)}`);
  assert.equal(objcRuns, 0, 'objectionable unused producer work must stay unrequested');
});

test('#5279 metadata producer cancellation keeps AbortError semantics', async () => {
  const controller = new AbortController();
  const app = fixtureApp({
    ensureObjc:async ({ signal } = {}) => {
      controller.abort('cancel-metadata');
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name:'AbortError' });
      return { ok:true };
    },
    ensureSwift:async () => ({ ok:true }),
  });
  await assert.rejects(
    serviceFor(app).prepareGoal(metadataGoal, { signal:controller.signal }),
    (error) => error?.name === 'AbortError',
  );
});

test('#5279 metadata failure propagates to typed candidate completeness', async () => {
  const app = fixtureApp({
    symbols:{ gen:1 },
    ensureObjc:async () => { throw new Error('objc parse failed'); },
    ensureSwift:async () => ({ ok:true }),
  });
  app.stringIndex = Object.assign([], { complete:true, __lookup:() => null });
  const service = new InvestigationService(app);
  service.collectStrings = async () => Object.assign([], { complete:true });
  // #8809 sync: #5284's canonical program binding requires the built
  // program to carry the published symbols identity; an unbound program is
  // rejected as ANALYSIS_SNAPSHOT_STALE before the metadata assertions run.
  // #8809 sync: the #5284 binding rejects unpublished artifacts, so the
  // stubs must publish program/shapes onto the app like the real producers.
  service.buildProgram = async () => {
    const program = { gen:1, symbols:app.symbols, graphCompleteness:{ complete:true } };
    app.program = program;
    return program;
  };
  service.collectShapes = async () => {
    if (app.shapes) return app.shapes;
    const shapes = Object.assign(new Map([['shape', { offset:0 }]]), { complete:true });
    app.shapes = shapes;
    return shapes;
  };
  const report = await service.investigate(metadataGoal);

  assert.equal(report.completeness.complete, false);
  for (const candidate of report.candidates) {
    assert.equal(candidate.completeness, 'partial',
      'typed candidates must not claim complete evidence context');
    assert.ok(candidate.missing.length > 0, 'typed candidates must carry the missing metadata reasons');
  }
});
