import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

const REGION = Object.freeze({ id:'text', vmAddr:0x1000n, size:0x1000n, exec:true });
const FUNCTION = 0x1000n;
const TARGET = 0x2000n;

function scanFixture() {
  return {
    regionId:REGION.id,
    vmAddr:REGION.vmAddr,
    callFrom:BigUint64Array.from([0x1000n, 0x1004n, 0x1008n, 0x100cn, 0x1010n]),
    callTo:BigUint64Array.from([TARGET, TARGET, TARGET, 0x3000n, 0x4000n]),
    callCount:5,
    refFrom:BigUint64Array.from([0x1100n, 0x1110n, 0x1120n]),
    refTo:BigUint64Array.from([TARGET, TARGET, TARGET]),
    refKind:Uint8Array.from([1, 1, 1]),
    refCount:3,
    kinds:new Uint8Array(0),
    kindsCovered:0,
    words:0,
    complete:true,
    completeness:{ complete:true, reasons:[] },
  };
}

function makeApp() {
  const values = new Map([
    ['regions', [REGION]],
    ['currentRegion', REGION],
  ]);
  return {
    analysisEpoch:0,
    projectRevision:0,
    backend:{
      gen:0,
      binaryId:'issue-4245',
      scanProgram:async (regionId) => {
        assert.equal(regionId, REGION.id);
        return scanFixture();
      },
      search:async () => ({
        cancelled:false,
        capped:false,
        results:[{ addr:1n }, { addr:2n }, { addr:3n }],
      }),
    },
    store:{ get:(key) => values.get(key) },
    programRegions:() => [REGION],
    executableRegionFor:(addr) => BigInt(addr) >= REGION.vmAddr && BigInt(addr) < REGION.vmAddr + REGION.size ? REGION : null,
    validatedFunctionRange:(addr) => BigInt(addr) === FUNCTION
      ? { ok:true, start:FUNCTION, end:0x1020n, complete:true, reason:null, region:REGION }
      : { ok:false, reason:'function-range-unavailable' },
    symbols:null,
  };
}

async function apiForApp() {
  const app = makeApp();
  const api = installDemandDrivenAnalysis(app);
  return { api, snapshot:await api.snapshot() };
}

function coercionTrap(value = 1) {
  let count = 0;
  return {
    value: {
      valueOf() { count++; return value; },
      toString() { count++; return String(value); },
      [Symbol.toPrimitive]() { count++; return value; },
    },
    calls:() => count,
  };
}

async function invoke(api, snapshot, method, page) {
  if (method === 'search') return api.search(snapshot, { kind:'text', query:'x' }, page);
  if (method === 'callees') return api.callees(snapshot, FUNCTION, page);
  return api[method](snapshot, TARGET, page);
}

for (const method of ['callers', 'callees', 'xrefs', 'search']) {
  test(`demand ${method} rejects structured pagination without coercion (#4245)`, async () => {
    const { api, snapshot } = await apiForApp();
    const offset = coercionTrap(1);
    const limit = coercionTrap(1);
    const result = await invoke(api, snapshot, method, { offset:offset.value, limit:limit.value });

    assert.equal(offset.calls(), 0, 'pagination must not invoke offset coercion hooks');
    assert.equal(limit.calls(), 0, 'pagination must not invoke limit coercion hooks');
    assert.equal(result.page.offset, 0);
    assert.equal(result.page.limit, 200);
    assert.ok(result.page.returned >= 3, 'invalid pagination must use the default page, not a coerced one-row page');
  });
}

test('demand pagination rejects strings, arrays, and booleans while preserving aliases (#4245)', async () => {
  const cases = [
    { page:{ offset:'1', limit:'1' } },
    { page:{ offset:['1'], limit:['1'] } },
    { page:{ offset:false, limit:true } },
    { page:{ start:['1'], size:['1'] } },
  ];
  for (const { page } of cases) {
    const { api, snapshot } = await apiForApp();
    const result = await api.search(snapshot, { kind:'text', query:'x' }, page);
    assert.equal(result.page.offset, 0);
    assert.equal(result.page.limit, 200);
    assert.equal(result.page.returned, 3);
  }
});

test('demand pagination preserves primitive integer/default/clamp semantics (#4245)', async () => {
  const { api, snapshot } = await apiForApp();
  const valid = await api.search(snapshot, { kind:'text', query:'x' }, { offset:1, limit:1 });
  assert.deepEqual(valid.value, [{ addr:2n }]);
  assert.equal(valid.page.offset, 1);
  assert.equal(valid.page.limit, 1);

  const defaults = await api.search(snapshot, { kind:'text', query:'x' }, { offset:null, limit:undefined });
  assert.equal(defaults.page.offset, 0);
  assert.equal(defaults.page.limit, 200);

  const aliases = await api.search(snapshot, { kind:'text', query:'x' }, { start:1, size:1 });
  assert.deepEqual(aliases.value, [{ addr:2n }]);
  assert.equal(aliases.page.offset, 1);
  assert.equal(aliases.page.limit, 1);

  const clamped = await api.search(snapshot, { kind:'text', query:'x' }, { offset:0, limit:5001 });
  assert.equal(clamped.page.limit, 5000);
});

test('demand pagination keeps invalid numeric values fail-closed at existing defaults (#4245)', async () => {
  for (const page of [
    { offset:-1, limit:-1 },
    { offset:1.5, limit:1.5 },
    { offset:Number.NaN, limit:Number.NaN },
    { offset:Number.POSITIVE_INFINITY, limit:Number.POSITIVE_INFINITY },
  ]) {
    const { api, snapshot } = await apiForApp();
    const result = await api.search(snapshot, { kind:'text', query:'x' }, page);
    assert.equal(result.page.offset, 0);
    assert.equal(result.page.limit, 200);
    assert.equal(result.page.returned, 3);
  }
});
