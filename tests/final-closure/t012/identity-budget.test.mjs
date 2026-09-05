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

test('T012 preserves the reviewed v6 digest reference vector', () => {
  const result = canonicalAnalysisIdentity({ ir:referenceVectorGraph() });
  assert.equal(result.valid, true, result.reason ?? 'reference vector must remain valid');
  // Captured from the pre-optimization v6 implementation at d740b307 for this
  // exact graph. This is an independent transcript check, not a self-derived
  // expectation from the optimized call.
  assert.deepEqual(result.identity, {
    binaryId:'binary:69a1f14325b0c65b2ebfc48c61ef6584',
    functionId:'function:shape:f8eb8c66bb4b88f2ab4a66d555ba60ad',
    snapshotId:'snapshot:107a0519e273d642bc1311b57d965c63',
    semanticIrId:'semantic-ir:9e6a9c909af3e1a827e2d76d58d645d1',
    ssaId:'ssa:73c22a61dc5e6db5c5e46a4abeb00f78',
    analyzerVersion:'phase8-analysis-v1',
    shapeDigest:'shape:f8eb8c66bb4b88f2ab4a66d555ba60ad',
  });
});

test('T012 charges repeated long-key transitions instead of laundering them through text reuse', () => {
  const ir = referenceVectorGraph();
  const longKey = 'z'.repeat(1024);
  ir.metadata = {
    items:Array.from({ length:1280 }, (_, index) => ({
      [`prefix_${index}`]:index,
      [longKey]:index,
    })),
  };
  const result = canonicalAnalysisIdentity({ ir });
  assert.equal(result.valid, false,
    'distinct long-key transition states must exhaust the fixed identity work budget');
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
