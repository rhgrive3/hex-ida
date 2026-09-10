import os from 'node:os';
import { Worker } from 'node:worker_threads';

import { passRegistryDigest, phase8Passes } from '../../../js/decompiler/phase8/index.js';
import { loadCorpus } from './build-corpus.mjs';
import { observeCorpus } from './decompile-corpus.mjs';
import {
  MEASUREMENT_TIME_BUDGET_MS,
  aggregateCertainty,
  architectureBoundaryViolations,
  artifactIdentityFailures,
  completeResultDivergences,
  determinismFailures,
  loadFrozenBaseline,
  loadFrozenProvenance,
  performanceMetrics,
  providerEvidence,
  qualityVector,
  safetyCounters,
  structuringAccounting,
} from './metrics.mjs';

const WORKER_URL = new URL('./parallel-metric-worker.mjs', import.meta.url);
const MAX_DEFAULT_WORKERS = 4;

export function resolvePhase8MetricWorkers(env = process.env, availableParallelism = os.availableParallelism()) {
  const requested = Number(env?.HEX_PHASE8_METRIC_WORKERS);
  if (Number.isSafeInteger(requested) && requested >= 1) return Math.min(8, requested);
  const available = Number.isSafeInteger(availableParallelism) && availableParallelism >= 1 ? availableParallelism : 1;
  return Math.max(1, Math.min(MAX_DEFAULT_WORKERS, available - 1));
}

function serialIndependentPasses({ corpus, observations, decompilerTimeBudgetMs }) {
  return {
    determinism: determinismFailures({ corpus, first: observations, decompilerTimeBudgetMs }),
    accounting: structuringAccounting({ corpus, decompilerTimeBudgetMs }),
    certainty: aggregateCertainty({ corpus, decompilerTimeBudgetMs }),
    providers: providerEvidence({ corpus, decompilerTimeBudgetMs }),
  };
}

function runMetricWorker(task, { corpus, observations, decompilerTimeBudgetMs }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: {
        task,
        corpus,
        firstObservations: task === 'determinism' ? observations : null,
        decompilerTimeBudgetMs,
      },
    });
    let payload = null;
    let settled = false;

    worker.once('message', (message) => { payload = message; });
    worker.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`phase8 metric worker exited with status ${code}: ${task}`));
        return;
      }
      if (payload?.ok !== true) {
        const error = new Error(payload?.error?.message || `phase8 metric worker failed: ${task}`);
        if (payload?.error?.stack) error.stack = payload.error.stack;
        reject(error);
        return;
      }
      resolve(payload.value);
    });
  });
}

export async function runIndependentPhase8MetricPasses({
  corpus = loadCorpus(),
  observations,
  decompilerTimeBudgetMs = MEASUREMENT_TIME_BUDGET_MS,
  env = process.env,
} = {}) {
  if (!Array.isArray(observations)) throw new TypeError('phase8 parallel metrics: observations are required');
  // Provider authority runs the normal stage twice (providers off/on) after the
  // same full decompile, so start it first. Determinism is the lightest of these
  // whole-corpus passes and is intentionally last. A shared worker queue starts
  // the next proof as soon as any worker becomes free; there is no batch barrier.
  const tasks = ['providers', 'certainty', 'accounting', 'determinism'];
  const workers = Math.min(tasks.length, resolvePhase8MetricWorkers(env));
  if (workers <= 1) return serialIndependentPasses({ corpus, observations, decompilerTimeBudgetMs });

  const results = {};
  let nextTask = 0;
  async function workerLoop() {
    while (true) {
      const index = nextTask++;
      if (index >= tasks.length) return;
      const task = tasks[index];
      results[task] = await runMetricWorker(task, {
        corpus,
        observations,
        decompilerTimeBudgetMs,
      });
    }
  }
  await Promise.all(Array.from({ length: workers }, () => workerLoop()));
  return results;
}

/**
 * Same evidence contract as collectPhase8Metrics(), but independent whole-corpus
 * verification passes run on bounded worker threads. The production performance
 * measurement remains exclusive and starts only after every proof worker has
 * exited, so worker CPU contention cannot contaminate the release latency metric.
 */
export async function collectPhase8MetricsParallel({ repetitions = 3, includePerformance = true, env = process.env } = {}) {
  const corpus = loadCorpus();
  const baseline = loadFrozenBaseline();
  const frozenProvenance = loadFrozenProvenance(undefined, baseline);
  const observations = observeCorpus({ corpus, decompilerTimeBudgetMs: MEASUREMENT_TIME_BUDGET_MS });
  const quality = qualityVector(observations);
  const baselineQuality = qualityVector(baseline.observations);
  const boundary = architectureBoundaryViolations();
  const artifactFailures = artifactIdentityFailures();
  const independent = await runIndependentPhase8MetricPasses({
    corpus,
    observations,
    decompilerTimeBudgetMs: MEASUREMENT_TIME_BUDGET_MS,
    env,
  });
  const performance = includePerformance ? performanceMetrics({ repetitions, corpus }) : null;
  const productionDivergences = performance ? completeResultDivergences(performance.runs) : null;

  return {
    corpus: {
      corpusId: corpus.corpusId,
      corpusVersion: corpus.corpusVersion,
      corpusDigest: corpus.corpusDigest,
      toolchain: corpus.toolchain,
      frozenBaselineDigest: baseline.observationsDigest,
      frozenProvenanceDigest: frozenProvenance.observationsDigest,
      baselineCommit: baseline.baseCommit,
      provenanceBaseCommit: frozenProvenance.baseProductSha,
    },
    registry: {
      passRegistryDigest: passRegistryDigest(),
      passes: phase8Passes().map(({ descriptor }) => ({ id: descriptor.id, version: descriptor.version, stage: descriptor.stage })),
    },
    quality: { baseline: baselineQuality, candidate: quality },
    safety: {
      ...safetyCounters(observations, baseline, frozenProvenance),
      architectureBoundaryViolationCount: boundary.length,
      architectureBoundaryViolations: boundary.slice(0, 10),
      staleArtifactAcceptanceCount: artifactFailures.length,
      staleArtifactAcceptanceDetails: artifactFailures,
      transformDeterminismFailureCount: independent.determinism.length,
      transformDeterminismFailures: independent.determinism,
      completeResultDivergenceCount: productionDivergences == null ? null : productionDivergences.length,
      completeResultDivergences: productionDivergences ?? [],
      lostCfgEdgeCount: independent.accounting.lostCfgEdgeCount,
      edgeAccounting: independent.accounting,
      forcedTypeContradictionCount: independent.certainty.forcedTypeContradictionCount,
      aggregateCertainty: independent.certainty,
      providerEvidence: independent.providers,
    },
    performance: performance == null ? null : { ...performance, runs: undefined },
  };
}
