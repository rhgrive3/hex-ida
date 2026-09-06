import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisQueryAPI } from '../../js/analysis/query/api.js';

const identity = Object.freeze({
  binaryId:'issue-3882',
  projectRevision:0,
  analysisEpoch:0,
  artifactVersions:{},
});

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

test('xrefs does not invent continuation without positive query-limit evidence', async () => {
  for (const result of [
    {
      value:[{ site:0x1000n }],
      page:{ offset:0, limit:2, returned:1, total:1, next:null },
      status:{ completeness:'complete', reason:null, paged:true },
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
