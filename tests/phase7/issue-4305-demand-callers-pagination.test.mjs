import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

const REGION = Object.freeze({ id:'text', vmAddr:0x1000n, size:0x100000n, exec:true });
const TARGET = 0x1000n;
const CALLER_BASE = 0x2000n;

function scanWithCallers(count, { capped = false } = {}) {
  const callFrom = Array.from({ length:count }, (_, index) => CALLER_BASE + BigInt(index * 4));
  return {
    regionId:REGION.id,
    vmAddr:REGION.vmAddr,
    callFrom:BigUint64Array.from(callFrom),
    callTo:BigUint64Array.from(callFrom, () => TARGET),
    callCount:count,
    refFrom:new BigUint64Array(0),
    refTo:new BigUint64Array(0),
    refKind:new Uint8Array(0),
    refCount:0,
    kinds:new Uint8Array(0),
    kindsCovered:0,
    words:0,
    capped,
    complete:!capped,
    completeness:{ complete:!capped, reasons:capped ? ['scan-limit'] : [] },
  };
}

async function makeApi(count, options = {}) {
  const scan = scanWithCallers(count, options);
  const values = new Map([
    ['regions', [REGION]],
    ['currentRegion', REGION],
  ]);
  const app = {
    analysisEpoch:0,
    projectRevision:0,
    backend:{
      gen:0,
      binaryId:'issue-4305',
      scanProgram:async (regionId) => {
        assert.equal(regionId, REGION.id);
        return scan;
      },
    },
    store:{ get:(key) => values.get(key) },
    programRegions:() => [REGION],
    executableRegionFor:(address) => BigInt(address) >= REGION.vmAddr && BigInt(address) < REGION.vmAddr + REGION.size ? REGION : null,
    symbols:null,
  };
  const api = installDemandDrivenAnalysis(app);
  return { api, snapshot:await api.snapshot() };
}

function sites(result) {
  return result.value.map((row) => row.site);
}

test('#4305 demand callers reaches the 5001st known caller', async () => {
  const { api, snapshot } = await makeApi(5001);
  const result = await api.callers(snapshot, TARGET, { offset:5000, limit:1 });
  assert.equal(result.page.offset, 5000);
  assert.equal(result.page.limit, 1);
  assert.equal(result.page.returned, 1);
  assert.deepEqual(sites(result), [CALLER_BASE + 5000n * 4n]);
  assert.equal(result.page.next, null);
});

test('#4305 demand callers has no gap or duplicate across 4999/5000/5001', async () => {
  const { api, snapshot } = await makeApi(5002);
  const before = await api.callers(snapshot, TARGET, { offset:4999, limit:1 });
  const at = await api.callers(snapshot, TARGET, { offset:5000, limit:1 });
  const after = await api.callers(snapshot, TARGET, { offset:5001, limit:1 });
  assert.deepEqual([...sites(before), ...sites(at), ...sites(after)], [
    CALLER_BASE + 4999n * 4n,
    CALLER_BASE + 5000n * 4n,
    CALLER_BASE + 5001n * 4n,
  ]);
  assert.equal(before.page.next, 5000);
  assert.equal(at.page.next, 5001);
  assert.equal(after.page.next, null);
});

test('#4305 demand callers keeps a single page bounded while cumulative prefix may exceed 5000', async () => {
  const { api, snapshot } = await makeApi(6000);
  const result = await api.callers(snapshot, TARGET, { offset:5000, limit:10000 });
  assert.equal(result.page.limit, 5000);
  assert.equal(result.page.returned, 1000);
  assert.equal(result.value[0].site, CALLER_BASE + 5000n * 4n);
  assert.equal(result.value.at(-1).site, CALLER_BASE + 5999n * 4n);
});

test('#4305 demand callers preserves producer incompleteness past the old ceiling', async () => {
  const { api, snapshot } = await makeApi(5101, { capped:true });
  const result = await api.callers(snapshot, TARGET, { offset:5000, limit:100 });
  assert.equal(result.page.returned, 100);
  assert.equal(result.page.next, 5100);
  assert.equal(result.status.completeness, 'partial');
  assert.notEqual(result.status.completeness, 'complete');
});

test('#4305 demand callers continuation walks all known callers without duplication', async () => {
  const { api, snapshot } = await makeApi(5001);
  const seen = [];
  let offset = 0;
  for (let step = 0; step < 10; step++) {
    const result = await api.callers(snapshot, TARGET, { offset, limit:2000 });
    seen.push(...sites(result));
    if (result.page.next == null) break;
    assert.ok(result.page.next > offset, 'continuation must make forward progress');
    offset = result.page.next;
  }
  assert.equal(seen.length, 5001);
  assert.equal(new Set(seen.map(String)).size, 5001);
  assert.equal(seen[0], CALLER_BASE);
  assert.equal(seen.at(-1), CALLER_BASE + 5000n * 4n);
});

test('#4305 demand callers fails closed when cumulative pagination overflows', async () => {
  const { api, snapshot } = await makeApi(1);
  const result = await api.callers(snapshot, TARGET, { offset:Number.MAX_SAFE_INTEGER, limit:1 });
  assert.deepEqual(result.value, []);
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.reason, 'page-range-overflow');
  assert.equal(result.page.next, null);
});
