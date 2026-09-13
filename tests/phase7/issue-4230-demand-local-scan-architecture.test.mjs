import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

const REGION = Object.freeze({ id:'text', vmAddr:0x1000n, size:0x100n, exec:true, section:'__text' });
const TARGET = 0x1000n;

function emptyScan(regionId, architecture, { unsupported = false } = {}) {
  return {
    regionId,
    vmAddr:REGION.vmAddr,
    callFrom:new BigUint64Array(0),
    callTo:new BigUint64Array(0),
    callCount:0,
    refFrom:new BigUint64Array(0),
    refTo:new BigUint64Array(0),
    refKind:new Uint8Array(0),
    refCount:0,
    kinds:new Uint8Array(0),
    kindsCovered:0,
    words:0,
    unsupported,
    architecture,
    complete:!unsupported,
    completeness:{ complete:!unsupported, reasons:unsupported ? ['unsupported-program-analysis'] : [] },
  };
}

function makeApp({ architecture, sliceArchitecture, routeByArchitecture = true } = {}) {
  const values = new Map([
    ['regions', [REGION]],
    ['currentRegion', REGION],
  ]);
  if (architecture !== undefined) values.set('architecture', architecture);
  const calls = [];
  const app = {
    analysisEpoch:0,
    projectRevision:0,
    backend:{
      gen:0,
      binaryId:'issue-4230',
      scanProgram:async (regionId, _onProgress, limits = {}) => {
        calls.push({ regionId, limits:{ ...limits } });
        const arch = limits.architecture;
        const unsupported = routeByArchitecture && !['arm64', 'arm64e', 'arm64_32'].includes(arch);
        return emptyScan(regionId, arch ?? null, { unsupported });
      },
    },
    store:{ get:(key) => values.get(key) },
    currentSlice:() => sliceArchitecture === undefined ? null : ({ capability:{ architecture:sliceArchitecture } }),
    programRegions:() => [REGION],
    executableRegionFor:(address) => BigInt(address) >= REGION.vmAddr && BigInt(address) < REGION.vmAddr + REGION.size ? REGION : null,
    symbols:null,
  };
  return { app, calls, values };
}

async function queryCallers(fixture) {
  const api = fixture.app.analysisQueries ?? installDemandDrivenAnalysis(fixture.app);
  const snapshot = await api.snapshot();
  return api.callers(snapshot, TARGET, { offset:0, limit:1 });
}

test('#4230 demand-local scan forwards x86_64 architecture and preserves unsupported routing', async () => {
  const fixture = makeApp({ architecture:'x86_64' });
  const result = await queryCallers(fixture);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].limits.architecture, 'x86_64');
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.reason, 'unsupported-program-analysis');
});

test('#4230 demand-local scan preserves ARM64 legacy-capable routing input', async () => {
  const fixture = makeApp({ architecture:'arm64' });
  const result = await queryCallers(fixture);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].limits.architecture, 'arm64');
  assert.equal(result.status.completeness, 'complete');
});

test('#4230 demand-local scan falls back to the active slice architecture', async () => {
  const fixture = makeApp({ architecture:'', sliceArchitecture:'x86_64' });
  await queryCallers(fixture);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].limits.architecture, 'x86_64');
});

test('#4230 missing architecture fails closed through the explicit unknown route', async () => {
  const fixture = makeApp();
  const result = await queryCallers(fixture);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].limits.architecture, 'unknown');
  assert.equal(result.status.completeness, 'unsupported');
});

test('#4230 architecture is part of local scan cache identity', async () => {
  const fixture = makeApp({ architecture:'x86_64', routeByArchitecture:false });
  const api = installDemandDrivenAnalysis(fixture.app);
  const snapshot = await api.snapshot();
  await api.callers(snapshot, TARGET, { offset:0, limit:1 });
  fixture.values.set('architecture', 'arm64');
  await api.callers(snapshot, TARGET, { offset:0, limit:1 });
  assert.deepEqual(fixture.calls.map((call) => call.limits.architecture), ['x86_64', 'arm64']);
});
