import assert from 'node:assert/strict';
import test from 'node:test';

import { ANALYSIS_KEYS, createPassDescriptor, createPassResult } from '../../../js/decompiler/phase8/contract.js';
import {
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
