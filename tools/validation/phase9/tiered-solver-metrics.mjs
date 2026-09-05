/**
 * Observational startup/solve/memory harness for the local tiered QF_BV
 * deployment. Deterministic resource ceilings remain enforced by the backend;
 * these host measurements are evidence and do not replace or relax any
 * existing repository performance budget.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { bvSort, BV_BINARY_OP, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import { createBinary, createBv, createCompare, createFreshSymbol } from '../../../js/symbolic/expr/factory.js';
import { TieredBvBackend } from '../../../js/symbolic/solver/tiered-backend.js';
import { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery } from '../../../js/symbolic/verify/query.js';

function query(assertion, constraints = []) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'phase9-tiered-solver-metrics',
    constraints,
    assertion,
  });
}
async function measureSolve(backend, width) {
  const symbol = createFreshSymbol(bvSort(width), `metrics_x_${width}`);
  const candidate = query(createCompare(
    BV_COMPARE_OP.EQ,
    createBinary(BV_BINARY_OP.ADD, symbol, createBv(width, 1n)),
    createBv(width, 0n),
  ));
  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const result = await backend.createSession({ timeoutMs: 5000 }).check(candidate, { timeoutMs: 5000 });
  const elapsedMs = performance.now() - started;
  const memory = process.memoryUsage();
  return Object.freeze({
    width,
    status: result.status,
    route: result.stats.routingTier,
    elapsedMs,
    providerSolveTimeMs: result.stats.solveTimeMs,
    heapDeltaBytes: Math.max(0, memory.heapUsed - heapBefore),
    rssDeltaBytes: Math.max(0, memory.rss - rssBefore),
    cnfVariables: result.stats.cnfVariables || 0,
    cnfClauses: result.stats.cnfClauses || 0,
  });
}

export async function measureTieredSolver() {
  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;
  const startupAt = performance.now();
  const backend = new TieredBvBackend();
  const startupMs = performance.now() - startupAt;
  const startupMemory = process.memoryUsage();
  const solves = [];
  for (const width of [32, 64]) solves.push(await measureSolve(backend, width));
  return Object.freeze({
    schemaVersion: 'hex-tiered-solver-metrics/v1',
    backend: Object.freeze({
      id: backend.id,
      version: backend.version,
      capabilityFingerprint: backend.capabilityFingerprint(),
    }),
    startup: Object.freeze({
      elapsedMs: startupMs,
      heapDeltaBytes: Math.max(0, startupMemory.heapUsed - heapBefore),
      rssDeltaBytes: Math.max(0, startupMemory.rss - rssBefore),
    }),
    solves: Object.freeze(solves),
    resourceCeilings: Object.freeze({
      maxVariables: backend.wideBackend.maxVariables,
      maxClauses: backend.wideBackend.maxClauses,
      maxDecisions: backend.wideBackend.maxDecisions,
      maxPropagations: backend.wideBackend.maxPropagations,
    }),
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  measureTieredSolver().then((metrics) => {
    process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
