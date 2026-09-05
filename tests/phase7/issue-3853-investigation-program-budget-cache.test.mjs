import test from 'node:test';
import assert from 'node:assert/strict';
import { InvestigationService, __investigationInternalsForTests } from '../../js/analysis/investigation-service.js';

const { budgetProfileCovers } = __investigationInternalsForTests;

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
