import test from 'node:test';
import assert from 'node:assert/strict';

import { InvestigationService, __investigationInternalsForTests } from '../../js/analysis/investigation-service.js';

const { captureAnalysisBinding } = __investigationInternalsForTests;

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function basicApp(gen = 1) {
  return {
    backend:{ gen },
    store:{ get:() => null },
    symbols:null,
    analysisQueries:{ binaryInfo:async () => ({}) },
  };
}

test('#4062 same-epoch consumers still share one in-flight producer and one consumer cancellation does not cancel the other', async () => {
  const gate = deferred();
  let calls = 0;
  const app = basicApp();
  app.ensureShapes = () => { calls++; return gate.promise; };
  const service = new InvestigationService(app);
  const firstController = new AbortController();
  const secondController = new AbortController();

  const first = service.collectShapes({ signal:firstController.signal });
  const second = service.collectShapes({ signal:secondController.signal });
  await Promise.resolve();
  assert.equal(calls, 1, 'same epoch/key must remain single-flight');

  firstController.abort('first-consumer-only');
  await assert.rejects(first, (error) => error?.name === 'AbortError');
  assert.equal(service.shared.size, 1, 'remaining consumer must retain the live shared producer');

  const shape = { complete:true, marker:'shared' };
  gate.resolve(shape);
  assert.strictEqual(await second, shape);
  assert.equal(calls, 1);
  assert.equal(service.shared.size, 1, 'successful current-epoch memoization is preserved');
});

test('#4062 epoch changes evict settled shared artifacts instead of retaining every prior binary', async () => {
  const app = basicApp(0);
  const service = new InvestigationService(app);

  for (let epoch = 0; epoch < 100; epoch++) {
    app.backend.gen = epoch;
    const metadata = await service.ensureMetadata();
    assert.equal(metadata.complete, true);
    assert.ok(service.shared.size <= 1,
      `shared cache must remain bounded to the active epoch (epoch=${epoch}, size=${service.shared.size})`);
  }

  assert.equal(service.shared.size, 1);
  assert.ok([...service.shared.keys()].every((key) => key.includes('metadata:99')),
    'only the current epoch shared identity may remain retained');
});

test('#4062 switching epoch aborts and rejects a stale in-flight shared result even when its producer ignores AbortSignal', async () => {
  const oldGate = deferred();
  const app = basicApp(1);
  let oldCalls = 0;
  app.ensureShapes = () => { oldCalls++; return oldGate.promise; };
  const service = new InvestigationService(app);

  const oldRequest = service.collectShapes();
  await Promise.resolve();
  assert.equal(oldCalls, 1);
  const oldEntry = [...service.shared.values()][0];
  assert.ok(oldEntry && oldEntry.controller.signal.aborted === false);

  app.backend.gen = 2;
  const currentShape = { complete:true, marker:'epoch-2' };
  app.ensureShapes = async () => currentShape;
  assert.strictEqual(await service.collectShapes(), currentShape);
  assert.equal(oldEntry.controller.signal.aborted, true,
    'epoch transition must detach stale producer work from the service cache');
  assert.equal(service.shared.size, 1);
  assert.ok([...service.shared.keys()].every((key) => key.includes('shapes:2')));

  oldGate.resolve({ complete:true, marker:'stale-epoch-1' });
  await assert.rejects(oldRequest, (error) => error?.name === 'AbortError' || error?.stale === true,
    'a producer that ignores its AbortSignal must still not resolve through the stale service entry');
  assert.equal(service.shared.size, 1);
  assert.ok([...service.shared.keys()].every((key) => key.includes('shapes:2')));
});

test('#4062 prepareGoal invalidates service caches even when canonical app artifact adapters override strings/program methods', async () => {
  const app = basicApp(1);
  app.analysisQueries.snapshot = async () => ({ snapshotId:'snapshot-epoch-2' });
  const service = new InvestigationService(app);

  await service.ensureMetadata();
  assert.equal(service.shared.size, 1);

  app.backend.gen = 2;
  service.collectStrings = async () => Object.assign([], { complete:true });
  service.buildProgram = async () => null;

  const context = await service.prepareGoal({ id:'adapter-backed', expects:{} });
  assert.equal(context.snapshotId, 'snapshot-epoch-2');
  assert.equal(service.shared.size, 0,
    'prepareGoal must prune old service-owned entries even when collectStrings/buildProgram are adapter overrides');
});

test('#4062 an epoch switch during investigation clears a pin published by the stale request before it fails closed', async () => {
  const app = basicApp(1);
  const service = new InvestigationService(app);
  const snapshotId = 'snapshot-before-switch';
  service.prepareGoal = async (goal) => ({
    snapshot:{ snapshotId },
    snapshotId,
    strings:[],
    program:null,
    shapes:null,
    symbols:null,
    fields:null,
    region:null,
    metadata:{ complete:true, reasons:[] },
    goal,
    binding:captureAnalysisBinding(app),
    completeness:{ complete:true, reasons:[] },
  });
  app.analysisQueries.binaryInfo = async () => { app.backend.gen = 2; return {}; };

  await assert.rejects(
    service.investigate({ id:'stale-pin', text:'old binary', expects:{} }),
    (error) => error?.code === 'ANALYSIS_SNAPSHOT_STALE',
  );
  assert.equal(service.pinCache.size, 0,
    'stale request must not retain a pin artifact after the epoch transition is observed');
  assert.equal(service.shared.size, 0);
});

test('#4062 pin cache releases prior snapshots while preserving entries within the active snapshot', async () => {
  const app = basicApp(7);
  const service = new InvestigationService(app);
  let snapshotId = 'snapshot-A';
  service.prepareGoal = async (goal) => ({
    snapshot:{ snapshotId },
    snapshotId,
    strings:[],
    program:null,
    shapes:null,
    symbols:null,
    fields:null,
    region:null,
    metadata:{ complete:true, reasons:[] },
    goal,
    binding:captureAnalysisBinding(app),
    completeness:{ complete:true, reasons:[] },
  });

  const goal = { id:'cache-lifetime', text:'cache lifetime', expects:{} };
  await service.investigate(goal);
  assert.equal(service.pinCache.size, 1);

  const activeKey = 'snapshot-A:cache-lifetime:cache lifetime';
  const sentinel = { top:{ id:'sentinel' }, verdict:'ambiguous' };
  service.pinCache.set(activeKey, sentinel);
  const reused = await service.investigate(goal);
  assert.strictEqual(reused.pin, sentinel,
    'same snapshot/goal must preserve and reuse the current pin cache entry');

  snapshotId = 'snapshot-B';
  await service.investigate(goal);
  assert.equal(service.pinCache.has(activeKey), false,
    'snapshot transition must release prior snapshot pin artifacts');
  assert.ok([...service.pinCache.keys()].every((key) => key.startsWith('snapshot-B:')),
    'only active snapshot pin identities may remain retained');
});
