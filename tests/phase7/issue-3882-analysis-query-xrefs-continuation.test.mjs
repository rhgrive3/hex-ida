import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisQueryAPI } from '../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';
import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';
import { ProgramIndex } from '../../js/program.js';

const identity = Object.freeze({
  binaryId:'issue-3882',
  projectRevision:0,
  analysisEpoch:0,
  artifactVersions:{},
});
const TARGET = 0x2000n;
const ACTIVE_REGION = Object.freeze({ id:'r0', vmAddr:0x1000n, size:0x2000n, exec:true });
const UNSCANNED_REGION = Object.freeze({ id:'r1', vmAddr:0x4000n, size:0x1000n, exec:true });
const PARTIAL_REASON = 'program-region-unscanned:r1';

function adapterFor(xrefs) {
  return {
    currentIdentity: async () => identity,
    xrefs,
  };
}

async function snapshotFor(adapter) {
  const api = new AnalysisQueryAPI(adapter);
  return { api, snapshot:await api.snapshot() };
}

function scanFor({ refs = [], calls = [] } = {}) {
  return {
    regionId:ACTIVE_REGION.id,
    vmAddr:ACTIVE_REGION.vmAddr,
    callFrom:BigUint64Array.from(calls.map((site) => BigInt(site))),
    callTo:BigUint64Array.from(calls.map(() => TARGET)),
    callCount:calls.length,
    refFrom:BigUint64Array.from(refs.map((site) => BigInt(site))),
    refTo:BigUint64Array.from(refs.map(() => TARGET)),
    refKind:Uint8Array.from(refs.map(() => 1)),
    refCount:refs.length,
    kinds:new Uint8Array(0),
    kindsCovered:0,
    words:0,
    complete:true,
    completeness:{ complete:true, reasons:[] },
  };
}

function appForScan(scan, includeUnscanned = true) {
  const regions = includeUnscanned ? [ACTIVE_REGION, UNSCANNED_REGION] : [ACTIVE_REGION];
  const values = new Map([
    ['regions', regions],
    ['currentRegion', ACTIVE_REGION],
  ]);
  return {
    analysisEpoch:0,
    backend:{
      binaryId:'issue-3882',
      gen:0,
      scanProgram:async (regionId) => {
        assert.equal(regionId, ACTIVE_REGION.id);
        return scan;
      },
    },
    store:{ get:(key) => values.get(key) },
    programRegions:() => regions,
    symbols:null,
  };
}

function baseProgram(scan, includeUnscanned = true) {
  return new ProgramIndex({
    ...scan,
    regions:includeUnscanned ? [ACTIVE_REGION, UNSCANNED_REGION] : [ACTIVE_REGION],
    complete:!includeUnscanned,
    truncated:includeUnscanned,
    completeness:{ complete:!includeUnscanned, reasons:includeUnscanned ? [PARTIAL_REASON] : [] },
  }, null, ACTIVE_REGION);
}

async function runBase(scan, page, { includeUnscanned = true } = {}) {
  const app = appForScan(scan, includeUnscanned);
  app.ensureProgram = async () => baseProgram(scan, includeUnscanned);
  const { api, snapshot } = await snapshotFor(createAppAnalysisQueryAdapter(app));
  return api.xrefs(snapshot, TARGET, page);
}

async function runDemand(scan, page, { includeUnscanned = true } = {}) {
  const app = appForScan(scan, includeUnscanned);
  const api = installDemandDrivenAnalysis(app);
  const snapshot = await api.snapshot();
  return api.xrefs(snapshot, TARGET, page);
}

for (const [name, run] of [['base adapter', runBase], ['demand runtime', runDemand]]) {
  test(`${name} preserves calls-only query-limit evidence beside another partial reason at offset > 0`, async () => {
    const result = await run(scanFor({ calls:[0x1100n, 0x1110n, 0x1120n, 0x1130n, 0x1140n] }), { offset:2, limit:2 });
    assert.equal(result.completeness, 'partial');
    assert.equal(result.status.reason, PARTIAL_REASON);
    assert.equal(result.status.truncationReason, 'query-limit');
    assert.equal(result.page.returned, 2);
    assert.equal(result.page.next, 4);
  });

  test(`${name} preserves refs-only query-limit evidence beside another partial reason`, async () => {
    const result = await run(scanFor({ refs:[0x1200n, 0x1210n, 0x1220n] }), { offset:0, limit:2 });
    assert.equal(result.completeness, 'partial');
    assert.equal(result.status.reason, PARTIAL_REASON);
    assert.equal(result.status.truncationReason, 'query-limit');
    assert.equal(result.page.returned, 2);
    assert.equal(result.page.next, 2);
  });

  test(`${name} preserves mixed-source query-limit evidence without replacing the primary partial reason`, async () => {
    const result = await run(scanFor({ refs:[0x1200n, 0x1210n, 0x1220n], calls:[0x1100n] }), { offset:0, limit:2 });
    assert.equal(result.completeness, 'partial');
    assert.equal(result.status.reason, PARTIAL_REASON);
    assert.equal(result.status.truncationReason, 'query-limit');
    assert.equal(result.page.next, 2);
    assert.deepEqual(result.value.map((row) => row.kind), ['call', 'reference']);
  });

  test(`${name} stops synthesizing continuation when the bounded source is exhausted under another partial reason`, async () => {
    const result = await run(scanFor({ calls:[0x1100n, 0x1110n, 0x1120n, 0x1130n, 0x1140n] }), { offset:4, limit:2 });
    assert.equal(result.completeness, 'partial');
    assert.equal(result.status.reason, PARTIAL_REASON);
    assert.notEqual(result.status.truncationReason, 'query-limit');
    assert.equal(result.page.returned, 1);
    assert.equal(result.page.next, null);
  });

  test(`${name} preserves terminal complete behavior on the real xrefs path`, async () => {
    const result = await run(scanFor({ calls:[0x1100n, 0x1110n, 0x1120n, 0x1130n, 0x1140n] }), { offset:4, limit:2 }, { includeUnscanned:false });
    assert.equal(result.completeness, 'complete');
    assert.equal(result.status.reason ?? null, null);
    assert.notEqual(result.status.truncationReason, 'query-limit');
    assert.equal(result.page.returned, 1);
    assert.equal(result.page.next, null);
  });
}

