import assert from 'node:assert/strict';
import test from 'node:test';

import { ANALYSIS_KEYS, createPassDescriptor, createPassResult } from '../../../js/decompiler/phase8/contract.js';
import { capturePhase8SemanticSnapshot, canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';
import {
  analysisSemanticSnapshotIsCurrent,
  createAnalysisState,
  runPassTransaction,
  runPassTransactionBatch,
  runPhase8Vertical,
  seedAnalysisState,
  semanticSnapshotForAnalysis,
} from '../../../js/decompiler/phase8/index.js';

function noOpPass(id, run) {
  const descriptor = createPassDescriptor({
    id,
    version:'1.0.0',
    stage:'canonical-facts',
    consumes:['cfg'],
    produces:[],
  });
  return {
    descriptor,
    run:run ?? (() => createPassResult({
      descriptor,
      status:'unchanged',
      changed:false,
      completeness:'complete',
    })),
  };
}

function fixture() {
  return {
    values:[{ id:1, bits:8, origin:{ instructionIds:['instruction_value'] } }],
    blocks:[{ id:'entry', index:0, insts:[], succ:[], pred:[] }],
    entry:0,
    origin:{ instructionIds:['instruction_function'] },
  };
}

function producingPass(id, run = null) {
  const descriptor = createPassDescriptor({
    id,
    version:'1.0.0',
    stage:'scalar-optimization',
    consumes:['cfg'],
    produces:['ranges'],
  });
  return {
    descriptor,
    run:run ?? ((_context, _budget, staging) => {
      staging.stage('ranges', Object.freeze({ completeness:'complete', value:'fresh' }));
      return createPassResult({
        descriptor,
        status:'changed',
        produced:['ranges'],
        completeness:'complete',
      });
    }),
  };
}

function captureState(state) {
  return {
    versions:state.snapshot(),
    values:Object.fromEntries(ANALYSIS_KEYS.map((key) => [key, state.get(key)])),
  };
}

function assertStateUnchanged(state, before) {
  assert.deepEqual(state.snapshot(), before.versions);
  for (const key of ANALYSIS_KEYS) assert.equal(state.get(key), before.values[key], `${key} value changed`);
}

test('T013 cached snapshots compare the complete current property set', () => {
  for (const target of [{}, []]) {
    let currentKey = 'a';
    const extra = new Proxy(target, {
      ownKeys(object) { return [...Reflect.ownKeys(object), currentKey]; },
      getOwnPropertyDescriptor(object, key) {
        if (key === 'a' || key === 'b') {
          return { value:key === 'a' ? 1 : 2, enumerable:true, configurable:true, writable:true };
        }
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    });
    const ir = { extra };
    const first = capturePhase8SemanticSnapshot(ir);
    currentKey = 'b';
    const second = capturePhase8SemanticSnapshot(ir);
    assert.notEqual(second, first);
    assert.equal(Object.hasOwn(second.extra, 'a'), false);
    assert.equal(second.extra.b, 2);
  }
});

test('T013 cache key membership covers symbols and intrinsic-container properties', () => {
  for (const target of [new Map(), new Set(), new Date(0)]) {
    Object.defineProperty(target, 'a', {
      value:1, enumerable:true, configurable:true, writable:true,
    });
    const ir = { extra:target };
    const first = capturePhase8SemanticSnapshot(ir);
    delete target.a;
    Object.defineProperty(target, 'b', {
      value:2, enumerable:true, configurable:true, writable:true,
    });
    const second = capturePhase8SemanticSnapshot(ir);
    assert.notEqual(second, first, 'custom container own-key replacement must discard the cache');
    assert.equal(Object.hasOwn(second.extra, 'a'), false);
    assert.equal(second.extra.b, 2);
  }

  const symbol = Symbol('late-semantic-key');
  const symbolTarget = { a:1 };
  const symbolIr = { extra:symbolTarget };
  capturePhase8SemanticSnapshot(symbolIr);
  delete symbolTarget.a;
  symbolTarget[symbol] = 2;
  assert.throws(() => capturePhase8SemanticSnapshot(symbolIr), /identity-symbol-semantic-metadata/);
});

test('T013 cache validation cannot hide a reentrant ownKeys mutation', () => {
  const makeGraph = () => {
    const target = { id:1, bits:8, origin:{ instructionIds:['v'] } };
    let phase = 'seed';
    let ownKeyCalls = 0;
    const value = new Proxy(target, {
      ownKeys(object) {
        ownKeyCalls += 1;
        if (ownKeyCalls === 2) object.id = 99;
        if (ownKeyCalls === 3) object.id = 1;
        return Reflect.ownKeys(object);
      },
      getOwnPropertyDescriptor(object, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
        if (phase === 'validate' && key === 'origin') object.id = 99;
        return descriptor;
      },
    });
    return {
      ir:{ values:[value], blocks:[], entry:null },
      target,
      setPhase(next) { phase = next; },
    };
  };

  // A cache hit must not return the immutable graph captured before the trap
  // changed the producer. The separate graph below checks the publication
  // guard without consuming the cache-validation ownKeys call first.
  const cachedGraph = makeGraph();
  const first = capturePhase8SemanticSnapshot(cachedGraph.ir);
  cachedGraph.setPhase('validate');
  const second = capturePhase8SemanticSnapshot(cachedGraph.ir);
  assert.notEqual(second, first, 'reentrant ownKeys mutation must discard the raw cache');
  assert.equal(first.values[0].id, 1);
  assert.equal(cachedGraph.target.id, 99);

  const publicationGraph = makeGraph();
  const state = seedAnalysisState(publicationGraph.ir);
  const resolved = canonicalAnalysisIdentity({
    analysis:state,
    ir:semanticSnapshotForAnalysis(state),
  });
  publicationGraph.setPhase('validate');
  assert.equal(analysisSemanticSnapshotIsCurrent(state, { resolvedAnalysisIdentity:resolved }), false,
    'publication must use a fresh producer witness after a reentrant mutation');
  assert.equal(semanticSnapshotForAnalysis(state).values[0].id, 1);
  assert.equal(publicationGraph.target.id, 99);

  const identityGraph = makeGraph();
  const identityFirst = canonicalAnalysisIdentity({ ir:identityGraph.ir });
  identityGraph.setPhase('validate');
  const identitySecond = canonicalAnalysisIdentity({ ir:identityGraph.ir });
  assert.equal(identityFirst.valid, true);
  assert.equal(identitySecond.valid, true);
  assert.notEqual(identitySecond.semanticSnapshot, identityFirst.semanticSnapshot,
    'identity derivation must not reuse a stale live-producer snapshot');
  assert.notEqual(identitySecond.identity.shapeDigest, identityFirst.identity.shapeDigest);
});

test('T013 issued identity provenance rejects caller mutation before publication reuse', () => {
  for (const mutate of [
    (issued) => { issued.identity = { ...issued.identity, functionId:'forged-function' }; },
    (issued) => { issued.valid = false; },
    (issued) => { issued.semanticSnapshot = {}; },
  ]) {
    const ir = fixture();
    const state = seedAnalysisState(ir);
    const issued = canonicalAnalysisIdentity({
      analysis:state,
      ir:semanticSnapshotForAnalysis(state),
    });
    assert.equal(issued.valid, true);
    const originalIdentity = issued.identity;
    mutate(issued);
    const observed = canonicalAnalysisIdentity({
      analysis:state,
      ir,
      resolvedAnalysisIdentity:issued,
    });
    assert.equal(observed.valid, true);
    assert.equal(observed.identity.functionId, originalIdentity.functionId,
      'a rewritten public identity field must not become an issued witness');
    assert.notEqual(observed.identity, issued.identity,
      'publication must derive or retrieve the canonical identity after provenance invalidation');
  }
});

test('T013 provenance recheck reads issued fields as data without invoking accessors', () => {
  const target = { id:1, bits:8 };
  let armed = false;
  let getterReads = 0;
  let issued;
  const value = new Proxy(target, {
    ownKeys(object) {
      if (armed) {
        Object.defineProperty(issued, 'identity', {
          get() {
            getterReads += 1;
            object.id = 99;
            return null;
          },
          configurable:true,
        });
        armed = false;
      }
      return Reflect.ownKeys(object);
    },
  });
  const ir = { values:[value], blocks:[], entry:null };
  const state = seedAnalysisState(ir);
  issued = canonicalAnalysisIdentity({ analysis:state, ir:semanticSnapshotForAnalysis(state) });
  assert.equal(issued.valid, true);
  armed = true;
  assert.equal(analysisSemanticSnapshotIsCurrent(state, { resolvedAnalysisIdentity:issued }), false,
    'an accessor installed during the raw witness must invalidate publication');
  assert.equal(getterReads, 0, 'provenance validation must not execute a caller accessor');
  assert.equal(target.id, 1, 'the uncalled accessor must not mutate the producer');
});

test('T013 cached witness and authority traversal share the fixed work budget', () => {
  const makeIr = () => ({ values:[], blocks:[], entry:null,
    extra:new Map(Array.from({ length:125000 }, (_, index) => [index, 0])) });
  const ir = makeIr();
  capturePhase8SemanticSnapshot(ir);
  const state = seedAnalysisState(ir);
  const resolved = canonicalAnalysisIdentity({
    ir:semanticSnapshotForAnalysis(state),
    analysis:state,
  });
  assert.equal(resolved.valid, true);
  const authority = { nested:new Array(1000000) };
  // The seeded state makes this the real publication path. Its initial capture
  // is warmed by the public snapshot call above, but publication still takes a
  // fresh producer witness rather than trusting a finite raw Proxy cache.
  const warm = canonicalAnalysisIdentity({
    ir,
    analysis:state,
    analysisIdentity:authority,
    resolvedAnalysisIdentity:resolved,
  });
  const coldIr = makeIr();
  const coldState = seedAnalysisState(coldIr);
  const coldResolved = canonicalAnalysisIdentity({
    ir:semanticSnapshotForAnalysis(coldState),
    analysis:coldState,
  });
  const cold = canonicalAnalysisIdentity({
    ir:coldIr,
    analysis:coldState,
    analysisIdentity:authority,
    resolvedAnalysisIdentity:coldResolved,
  });
  assert.equal(cold.valid, false);
  assert.equal(warm.valid, false, 'publication witness and authority traversal share one fixed work allowance');
});

test('T013 documents total-work accounting when a public cache mismatch recaptures', () => {
  // A cold capture of this graph fits the fixed Semantic IR reference budget.
  // After mutation, cache validation plus recapture intentionally charge the
  // same budget and therefore fail closed instead of refunding witness work.
  const ir = { extra:Array.from({ length:100000 }, () => ({ value:1 })) };
  assert.doesNotThrow(() => capturePhase8SemanticSnapshot(ir));
  ir.extra[0].value = 2;
  assert.throws(
    () => capturePhase8SemanticSnapshot(ir),
    /identity-work-budget-exceeded/,
    'cache mismatch recapture must honor total actual-work accounting',
  );
});

test('T013 raw snapshot witness rechecks mutable fields and hidden proxy fields', () => {
  const target = { id:1, bits:8 };
  const proxied = new Proxy(target, {
    ownKeys(object) { return Reflect.ownKeys(object).filter((key) => key !== 'bits'); },
  });
  const ir = { values:[proxied], blocks:[], entry:null };
  const first = capturePhase8SemanticSnapshot(ir);
  target.bits = 16;
  const second = capturePhase8SemanticSnapshot(ir);
  assert.notEqual(second, first);
  assert.equal(second.values[0].bits, 16);

  const hiddenTarget = { id:2 };
  const hidden = new Proxy(hiddenTarget, {
    ownKeys(object) { return Reflect.ownKeys(object).filter((key) => key !== 'bits'); },
  });
  const hiddenIr = { values:[hidden], blocks:[], entry:null };
  const hiddenFirst = capturePhase8SemanticSnapshot(hiddenIr);
  hiddenTarget.bits = 8;
  const hiddenSecond = capturePhase8SemanticSnapshot(hiddenIr);
  assert.notEqual(hiddenSecond, hiddenFirst);
  assert.equal(hiddenSecond.values[0].bits, 8);

  const accessorIr = { values:[{ id:3, field:1 }], blocks:[], entry:null };
  capturePhase8SemanticSnapshot(accessorIr);
  Object.defineProperty(accessorIr.values[0], 'field', {
    get() { return 1; }, enumerable:true, configurable:true,
  });
  assert.throws(() => capturePhase8SemanticSnapshot(accessorIr), /identity-unsupported-semantic-descriptor/);

  // Sparse arrays can change length while retaining the same own-key domain
  // (`length` only). The non-enumerable length descriptor is still semantic
  // snapshot input and must invalidate the cached graph.
  const sparse = [];
  sparse.length = 4;
  const sparseIr = { extra:sparse };
  const sparseFirst = capturePhase8SemanticSnapshot(sparseIr);
  sparse.length = 8;
  const sparseSecond = capturePhase8SemanticSnapshot(sparseIr);
  assert.notEqual(sparseSecond, sparseFirst);
  assert.equal(sparseSecond.extra.length, 8);
});

test('T013 transactions consume the captured graph, not a mutable producer graph', () => {
  const ir = fixture();
  const state = seedAnalysisState(ir);
  let observed = null;
  const pass = noOpPass('phase8.t013.snapshot-observer', (context) => {
    observed = context.ir;
    return createPassResult({
      descriptor:pass.descriptor,
      status:'unchanged',
      changed:false,
      completeness:'complete',
    });
  });

  const outcome = runPassTransaction(state, pass, { analysis:state, ir }, {});
  assert.equal(outcome.committed, true);
  assert.equal(observed, semanticSnapshotForAnalysis(state));
  assert.notEqual(observed, ir);
  assert.ok(Object.isFrozen(observed));
  assert.equal(state.get('cfg').blocks, observed.blocks);
});

test('T013 rejects delayed publication after a raw semantic mutation even with a forged bypass flag', () => {
  const ir = fixture();
  const state = seedAnalysisState(ir);
  const pass = noOpPass('phase8.t013.snapshot-mutator', () => {
    ir.blocks[0].id = 'changed-after-capture';
    return createPassResult({
      descriptor:pass.descriptor,
      status:'unchanged',
      changed:false,
      completeness:'complete',
    });
  });

  const outcome = runPassTransaction(state, pass, {
    analysis:state,
    ir,
    deferSemanticSnapshotPublicationCheck:true,
  }, {});
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, 'semantic-snapshot-changed-before-commit');
  assert.equal(state.version('cfg'), 1);
});

test('T013 public batch publishes all staged writes in one commit', () => {
  const ir = fixture();
  const state = seedAnalysisState(ir);
  const pass = producingPass('phase8.t013.atomic-positive');

  const batch = runPassTransactionBatch(state, [pass], { analysis:state, ir }, {});

  assert.equal(batch.committed, true);
  assert.equal(batch.stopReason, null);
  assert.equal(batch.snapshotCurrent, true);
  assert.equal(batch.outcomes[0].committed, true);
  assert.deepEqual(batch.outcomes[0].staged, ['ranges']);
  assert.deepEqual(state.get('ranges'), { completeness:'complete', value:'fresh' });
  assert.equal(state.version('ranges'), 1);
});

test('T013 public batch leaves every authoritative value and version untouched after stale raw graph publication', () => {
  const ir = fixture();
  const state = seedAnalysisState(ir);
  const before = captureState(state);
  let pass;
  pass = producingPass('phase8.t013.atomic-stale', (_context, _budget, staging) => {
    ir.blocks[0].id = 'changed-during-batch';
    staging.stage('ranges', Object.freeze({ completeness:'complete', value:'stale' }));
    return createPassResult({
      descriptor:pass.descriptor,
      status:'changed',
      produced:['ranges'],
      completeness:'complete',
    });
  });

  const batch = runPassTransactionBatch(state, [pass], { analysis:state, ir }, {});

  assert.equal(batch.committed, false);
  assert.equal(batch.stopReason, 'semantic-snapshot-changed-before-publication');
  assert.equal(batch.snapshotCurrent, false);
  assert.equal(batch.outcomes[0].committed, false);
  assert.equal(batch.outcomes[0].result, null);
  assert.deepEqual(batch.outcomes[0].staged, []);
  assert.deepEqual(batch.outcomes[0].invalidated, []);
  assertStateUnchanged(state, before);
});

test('T013 public batch discards earlier private writes when a later pass fails', () => {
  const ir = fixture();
  const state = seedAnalysisState(ir);
  const before = captureState(state);
  const producer = producingPass('phase8.t013.atomic-before-failure');
  const descriptor = createPassDescriptor({
    id:'phase8.t013.atomic-failure',
    version:'1.0.0',
    stage:'scalar-optimization',
    consumes:['ranges'],
    produces:[],
  });
  const failure = {
    descriptor,
    run() { throw new Error('expected-batch-failure'); },
  };

  const batch = runPassTransactionBatch(state, [producer, failure], { analysis:state, ir }, {});

  assert.equal(batch.committed, false);
  assert.equal(batch.stopReason, 'failed:expected-batch-failure');
  assert.equal(batch.stoppedPassId, descriptor.id);
  assert.equal(batch.outcomes[0].committed, false);
  assert.equal(batch.outcomes[1].committed, false);
  assertStateUnchanged(state, before);
});

test('T013 public batch rechecks delayed cancellation after final identity validation and before mutation', () => {
  const ir = fixture();
  const state = seedAnalysisState(ir);
  const before = captureState(state);
  const pass = producingPass('phase8.t013.atomic-delayed-cancellation');
  let checks = 0;
  const budget = {
    shouldAbort() {
      checks += 1;
      return checks >= 4;
    },
  };

  const batch = runPassTransactionBatch(state, [pass], { analysis:state, ir }, budget);

  assert.equal(checks, 4);
  assert.equal(batch.committed, false);
  assert.equal(batch.stopReason, 'cancelled-before-publication');
  assert.equal(batch.snapshotCurrent, true);
  assert.equal(batch.outcomes[0].committed, false);
  assertStateUnchanged(state, before);
});

test('T013 public vertical refuses an analysis state that has no immutable semantic binding', () => {
  const state = createAnalysisState({ cfg:{ blocks:[{ id:'entry' }] } });
  const outcome = runPhase8Vertical({ analysis:state, enabledStages:['canonical-facts'] }, {});
  assert.equal(outcome.ledger.published, false);
  assert.equal(outcome.ledger.stopReason, 'analysis-snapshot-unavailable');
});
