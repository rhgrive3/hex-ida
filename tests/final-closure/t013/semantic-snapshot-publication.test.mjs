import assert from 'node:assert/strict';
import test from 'node:test';

import { createPassDescriptor, createPassResult } from '../../../js/decompiler/phase8/contract.js';
import {
  createAnalysisState,
  runPassTransaction,
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

test('T013 public vertical refuses an analysis state that has no immutable semantic binding', () => {
  const state = createAnalysisState({ cfg:{ blocks:[{ id:'entry' }] } });
  const outcome = runPhase8Vertical({ analysis:state, enabledStages:['canonical-facts'] }, {});
  assert.equal(outcome.ledger.published, false);
  assert.equal(outcome.ledger.stopReason, 'analysis-snapshot-unavailable');
});
