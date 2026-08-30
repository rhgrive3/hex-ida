import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalClaimVerdict,
  buildClassificationInput,
  createProductSurfaceQueries,
} from '../js/analysis/query/product-surface.js';

const SNAPSHOT = Object.freeze({ snapshotId:'snap-1', analysisEpoch:1 });

function store(values = {}) {
  return { get(key) { return values[key] ?? null; } };
}

function baseApp(overrides = {}) {
  return {
    analysisQueries:{ snapshot:async ({ signal } = {}) => {
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('AbortError'), { name:'AbortError' });
      return SNAPSHOT;
    } },
    backend:{ gen:1 },
    store:store({ sliceIndex:0, regions:[], architecture:'arm64' }),
    ...overrides,
  };
}

test('canonical claim verdict never promotes confidence or confirmed boolean', () => {
  assert.equal(canonicalClaimVerdict({ confidence:0.99 }), 'unverified');
  assert.equal(canonicalClaimVerdict({ confirmed:true, confidence:0.99 }), 'unverified');
  assert.equal(canonicalClaimVerdict({ verdict:'confirmed', confidence:0.01 }), 'confirmed');
  assert.equal(canonicalClaimVerdict({ proof:{ verdict:'contradicted' }, confidence:1 }), 'contradicted');
});

test('classification input projects semantic evidence once for both classifier and subsystem consumers', () => {
  const app = baseApp({
    ownerOf:() => ({ className:'GameState', sel:'tick' }),
    symbols:{
      nameAt:() => 'tick',
      functionAt:() => ({ start:0x1000n, end:0x1040n }),
    },
  });
  const result = {
    model:{
      instructions:[{ mnemonic:'str', operands:'x0, [x1]' }, { mnemonic:'bl', operands:'_send' }],
      blocks:[{ succ:[1] }, { succ:[] }],
    },
    semanticFacts:{
      stores:[{ location:{ key:'state.hp' }, readModifyWrite:{ kind:'add' } }],
      calls:[{ name:'sendReward' }],
    },
  };
  const input = buildClassificationInput(app, 0x1000n, result);
  assert.deepEqual(input.semantic.writes, ['state.hp']);
  assert.deepEqual(input.semantic.calls, ['sendReward']);
  assert.deepEqual(input.semantic.operations, ['add']);
  assert.equal(input.instructions.length, 2);
  assert.equal(input.cfg.blocks, 2);
});

test('string query returns first page before scanning unrelated later regions and marks it partial', async () => {
  const calls = [];
  const regions = [
    { id:'r1', section:'__cstring', size:100n },
    { id:'r2', section:'__const', size:100n },
  ];
  const app = baseApp({
    store:store({ sliceIndex:0, regions, currentRegion:regions[0], architecture:'arm64' }),
    backend:{
      gen:1,
      strings(params) {
        calls.push(params.regionId);
        const rows = params.regionId === 'r1'
          ? [{ addr:0x1000n, text:'alpha' }, { addr:0x1010n, text:'alphabet' }, { addr:0x1020n, text:'beta' }]
          : [{ addr:0x2000n, text:'alpha-late' }];
        const promise = Promise.resolve({ complete:true, scannedBytes:100, results:rows });
        promise.cancel = () => {};
        return promise;
      },
    },
  });
  const query = createProductSurfaceQueries(app);
  const result = await query.strings(SNAPSHOT, { text:'alpha' }, { offset:0, limit:2 });
  assert.deepEqual(calls, ['r1']);
  assert.equal(result.value.length, 2);
  assert.equal(result.completeness, 'partial');
  assert.deepEqual(result.status.unscannedRegions, ['r2']);

  const second = await query.strings(SNAPSHOT, { text:'alphabet' }, { offset:0, limit:1 });
  assert.equal(second.value[0].text, 'alphabet');
  assert.deepEqual(calls, ['r1']);
});

test('last cancelled string-query waiter cancels the in-flight backend request', async () => {
  const regions = [{ id:'r1', section:'__cstring', size:100n }];
  let cancelled = 0;
  let rejectRequest;
  const request = new Promise((_resolve, reject) => { rejectRequest = reject; });
  request.cancel = () => {
    cancelled++;
    const error = new Error('cancelled');
    error.name = 'AbortError';
    rejectRequest(error);
  };
  const app = baseApp({
    store:store({ sliceIndex:0, regions, currentRegion:regions[0], architecture:'arm64' }),
    backend:{ gen:1, strings:() => request },
  });
  const query = createProductSurfaceQueries(app);
  const controller = new AbortController();
  const pending = query.strings(SNAPSHOT, { text:'alpha' }, { offset:0, limit:2 }, { signal:controller.signal });
  await Promise.resolve();
  controller.abort('view-closed');
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(cancelled, 1);
});

test('claims are snapshot-bound and preserve producer verdict without UI thresholding', async () => {
  const report = { findings:[
    { id:'a', title:'A', confidence:0.99, confirmed:true },
    { id:'b', title:'B', verdict:'supported', confidence:0.1 },
  ] };
  const app = baseApp({ autoReport:{ report } });
  const query = createProductSurfaceQueries(app);
  const result = await query.claims(SNAPSHOT, {}, { offset:0, limit:20 });
  assert.equal(result.value[0].verdict, 'unverified');
  assert.equal(result.value[1].verdict, 'supported');
  assert.ok(result.value.every((row) => row.snapshotId === SNAPSHOT.snapshotId));
});

test('classification query joins global recognition with semantic refinement', async () => {
  const app = baseApp({
    recognition:{ records:[{ address:0x1000n, classification:'UNKNOWN', confidence:0.35, evidence:[], knowledge:null }] },
    ensureRecognition:async () => null,
    analyzeFunctionAt:async () => ({
      completeness:{ complete:true },
      model:{ instructions:[{ mnemonic:'str', operands:'x0, [x1]' }], blocks:[{ succ:[] }] },
      semanticFacts:{ stores:[{ location:{ key:'state.hp' } }], calls:[] },
    }),
    ownerOf:() => ({ className:'GameState', sel:'tick' }),
    symbols:{ nameAt:() => 'tick', functionAt:() => ({ start:0x1000n, end:0x1040n }) },
  });
  const query = createProductSurfaceQueries(app);
  const result = await query.classification(SNAPSHOT, 0x1000n);
  assert.equal(result.value.base.classification, 'UNKNOWN');
  assert.equal(result.value.classification, 'APPLICATION');
  assert.ok(result.value.evidence.includes('custom-objc-type'));
  assert.ok(result.value.evidence.includes('state-writes'));
  assert.equal(result.value.refinement.from, 'UNKNOWN');
});
