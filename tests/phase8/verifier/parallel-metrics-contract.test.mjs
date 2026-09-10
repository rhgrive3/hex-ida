import assert from 'node:assert/strict';
import test from 'node:test';

import { observeCorpus } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { runIndependentPhase8MetricPasses } from '../../../tools/validation/phase8/parallel-metrics.mjs';

const CORPUS = Object.freeze({
  functions: Object.freeze([
    Object.freeze({
      id: 'phase8-parallel-contract-arm64',
      architectureId: 'arm64',
      representation: 'assembly',
      function: 'phase8_parallel_contract',
      optimization: 'O0',
      assembly: 'mov x0, x0\nret',
    }),
  ]),
});

const BUDGET_MS = 2_000;

test('parallel metric workers preserve the serial proof result and clone boundary', async () => {
  const observations = observeCorpus({ corpus: CORPUS, decompilerTimeBudgetMs: BUDGET_MS });
  assert.equal(observations.length, 1);
  assert.doesNotThrow(() => structuredClone(observations),
    'workerData observations must remain structured-cloneable');

  const serial = await runIndependentPhase8MetricPasses({
    corpus: CORPUS,
    observations,
    decompilerTimeBudgetMs: BUDGET_MS,
    env: { HEX_PHASE8_METRIC_WORKERS: '1' },
  });
  const parallel = await runIndependentPhase8MetricPasses({
    corpus: CORPUS,
    observations,
    decompilerTimeBudgetMs: BUDGET_MS,
    env: { HEX_PHASE8_METRIC_WORKERS: '2' },
  });

  assert.deepEqual(parallel, serial,
    'bounded workers may change scheduling only, never Phase 8 evidence');
});
