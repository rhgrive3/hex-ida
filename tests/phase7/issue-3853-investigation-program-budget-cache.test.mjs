import test from 'node:test';
import assert from 'node:assert/strict';
import { InvestigationService, __investigationInternalsForTests } from '../../js/analysis/investigation-service.js';

const { budgetProfileCovers, captureAnalysisBinding, analysisBindingCurrent } = __investigationInternalsForTests;

function scanFor(region, limits) {
  const callCount = Math.min(3, limits.callLimit);
  const refCount = Math.min(3, limits.refLimit);
  const kindsCovered = Math.min(3, limits.kindLimit);
  return {
    regionId:region.id,
    vmAddr:region.vmAddr,
    callFrom:new BigUint64Array(callCount),
    callTo:new BigUint64Array(callCount),
    callCount,
    refFrom:new BigUint64Array(refCount),
    refTo:new BigUint64Array(refCount),
    refKind:new Uint8Array(refCount),
    refCount,
    words:3,
    kinds:new Uint8Array(kindsCovered),
    kindsCovered,
    complete:callCount === 3 && refCount === 3 && kindsCovered === 3,
  };
}

function fixture() {
  const region = { id:'text', exec:true, vmAddr:0x1000n, size:0x100n, section:'__text' };
  const calls = [];
  const app = {
    backend:{
      gen:7,
      scanProgram(regionId, _progress, limits) {
        calls.push({ regionId, ...limits });
        return Promise.resolve(scanFor(region, limits));
      },
    },
    symbols:{ gen:11, functionStartsComplete:true, functionCount:0 },
    programRegions:() => [region],
  };
  return { app, service:new InvestigationService(app), calls };
}

const low = { budget:{ program:{ calls:1, refs:1, kindWords:1 } } };
const high = { budget:{ program:{ calls:3, refs:3, kindWords:3 } } };

function flakyFixture({ failWhen = null } = {}) {
  const region = { id:'text', exec:true, vmAddr:0x1000n, size:0x100n, section:'__text' };
  const calls = [];
  const app = {
    backend:{
      gen:7,
      scanProgram(regionId, _progress, limits) {
        calls.push({ regionId, ...limits });
        if (failWhen && failWhen(limits)) return Promise.reject(new Error('transient region scan failure'));
        return Promise.resolve(scanFor(region, limits));
      },
    },
    symbols:{ gen:11, functionStartsComplete:true, functionCount:0 },
    programRegions:() => [region],
  };
  return { app, service:new InvestigationService(app), calls };
}

const larger = { budget:{ program:{ calls:4, refs:4, kindWords:4 } } };

test('low-budget cached ProgramIndex cannot satisfy a later stronger request', async () => {
  const { service, calls } = fixture();
  const first = await service.buildProgram(low);
  const second = await service.buildProgram(high);
  assert.equal(first.callCount, 1);
  assert.equal(second.callCount, 3);
  assert.equal(calls.length, 2);
});

test('stronger cached profile safely satisfies a weaker request', async () => {
  const { service, calls } = fixture();
  const first = await service.buildProgram(high);
  const second = await service.buildProgram(low);
  assert.strictEqual(second, first);
  assert.equal(calls.length, 1);
});

test('different concurrent budget profiles do not share one producer', async () => {
  const { service, calls } = fixture();
  const [small, large] = await Promise.all([service.buildProgram(low), service.buildProgram(high)]);
  assert.ok(small.callCount >= 1 && small.callCount <= 3);
  assert.equal(large.callCount, 3);
  assert.equal(calls.length, 2);
});

test('equal concurrent profiles remain coalesced', async () => {
  const { service, calls } = fixture();
  const [a, b] = await Promise.all([service.buildProgram(high), service.buildProgram(high)]);
  assert.strictEqual(a, b);
  assert.equal(calls.length, 1);
});

