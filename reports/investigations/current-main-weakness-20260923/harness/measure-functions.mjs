#!/usr/bin/env node
/*
 * Current-main weakness measurement runner (parent process).
 *
 * Runs the production analysis path over a selected set of codefuse-arm64
 * manifest cases with one child process per case, a per-function watchdog, and
 * per-case/per-function durable receipts. Resumable: completed cases with the
 * same head/config identity are skipped. Measurement-only; no production code.
 *
 * Usage:
 *   node reports/investigations/current-main-weakness-20260923/harness/measure-functions.mjs \
 *     --output reports/investigations/current-main-weakness-20260923/measurements/run-a \
 *     --limit 16 --workers 8 --function-timeout-ms 10000 --structure slow
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, verifyInputs } from '../../../../tools/validation/public-benchmark/manifest.mjs';
import {
  CASE_SCHEMA,
  HARNESS_REPO_ROOT,
  RUN_SCHEMA,
  SUMMARY_SCHEMA,
  atomicWriteJson,
  captureSourceIdentity,
  caseFileName,
  configDigest,
  optionValue,
  optionValues,
  readJson,
} from './lib.mjs';

const WORKER_PATH = fileURLToPath(new URL('./case-worker.mjs', import.meta.url));
const DEFAULT_OUTPUT = 'reports/investigations/current-main-weakness-20260923/measurements/run';
const REPO_ROOT = HARNESS_REPO_ROOT;

function spawnCase({ binary, caseId, outDir, receiptDir, sourceIdentity, configHash, headSha, functionTimeoutMs, structure, structureThresholdMs }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      WORKER_PATH,
      '--case-id', caseId,
      '--binary', binary,
      '--out', outDir,
      '--receipt-dir', receiptDir,
      '--source-id', sourceIdentity,
      '--config-hash', configHash,
      '--head', headSha,
      '--function-timeout-ms', String(functionTimeoutMs),
      '--structure', structure,
      '--structure-threshold-ms', String(structureThresholdMs),
      '--inflight', path.join(receiptDir, 'inflight.json'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.once('error', error => resolve({ code: null, signal: null, error, stderr }));
    child.once('close', (code, signal) => resolve({ code, signal, error: null, stderr }));
  });
}

function summarizeCase(record) {
  const functionElapsed = (record.functions ?? []).map(row => row.elapsedMs).filter(Number.isFinite);
  return {
    id: record.caseId, state: record.state, reason: record.reason ?? null,
    functionCount: record.functionCount ?? 0,
    functionStates: record.functionStates ?? {},
    elapsedMs: record.elapsedMs ?? null,
    functionElapsedMs: functionElapsed.reduce((total, value) => total + value, 0),
    setup: record.setup ?? null,
    functionDiscoveryComplete: record.functionDiscoveryComplete === true,
  };
}

export async function measureCurrentMain({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  log = console.log,
  spawnCaseFn = spawnCase,
} = {}) {
  const manifestFile = path.resolve(cwd, optionValue(args, '--manifest', 'benchmarks/public/codefuse-arm64/manifest.json'));
  const outputDir = path.resolve(cwd, optionValue(args, '--output', DEFAULT_OUTPUT));
  const receiptRoot = path.resolve(cwd, optionValue(args, '--receipt-dir', path.join(outputDir, 'receipts')));
  const workers = Number(optionValue(args, '--workers', '4'));
  const limit = Number(optionValue(args, '--limit', '0'));
  const productTimeoutMs = Number(optionValue(args, '--product-timeout-ms', '900000'));
  const functionTimeoutMs = Number(optionValue(args, '--function-timeout-ms', '10000'));
  const structure = optionValue(args, '--structure', 'slow');
  const structureThresholdMs = Number(optionValue(args, '--structure-threshold-ms', '250'));
  const requestedCaseIds = optionValues(args, '--case-id');
  const label = optionValue(args, '--label', 'current-main');
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32) throw new Error('measure-workers-invalid');
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('measure-limit-invalid');
  if (!['none', 'slow', 'all'].includes(structure)) throw new Error('measure-structure-mode-invalid');

  const manifest = loadManifest(manifestFile);
  const suiteRoot = path.dirname(manifestFile);
  const inputs = verifyInputs(manifest, suiteRoot);
  const byId = new Map(inputs.map(entry => [entry.id, entry]));
  let selected = manifest.cases;
  if (requestedCaseIds.length) {
    selected = requestedCaseIds.map(id => {
      const found = manifest.cases.find(entry => entry.id === id);
      if (!found) throw new Error(`measure-unknown-case:${id}`);
      return found;
    });
  } else if (limit > 0) {
    selected = selected.slice(0, limit);
  }

  const source = captureSourceIdentity({ repoRoot: REPO_ROOT });
  if (!source.head) throw new Error(`measure-source-identity-unavailable:${source.reason ?? 'unknown'}`);
  const config = { label, functionTimeoutMs, structure, structureThresholdMs, productTimeoutMs };
  const configHash = configDigest(config);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(receiptRoot, { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'cases'), { recursive: true });

  const runPath = path.join(outputDir, 'run.json');
  const existingRun = readJson(runPath);
  if (existingRun && (existingRun.headSha !== source.head || existingRun.configHash !== configHash)) {
    throw new Error('measurement-identity-mismatch: refuse to mix runs with a different head or config');
  }
  const run = {
    schema: RUN_SCHEMA, label, headSha: source.head, sourceIdentity: source.identity,
    configHash, config, manifest: { path: path.relative(REPO_ROOT, manifestFile) },
    denominator: selected.length, createdAt: existingRun?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(runPath, run);
  log(`run store: ${outputDir}`);
  log(`head: ${source.head} config: ${configHash.slice(0, 12)} cases: ${selected.length} workers: ${workers}`);

  const started = performance.now();
  const results = new Array(selected.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, selected.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= selected.length) return;
      const manifestCase = selected[index];
      const input = byId.get(manifestCase.id);
      if (!input || input.state !== 'READY') {
        results[index] = { id: manifestCase.id, state: 'NOT_RUN', reason: `input-not-ready:${input?.state ?? 'MISSING'}` };
        log(`${manifestCase.id}: NOT_RUN (${results[index].reason})`);
        continue;
      }
      const caseRecordPath = path.join(outputDir, 'cases', caseFileName(manifestCase.id));
      const existing = readJson(caseRecordPath);
      if (existing?.schema === CASE_SCHEMA && existing.headSha === source.head && existing.configHash === configHash
        && existing.state === 'MEASURED') {
        results[index] = summarizeCase(existing);
        log(`${manifestCase.id}: resume-skip (${existing.functionCount} functions)`);
        continue;
      }
      const receiptDir = path.join(receiptRoot, Buffer.from(manifestCase.id).toString('hex'));
      const outcome = await Promise.race([
        spawnCaseFn({
          binary: input.path, caseId: manifestCase.id, outDir: outputDir, receiptDir,
          sourceIdentity: source.identity, configHash, headSha: source.head,
          functionTimeoutMs, structure, structureThresholdMs,
        }),
        new Promise(resolve => setTimeout(() => resolve({ code: null, signal: 'product-timeout', error: null, stderr: '' }), productTimeoutMs)),
      ]);
      const record = readJson(caseRecordPath);
      if (record?.schema === CASE_SCHEMA && record.headSha === source.head && record.configHash === configHash) {
        results[index] = summarizeCase(record);
        log(`${manifestCase.id}: ${record.state} (${record.functionCount} functions, ${(record.elapsedMs / 1000).toFixed(1)} s)`);
      } else {
        results[index] = {
          id: manifestCase.id, state: 'ERROR',
          reason: `case-worker-failed:${outcome.error?.code ?? outcome.signal ?? outcome.code ?? 'no-record'}`,
          stderr: outcome.stderr || null,
        };
        log(`${manifestCase.id}: ERROR (${results[index].reason})`);
      }
    }
  }));

  const states = {};
  for (const row of results) states[row.state] = (states[row.state] ?? 0) + 1;
  const summary = {
    schema: SUMMARY_SCHEMA, label, headSha: source.head, sourceIdentity: source.identity, configHash, config,
    denominator: selected.length, complete: results.every(row => row.state !== 'NOT_RUN' && row.state !== 'ERROR'),
    states, wallMs: performance.now() - started, results,
  };
  atomicWriteJson(path.join(outputDir, 'summary.json'), summary);
  log(`summary -> ${path.join(outputDir, 'summary.json')} (${JSON.stringify(states)})`);
  return { summary, outputDir, exitCode: summary.complete ? 0 : 2 };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const { exitCode } = await measureCurrentMain();
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