test('xrefs preserves continuation when a query-limited source filled the page', async () => {
  const adapter = adapterFor(async (_snapshot, _id, page) => ({
    value:[{ site:0x1000n }, { site:0x1010n }],
    page:{ offset:page.offset ?? 0, limit:2, returned:2, total:2, next:null },
    status:{ completeness:'partial', reason:'query-limit', paged:true },
  }));
  const { api, snapshot } = await snapshotFor(adapter);
  const result = await api.xrefs(snapshot, 0x2000n, { offset:0, limit:2 });
  assert.equal(result.completeness, 'partial');
  assert.equal(result.status.reason, 'query-limit');
  assert.equal(result.page.next, 2);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.page), true);
});

test('xrefs recognizes demand-runtime truncationReason as query-limit evidence', async () => {
  const adapter = adapterFor(async () => ({
    value:[{ site:0x1000n }, { site:0x1010n }],
    page:{ offset:2, limit:2, returned:2, total:4, next:null },
    status:{ completeness:'partial', reason:'program-region-unscanned:r1', truncationReason:'query-limit', paged:true },
  }));
  const { api, snapshot } = await snapshotFor(adapter);
  const result = await api.xrefs(snapshot, 0x2000n, { offset:2, limit:2 });
  assert.equal(result.page.next, 4);
  assert.equal(result.status.reason, 'program-region-unscanned:r1');
  assert.equal(result.status.truncationReason, 'query-limit');
});

test('xrefs can traverse successive merged query-limited pages without losing the terminal page', async () => {
  const rows = [
    { id:'r0', site:0x1000n },
    { id:'c0', site:0x1008n },
    { id:'r1', site:0x1010n },
    { id:'c1', site:0x1018n },
    { id:'r2', site:0x1020n },
  ];
  const adapter = adapterFor(async (_snapshot, _id, page) => {
    const offset = page.offset ?? 0;
    const value = rows.slice(offset, offset + 2);
    const hasMore = offset + value.length < rows.length;
    return {
      value,
      page:{ offset, limit:2, returned:value.length, total:offset + value.length, next:null },
      status:{ completeness:hasMore ? 'partial' : 'complete', reason:hasMore ? 'query-limit' : null, paged:true },
    };
  });
  const { api, snapshot } = await snapshotFor(adapter);
  const seen = [];
  let offset = 0;
  for (;;) {
    const result = await api.xrefs(snapshot, 0x2000n, { offset, limit:2 });
    seen.push(...result.value.map((row) => row.id));
    if (result.page.next == null) {
      assert.equal(result.completeness, 'complete');
      break;
    }
    assert.ok(result.page.next > offset);
    offset = result.page.next;
  }
  assert.deepEqual(seen, rows.map((row) => row.id));
});

test('xrefs does not invent continuation without a partial query-limited page', async () => {
  for (const result of [
    {
      value:[{ site:0x1000n }],
      page:{ offset:0, limit:2, returned:1, total:1, next:null },
      status:{ completeness:'complete', reason:'query-limit', paged:true },
    },
    {
      value:[{ site:0x1000n }],
      page:{ offset:0, limit:2, returned:1, total:1, next:null },
      status:{ completeness:'truncated', reason:'query-limit', paged:true },
    },
    {
      value:[{ site:0x1000n }],
      page:{ offset:0, limit:2, returned:1, total:1, next:null },
      status:{ completeness:'partial', reason:'program-region-unscanned:r1', paged:true },
    },
    {
      value:[],
      page:{ offset:4, limit:2, returned:0, total:4, next:null },
      status:{ completeness:'partial', reason:'query-limit', paged:true },
    },
  ]) {
    const adapter = adapterFor(async () => result);
    const { api, snapshot } = await snapshotFor(adapter);
    const wrapped = await api.xrefs(snapshot, 0x2000n, { offset:result.page.offset, limit:2 });
    assert.equal(wrapped.page.next, null);
  }
});