test('budget profile dominance is strict and non-coercing', () => {
  assert.equal(budgetProfileCovers({ calls:3, refs:4, kindWords:5 }, { calls:3, refs:2, kindWords:5 }), true);
  assert.equal(budgetProfileCovers({ calls:1, refs:4, kindWords:5 }, { calls:2, refs:2, kindWords:5 }), false);
  assert.equal(budgetProfileCovers({ calls:'3', refs:4, kindWords:5 }, { calls:3, refs:2, kindWords:5 }), false);
  assert.equal(budgetProfileCovers(null, { calls:1, refs:1, kindWords:1 }), false);
});

test('transient partial at high profile does not pin the cache; same high request rescans', async () => {
  const limitsSeen = [];
  const { service, calls } = flakyFixture({
    failWhen:(limits) => {
      limitsSeen.push(limits.callLimit);
      return limitsSeen.length === 1;
    },
  });
  const partial = await service.buildProgram(high);
  assert.equal(partial.completeness.complete, false);
  assert.equal(calls.length, 1);
  const repaired = await service.buildProgram(high);
  assert.equal(repaired.completeness.complete, true);
  assert.equal(calls.length, 2);
});

test('complete artifact is not overwritten by a later incomplete one', async () => {
  const limitsSeen = [];
  const { service, calls } = flakyFixture({
    failWhen:(limits) => {
      limitsSeen.push(limits.callLimit);
      return limitsSeen.length === 2;
    },
  });
  const complete = await service.buildProgram(high);
  assert.equal(complete.completeness.complete, true);
  const partial = await service.buildProgram(larger);
  assert.equal(partial.completeness.complete, false);
  const still = await service.buildProgram(high);
  assert.equal(still.completeness.complete, true);
  assert.strictEqual(still, complete);
  assert.equal(still.callCount, 3);
  assert.equal(calls.length, 2);
});

test('partial settled stronger profile is retried even while weaker complete cache remains', async () => {
  let failedLarger = false;
  const { service, calls } = flakyFixture({
    failWhen:(limits) => {
      if (limits.callLimit !== 4 || failedLarger) return false;
      failedLarger = true;
      return true;
    },
  });
  const complete = await service.buildProgram(high);
  assert.equal(complete.completeness.complete, true);
  const partial = await service.buildProgram(larger);
  assert.equal(partial.completeness.complete, false);
  const repaired = await service.buildProgram(larger);
  assert.equal(repaired.completeness.complete, true);
  assert.equal(calls.length, 3);
});

test('prepareGoal can bind a returned partial profile without replacing a complete app.program', async () => {
  let failedLarger = false;
  const { app, service, calls } = flakyFixture({
    failWhen:(limits) => {
      if (limits.callLimit !== 4 || failedLarger) return false;
      failedLarger = true;
      return true;
    },
  });
  app.fields = {};
  app.store = { get:(key) => key === 'sliceIndex' ? 0 : null };
  app.codeRegion = () => app.programRegions()[0];
  app.analysisQueries = { snapshot:async () => ({ snapshotId:'snapshot-3853-binding' }) };
  service.collectStrings = async () => Object.assign([], { complete:true });

  const complete = await service.buildProgram(high);
  assert.equal(complete.completeness.complete, true);
  assert.strictEqual(app.program, complete);
  const publishedBinding = captureAnalysisBinding(app, { program:complete, fields:app.fields });
  assert.equal(analysisBindingCurrent(app, publishedBinding), true);
  app.program = null;
  assert.equal(analysisBindingCurrent(app, publishedBinding), false, 'published artifact replacement must remain stale');
  app.program = complete;

  const context = await service.prepareGoal({ id:'lookup', expects:{} }, larger);
  assert.equal(context.program.completeness.complete, false);
  assert.notStrictEqual(context.program, complete);
  assert.strictEqual(app.program, complete, 'partial profile must not replace the complete published artifact');
  assert.equal(context.binding.programPublished, false);
  assert.equal(calls.length, 2);
});
