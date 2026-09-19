#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, verifyInputs } from './manifest.mjs';
import { runFreshCase } from './run-fresh-case.mjs';
import { captureSourceIdentity, configDigest, percentile } from './fresh-state.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index++) if (args[index] === name && args[index + 1] != null) values.push(args[index + 1]);
  return values;
}
function caseFileName(id) { return `${Buffer.from(id).toString('hex')}.json`; }

export async function runPool(items, concurrency, worker) {
  const count = Math.max(1, Math.min(concurrency, Math.max(1, items.length)));
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length:count }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

export async function runFreshBenchmark({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  repoRoot = REPOSITORY_ROOT,
  log = console.log,
  caseRunner = runFreshCase,
  sourceIdentityFn = captureSourceIdentity,
} = {}) {
  const suite = optionValue(args, '--suite', 'codefuse-arm64');
  const manifestFile = path.resolve(cwd, optionValue(args, '--manifest', `benchmarks/public/${suite}/manifest.json`));
  const outputDir = path.resolve(cwd, optionValue(args, '--output', `reports/public-benchmark/${suite}`));
  const receiptRoot = path.resolve(cwd, optionValue(args, '--receipt-dir', `${outputDir}/.fresh-receipts`));
  const functionTimeoutMs = Number(optionValue(args, '--function-timeout-ms', '10000'));
  const setupTimeoutMs = Number(optionValue(args, '--setup-timeout-ms', '60000'));
  const watchdogGraceMs = Number(optionValue(args, '--watchdog-grace-ms', '1000'));
  const workers = Number(optionValue(args, '--workers', String(Math.min(8, os.availableParallelism?.() ?? os.cpus().length))));
  const limit = Number(optionValue(args, '--limit', '0'));
  const retryStates = optionValues(args, '--retry-state');
  const requestedCaseIds = new Set(optionValues(args, '--case-id'));
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 64) throw new Error('fresh-benchmark-workers-invalid');
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('fresh-benchmark-limit-invalid');
  if (!Number.isSafeInteger(functionTimeoutMs) || functionTimeoutMs < 100 || functionTimeoutMs > 900000) throw new Error('fresh-benchmark-function-timeout-invalid');
  if (!Number.isSafeInteger(setupTimeoutMs) || setupTimeoutMs < 1000 || setupTimeoutMs > 900000) throw new Error('fresh-benchmark-setup-timeout-invalid');

  const manifest = loadManifest(manifestFile);
  const suiteRoot = path.dirname(manifestFile);
  let inputs = verifyInputs(manifest, suiteRoot);
  if (requestedCaseIds.size) inputs = inputs.filter(entry => requestedCaseIds.has(entry.id));
  if (limit > 0) inputs = inputs.slice(0, limit);
  fs.mkdirSync(outputDir, { recursive:true });
  fs.mkdirSync(receiptRoot, { recursive:true });

  const source = sourceIdentityFn({ repoRoot });
  const configHash = configDigest({
    suite:manifest.suite,
    manifestSha256:createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex'),
    functionTimeoutMs,
    setupTimeoutMs,
    watchdogGraceMs,
    analysisSemantics:'product-query-decompile/v1',
  });
  const started = performance.now();
  const ready = inputs.filter(entry => entry.state === 'READY');
  const preclassified = inputs.filter(entry => entry.state !== 'READY').map(entry => ({ id:entry.id, state:entry.state, elapsedMs:0, functionCount:0, restarts:0 }));

  const completed = await runPool(ready, workers, async entry => {
    const out = path.join(outputDir, caseFileName(entry.id));
    const receiptDir = path.join(receiptRoot, Buffer.from(entry.id).toString('hex'));
    const before = performance.now();
    try {
      const result = await caseRunner({
        binary:entry.path,
        out,
        caseId:entry.id,
        receiptDir,
        sourceIdentity:source.identity,
        configHash,
        functionTimeoutMs,
        setupTimeoutMs,
        watchdogGraceMs,
        retryStates,
      });
      const row = {
        id:entry.id,
        state:result.row.state,
        reason:result.row.reason ?? null,
        elapsedMs:performance.now() - before,
        functionCount:result.row.functions?.length ?? 0,
        functionStates:result.row.functionStateCounts ?? {},
        reusedFunctions:result.row.performance?.reusedFunctions ?? 0,
        executedFunctions:result.row.performance?.executedFunctions ?? 0,
        restarts:result.restarts,
        setup:result.row.performance?.setup ?? null,
      };
      log(`${entry.id}: ${row.state} (${row.functionCount} functions, ${row.elapsedMs.toFixed(0)} ms, reused ${row.reusedFunctions})`);
      return row;
    } catch (error) {
      const row = { id:entry.id, state:'CRASH', reason:`fresh-case-runner-error:${error?.code || error?.name || 'unknown'}`, elapsedMs:performance.now() - before, functionCount:0, functionStates:{}, reusedFunctions:0, executedFunctions:0, restarts:0, setup:null };
      log(`${entry.id}: CRASH (${row.reason})`);
      return row;
    }
  });

  const results = [...completed, ...preclassified];
  const states = {};
  const functionStates = {};
  for (const row of results) {
    states[row.state] = (states[row.state] || 0) + 1;
    for (const [state, count] of Object.entries(row.functionStates ?? {})) functionStates[state] = (functionStates[state] || 0) + count;
  }
  const caseTimes = completed.map(row => row.elapsedMs);
  const functionCount = completed.reduce((sum, row) => sum + row.functionCount, 0);
  const wallMs = performance.now() - started;
  const summary = {
    schema:'hex-public-benchmark-fresh-report/v1',
    suite:manifest.suite,
    total:inputs.length,
    source,
    configHash,
    workers,
    functionTimeoutMs,
    setupTimeoutMs,
    watchdogGraceMs,
    receiptRoot,
    states,
    functionStates,
    performance:{
      wallMs,
      caseP50Ms:percentile(caseTimes, 50),
      caseP90Ms:percentile(caseTimes, 90),
      caseMaxMs:caseTimes.length ? Math.max(...caseTimes) : null,
      functionCount,
      functionsPerSecond:wallMs > 0 ? functionCount / (wallMs / 1000) : null,
      casesPerSecond:wallMs > 0 ? completed.length / (wallMs / 1000) : null,
      reusedFunctions:completed.reduce((sum,row)=>sum + row.reusedFunctions, 0),
      executedFunctions:completed.reduce((sum,row)=>sum + row.executedFunctions, 0),
      restarts:completed.reduce((sum,row)=>sum + row.restarts, 0),
    },
    results,
  };
  const summaryPath = path.join(outputDir, 'fresh-summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  log(`fresh summary -> ${summaryPath}`);
  return { summary, summaryPath, exitCode:results.some(row => ['ERROR', 'CRASH'].includes(row.state)) ? 1 : 0 };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await runFreshBenchmark()).exitCode; }
  catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}
