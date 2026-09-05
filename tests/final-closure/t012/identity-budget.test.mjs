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

test('T012 pins the reviewed v7 digest snapshot', () => {
  const result = canonicalAnalysisIdentity({ ir:referenceVectorGraph() });
  assert.equal(result.valid, true, result.reason ?? 'reference vector must remain valid');
  // Fixed snapshot for this exact graph under the bounded key-child v7
  // transcript. This is a regression anchor, not a v6 compatibility claim.
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

  // Exact per-call replay equality proves deterministic v7 identity derivation;
  // it does not compare this transcript with an earlier version.
  assert.match(first.identity.semanticIrId, /^semantic-ir:[0-9a-f]{32}$/);
  assert.match(first.identity.shapeDigest, /^shape:[0-9a-f]{32}$/);
  assert.equal(first.identity.analyzerVersion, 'phase8-analysis-v1');
});

test('T012 rejects uncached repeated long keys after the bounded key cache saturates', () => {
  const ir = referenceVectorGraph();
  const longKey = 'z'.repeat(2048);
  ir.metadata = {
    items:[
      ...Array.from({ length:4096 }, (_, index) => ({ [`unique_key_${index}`]:index })),
      ...Array.from({ length:512 }, () => ({ [longKey]:1 })),
    ],
  };
  const result = canonicalAnalysisIdentity({ ir });
  assert.equal(result.valid, false,
    'uncached repeated long-key text must remain bounded after 4096 cached spellings');
});

test('T012 key-child reuse remains sensitive to values and structure', () => {
  const graph = (values) => {
    const ir = referenceVectorGraph();
    ir.metadata = { items:values.map((value) => ({ sharedKey:value })) };
    return ir;
  };
  const first = canonicalAnalysisIdentity({ ir:graph([1, 2]) });
  const replay = canonicalAnalysisIdentity({ ir:graph([1, 2]) });
  assert.equal(first.valid, true, first.reason ?? 'repeated key graph must be valid');
  assert.equal(replay.valid, true, replay.reason ?? 'replayed repeated key graph must be valid');
  assert.deepEqual(replay.identity, first.identity,
    'reusing one key child across equal values must preserve deterministic identity');

  const changedValue = canonicalAnalysisIdentity({ ir:graph([1, 3]) });
  assert.equal(changedValue.valid, true, changedValue.reason ?? 'changed value graph must remain valid');
  assert.notEqual(changedValue.identity.shapeDigest, first.identity.shapeDigest,
    'a value change cannot be hidden by a reused property-key child');

  const changedStructure = canonicalAnalysisIdentity({ ir:graph([1, 2, 3]) });
  assert.equal(changedStructure.valid, true,
    changedStructure.reason ?? 'changed structure graph must remain valid');
  assert.notEqual(changedStructure.identity.shapeDigest, first.identity.shapeDigest,
    'a structure change cannot be hidden by a reused property-key child');
});
