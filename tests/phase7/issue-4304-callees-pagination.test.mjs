import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';
import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

const FUNCTION = 0x1000n;
const REGION = Object.freeze({ id:'text', vmAddr:FUNCTION, size:0x1000n, exec:true });

function boundedRows(rows, { queryLimited = false, incompleteReason = null, complete = !queryLimited } = {}) {
  const result = [...rows];
  Object.defineProperties(result, {
    queryLimited:{ value:queryLimited, enumerable:false },
    complete:{ value:complete, enumerable:false },
    incompleteReason:{ value:incompleteReason ?? (queryLimited ? 'query-limit' : null), enumerable:false },
  });
  return result;
}

function makeBaseApp(count, { fixedPrefix = null, sourceIncomplete = false } = {}) {
  const callees = Array.from({ length:count }, (_, i) => ({ addr:0x2000n + BigInt(i), site:FUNCTION, count:1 }));
  const requestedLimits = [];
  const program = {
    calleesOf(start, end, limit) {
      assert.equal(start, FUNCTION);
      assert.equal(end, FUNCTION + 0x10n);
      requestedLimits.push(limit);
      const visible = fixedPrefix == null ? Math.min(limit, callees.length) : Math.min(fixedPrefix, callees.length);
      const locallyLimited = fixedPrefix == null ? callees.length > limit : callees.length > visible;
      return boundedRows(callees.slice(0, visible), {
        queryLimited:locallyLimited,
        complete:sourceIncomplete ? false : !locallyLimited,
        incompleteReason:sourceIncomplete ? 'calls-source-capped' : (locallyLimited ? 'query-limit' : null),
      });
    },
  };
  const app = {
    ensureProgram:async () => program,
    validatedFunctionRange:(address) => BigInt(address) === FUNCTION
      ? { ok:true, start:FUNCTION, end:FUNCTION + 0x10n, complete:true, reason:null, region:REGION }
      : { ok:false, reason:'function-range-unavailable' },
    store:{ get:() => null },
  };
  return { api:createAppAnalysisQueryAdapter(app), requestedLimits };
}

test('4304 base: 5001st callee is reachable', async () => {
  const { api, requestedLimits } = makeBaseApp(5001);
  const result = await api.callees({}, FUNCTION, { offset:5000, limit:1 });
  assert.equal(result.page.returned, 1);
  assert.equal(result.value[0].addr, 0x2000n + 5000n);
  assert.equal(result.page.next, null);
  assert.deepEqual(requestedLimits, [5001]);
});

test('4304 base: continuation from the last pre-ceiling page reaches 5001', async () => {
  const { api } = makeBaseApp(5001);
  const first = await api.callees({}, FUNCTION, { offset:4800, limit:200 });
  assert.equal(first.page.returned, 200);
  assert.equal(first.page.next, 5000);
  const second = await api.callees({}, FUNCTION, { offset:first.page.next, limit:200 });
  assert.equal(second.page.returned, 1);
  assert.equal(second.value[0].addr, 0x2000n + 5000n);
  assert.equal(second.page.next, null);
});

test('4304 base: 4999/5000/5001 boundary has no gap or overlap', async () => {
  const { api } = makeBaseApp(5002);
  const a = await api.callees({}, FUNCTION, { offset:4999, limit:1 });
  const b = await api.callees({}, FUNCTION, { offset:5000, limit:1 });
  const c = await api.callees({}, FUNCTION, { offset:5001, limit:1 });
  assert.deepEqual([a.value[0].addr, b.value[0].addr, c.value[0].addr], [0x2000n + 4999n, 0x2000n + 5000n, 0x2000n + 5001n]);
});

test('4304 base: one page remains bounded to MAX_PAGE', async () => {
  const { api, requestedLimits } = makeBaseApp(6000);
  const result = await api.callees({}, FUNCTION, { offset:0, limit:5001 });
  assert.equal(result.page.limit, 5000);
  assert.equal(result.page.returned, 5000);
  assert.deepEqual(requestedLimits, [5000]);
});

test('4304 base: incomplete source provenance is preserved past 5000', async () => {
  const { api } = makeBaseApp(5001, { sourceIncomplete:true });
  const result = await api.callees({}, FUNCTION, { offset:5000, limit:1 });
  assert.equal(result.page.returned, 1);
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.reason, 'calls-source-capped');
});

test('4304 base: query-limited empty boundary advances once instead of terminating at 5000', async () => {
  const { api, requestedLimits } = makeBaseApp(6000, { fixedPrefix:5000 });
  const first = await api.callees({}, FUNCTION, { offset:5000, limit:100 });
  assert.equal(first.page.returned, 0);
  assert.equal(first.status.completeness, 'partial');
  assert.equal(first.status.reason, 'query-limit');
  assert.equal(first.page.next, 5100);
  const second = await api.callees({}, FUNCTION, { offset:first.page.next, limit:100 });
  assert.equal(second.page.returned, 0);
  assert.equal(second.page.next, null);
  assert.deepEqual(requestedLimits, [5100, 5200]);
});

