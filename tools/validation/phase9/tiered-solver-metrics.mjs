/**
 * Observational startup/solve/memory harness for the local tiered QF_BV
 * deployment. Deterministic resource ceilings remain enforced by the backend;
 * these host measurements are evidence and do not replace or relax any
 * existing repository performance budget.
 */

import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { stableDigest } from '../../../js/core/identity/index.js';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { bvSort, BV_BINARY_OP, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import { createBinary, createBv, createCompare, createFreshSymbol } from '../../../js/symbolic/expr/factory.js';
import { TieredBvBackend } from '../../../js/symbolic/solver/tiered-backend.js';
import { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery } from '../../../js/symbolic/verify/query.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE=JSON.parse(fs.readFileSync(path.join(ROOT,'tools/validation/phase9/profile.json')));
export const PROFILE_DIGEST=stableDigest(PROFILE);

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
  const session=backend.createSession({ timeoutMs:5000 });
  let result;
  try { result=await session.check(candidate,{timeoutMs:5000}); } finally { await session.dispose(); }
  const elapsedMs = performance.now() - started;
  const memory = process.memoryUsage();
  return Object.freeze({
    width,
    queryHash:candidate.queryHash,
    queryDescriptorDigest:PROFILE.performance.wideQueries.find(q=>q.descriptor.widthBits===width)?.stableDigest,
    provider:result.backend, providerVersion:result.backendVersion,
    status: result.status,
    route: result.stats.routingTier,
    elapsedMs,
    providerSolveTimeMs: result.stats.solveTimeMs,
    heapDeltaBytes: Math.max(0, memory.heapUsed - heapBefore),
    rssDeltaBytes: Math.max(0, memory.rss - rssBefore),
    cnfVariables: result.stats.cnfVariables ?? null,
    cnfClauses: result.stats.cnfClauses ?? null,
    decisions:result.stats.decisions ?? null,
    propagations:result.stats.propagations ?? null,
  });
}

export async function measureTieredSolver({productIdentity=null}={}) {
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
    profileDigest:PROFILE_DIGEST, productIdentity,
    runtime:Object.freeze({kind:'node',platform:process.platform,architecture:process.arch,nodeVersion:process.version}),
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

/** Reject missing, stale or over-budget observations; no zero defaults for missing counts. */
export function tieredPerformanceFailures(metrics,profile=PROFILE) {
  const failures=[];
  if(metrics?.profileDigest!==stableDigest(profile)) failures.push('profile-identity-mismatch');
  const expected=profile.performance;
  if(!Array.isArray(metrics?.solves) || metrics.solves.length!==expected.wideQueries.length) failures.push('wide-query-denominator-mismatch');
  for(const query of expected.wideQueries) {
    const matches=(metrics?.solves??[]).filter(row=>row.width===query.descriptor.widthBits);
    if(matches.length!==1){failures.push('wide-query-missing-or-duplicate');continue;}
    const row=matches[0];
    if(row.queryDescriptorDigest!==stableDigest(query.descriptor) || row.queryDescriptorDigest!==query.stableDigest) failures.push('query-descriptor-mismatch');
    if(row.status!==query.descriptor.expectedStatus || row.route!=='bitblast-qfbv') failures.push('wide-query-not-exact');
    if(!row.queryHash || !row.provider || !row.providerVersion) failures.push('query-provider-identity-missing');
    for(const {metric,threshold} of expected.blockingThresholds) {
      if(!Number.isSafeInteger(row[metric]) || row[metric]<0 || row[metric]>threshold) failures.push(`resource:${metric}`);
    }
  }
  const generator=expected.differentialGenerator;
  if(stableDigest(generator.descriptor)!==generator.stableDigest) failures.push('differential-descriptor-mismatch');
  try {
    const actual=createHash('sha256').update(fs.readFileSync(path.join(ROOT,generator.descriptor.sourcePath))).digest('hex');
    if(actual!==generator.descriptor.sourceSha256)failures.push('differential-source-mismatch');
  } catch { failures.push('differential-source-missing'); }
  return failures;
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
