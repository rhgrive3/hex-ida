import { parentPort, workerData } from 'node:worker_threads';

let closeSessions = null;
let payload;

try {
  const decompile = await import('./decompile-corpus.mjs');
  closeSessions = decompile.closeSessions;
  const metrics = await import('./metrics.mjs');
  const corpus = workerData.corpus;
  const budget = workerData.decompilerTimeBudgetMs;
  if (!corpus || !Array.isArray(corpus.functions)) throw new TypeError('phase8 metric worker: corpus is required');

  let value;
  switch (workerData.task) {
    case 'determinism':
      value = metrics.determinismFailures({
        corpus,
        first: workerData.firstObservations,
        decompilerTimeBudgetMs: budget,
      });
      break;
    case 'accounting':
      value = metrics.structuringAccounting({ corpus, decompilerTimeBudgetMs: budget });
      break;
    case 'certainty':
      value = metrics.aggregateCertainty({ corpus, decompilerTimeBudgetMs: budget });
      break;
    case 'providers':
      value = metrics.providerEvidence({ corpus, decompilerTimeBudgetMs: budget });
      break;
    default:
      throw new TypeError(`phase8 metric worker: unknown task ${JSON.stringify(workerData.task)}`);
  }
  payload = { ok: true, value };
} catch (error) {
  payload = {
    ok: false,
    error: {
      message: error?.message || String(error),
      stack: error?.stack || null,
    },
  };
} finally {
  try { closeSessions?.(); } catch { /* best effort */ }
}

parentPort.postMessage(payload);
