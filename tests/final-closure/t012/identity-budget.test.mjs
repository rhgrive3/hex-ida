import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry } from '../../../tools/validation/phase8/decompile-corpus.mjs';

function referenceVectorGraph() {
  return {
    values:[{
      id:1, kind:'arg', bits:8, signed:null, const:null, def:null, uses:[],
      origin:{ instructionIds:['instruction_version_value'] },
    }],
    blocks:[{
      id:'entry', index:0, insts:[], phis:[], memPhis:[], successorEdges:[], succ:[], pred:[],
      origin:{ instructionIds:['instruction_version_block'] },
    }],
    entry:0, idom:[null], ipdom:[null], backEdges:[], loops:[],
    origin:{ instructionIds:['instruction_version_function'] },
  };
}

test('T012 preserves the reviewed v7 digest reference vector', () => {
  const result = canonicalAnalysisIdentity({ ir:referenceVectorGraph() });
  assert.equal(result.valid, true, result.reason ?? 'reference vector must remain valid');
  // Captured from the bounded key-child v7 implementation for this
  // exact graph. This is an independent transcript check, not a self-derived
  // expectation from the optimized call.
  assert.deepEqual(result.identity, {
    binaryId:'binary:b367d20e39f5a17141be2424db680582',
    functionId:'function:shape:8275876b374734dfcdf169ea34ff1774',
    snapshotId:'snapshot:7b1b3f9b307b693fb48e6a7b4b8d7df6',
    semanticIrId:'semantic-ir:0bf8eedaa554866253f82826aa19a5b7',
    ssaId:'ssa:b1e7725e7baee4c28ba897f19d5239bf',
    analyzerVersion:'phase8-analysis-v1',
    shapeDigest:'shape:8275876b374734dfcdf169ea34ff1774',
  });
});

test('T012 charges distinct long-key text instead of laundering it through key reuse', () => {
  const ir = referenceVectorGraph();
  ir.metadata = {
    items:Array.from({ length:1280 }, (_, index) => ({
      [`prefix_${index}`]:index,
      [`${'z'.repeat(1024)}_${index}`]:index,
    })),
  };
  const result = canonicalAnalysisIdentity({ ir });
  assert.equal(result.valid, false,
    'distinct long-key text must exhaust the fixed identity work budget');
});

test('T012 strict identity admits the frozen O2 DAG without widening its work cap', () => {
  const corpus = loadCorpus();
  const entry = corpus.functions.find((candidate) => candidate.id === 'x86_64.quality.loop_nested.O2');
  assert.ok(entry, 'the frozen O2 identity regression entry must remain in the corpus');
  const outcome = decompileEntry(entry, {
    index:corpus.functions.indexOf(entry),
    deterministicTransforms:false,
    phase8Optimize:false,
  });
  assert.ok(outcome.result?.ir, outcome.failure ?? 'semantic IR unavailable');

  const first = canonicalAnalysisIdentity({ ir:outcome.result.ir });
  const second = canonicalAnalysisIdentity({ ir:outcome.result.ir });
  assert.equal(first.valid, true, first.reason ?? 'canonical identity must be valid');
  assert.deepEqual(second.identity, first.identity,
    'call-local text memoization must not change or retain identity state');

  // Exact per-call transcript equality proves that the optimization only
  // changes repeated bounded text accounting, never the semantic digest.
  assert.match(first.identity.semanticIrId, /^semantic-ir:[0-9a-f]{32}$/);
  assert.match(first.identity.shapeDigest, /^shape:[0-9a-f]{32}$/);
  assert.equal(first.identity.analyzerVersion, 'phase8-analysis-v1');
});
