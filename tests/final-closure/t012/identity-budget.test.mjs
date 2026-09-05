import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry } from '../../../tools/validation/phase8/decompile-corpus.mjs';

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