test('4304 base: cumulative safe-integer overflow fails closed before calleesOf', async () => {
  const { api, requestedLimits } = makeBaseApp(1);
  const result = await api.callees({}, FUNCTION, { offset:Number.MAX_SAFE_INTEGER, limit:1 });
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.reason, 'page-range-overflow');
  assert.equal(result.page.next, null);
  assert.deepEqual(requestedLimits, []);
});

function makeDemandApp(count) {
  const callFrom = new BigUint64Array(count);
  const callTo = new BigUint64Array(count);
  for (let i = 0; i < count; i++) {
    callFrom[i] = FUNCTION;
    callTo[i] = 0x2000n + BigInt(i);
  }
  const scan = {
    regionId:REGION.id,
    vmAddr:REGION.vmAddr,
    callFrom,
    callTo,
    callCount:count,
    refFrom:new BigUint64Array(0),
    refTo:new BigUint64Array(0),
    refKind:new Uint8Array(0),
    refCount:0,
    kinds:new Uint8Array(0),
    kindsCovered:0,
    words:0,
    complete:true,
    completeness:{ complete:true, reasons:[] },
  };
  const values = new Map([['regions', [REGION]], ['currentRegion', REGION]]);
  let scans = 0;
  const app = {
    analysisEpoch:0,
    projectRevision:0,
    backend:{
      gen:0,
      binaryId:'issue-4304',
      scanProgram:async (regionId) => { assert.equal(regionId, REGION.id); scans++; return scan; },
    },
    store:{ get:(key) => values.get(key) },
    programRegions:() => [REGION],
    executableRegionFor:(addr) => BigInt(addr) >= REGION.vmAddr && BigInt(addr) < REGION.vmAddr + REGION.size ? REGION : null,
    validatedFunctionRange:(addr) => BigInt(addr) === FUNCTION
      ? { ok:true, start:FUNCTION, end:FUNCTION + 0x10n, complete:true, reason:null, region:REGION }
      : { ok:false, reason:'function-range-unavailable' },
    symbols:null,
  };
  const api = installDemandDrivenAnalysis(app);
  return { api, scans:() => scans };
}

async function demandPage(count, page) {
  const { api } = makeDemandApp(count);
  const snapshot = await api.snapshot();
  return api.callees(snapshot, FUNCTION, page);
}

test('4304 demand: 5001st callee is reachable', async () => {
  const result = await demandPage(5001, { offset:5000, limit:1 });
  assert.equal(result.page.returned, 1);
  assert.equal(result.value[0].addr, 0x2000n + 5000n);
  assert.equal(result.page.next, null);
});

test('4304 demand: continuation from the last pre-ceiling page reaches 5001', async () => {
  const { api } = makeDemandApp(5001);
  const snapshot = await api.snapshot();
  const first = await api.callees(snapshot, FUNCTION, { offset:4800, limit:200 });
  assert.equal(first.page.returned, 200);
  assert.equal(first.page.next, 5000);
  const second = await api.callees(snapshot, FUNCTION, { offset:first.page.next, limit:200 });
  assert.equal(second.page.returned, 1);
  assert.equal(second.value[0].addr, 0x2000n + 5000n);
  assert.equal(second.page.next, null);
});

test('4304 demand: 4999/5000/5001 boundary has no gap or overlap', async () => {
  const { api } = makeDemandApp(5002);
  const snapshot = await api.snapshot();
  const a = await api.callees(snapshot, FUNCTION, { offset:4999, limit:1 });
  const b = await api.callees(snapshot, FUNCTION, { offset:5000, limit:1 });
  const c = await api.callees(snapshot, FUNCTION, { offset:5001, limit:1 });
  assert.deepEqual([a.value[0].addr, b.value[0].addr, c.value[0].addr], [0x2000n + 4999n, 0x2000n + 5000n, 0x2000n + 5001n]);
});

test('4304 demand: one page remains bounded to MAX_PAGE', async () => {
  const result = await demandPage(6000, { offset:0, limit:5001 });
  assert.equal(result.page.limit, 5000);
  assert.equal(result.page.returned, 5000);
  assert.equal(result.page.next, 5000);
});

test('4304 demand: cumulative safe-integer overflow fails closed', async () => {
  const result = await demandPage(1, { offset:Number.MAX_SAFE_INTEGER, limit:1 });
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.reason, 'page-range-overflow');
  assert.equal(result.page.next, null);
});
