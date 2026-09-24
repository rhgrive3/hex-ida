#!/usr/bin/env node
/*
 * Current-main weakness measurement runner (parent process).
 *
 * Runs the production analysis path over a selected set of codefuse-arm64
 * manifest cases with one child process per case, a real hard watchdog at the
 * process boundary, and per-case/per-function durable receipts.
 *
 * Watchdog semantics:
 *   - The child worker reports progress ({ type: 'function-start', address, startedAt }
 *     and { type: 'function-end' }).
 *   - The parent enforces a hard watchdog: if a function exceeds
 *     functionTimeoutMs + functionTimeoutGraceMs (default 2000 ms), the parent
 *     SIGKILLs the child worker.
 *   - The timed-out function is recorded as TIMEOUT with hard: true and elapsedMs.
 *   - The parent respawns the child to continue remaining functions (skipping completed
 *     and timed-out functions).
 *   - The worker also uses an internal AbortController as a soft stage; any function
 *     whose measured elapsedMs > functionTimeoutMs is recorded as TIMEOUT (never PASS).
 *
 * Usage:
 *   node reports/investigations/current-main-weakness-20260923/harness/measure-functions.mjs \
 *     --output reports/investigations/current-main-weakness-20260923/measurements/run-a \
 *     --limit 16 --workers 8 --function-timeout-ms 10000 --function-timeout-grace-ms 2000 --structure slow
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, verifyInputs } from '../../../../tools/validation/public-benchmark/manifest.mjs';
import {
  CASE_SCHEMA,
  FUNCTION_SCHEMA,
  HARNESS_REPO_ROOT,
  RUN_SCHEMA,
  SUMMARY_SCHEMA,
  atomicWriteJson,
  captureSourceIdentity,
  caseFileName,
  computeHarnessSourceHash,
  configDigest,
  optionValue,
  optionValues,
  readJson,
  receiptFileName,
  sha256,
} from './lib.mjs';

const WORKER_PATH = fileURLToPath(new URL('./case-worker.mjs', import.meta.url));
const DEFAULT_OUTPUT = 'reports/investigations/current-main-weakness-20260923/measurements/run';
const REPO_ROOT = HARNESS_REPO_ROOT;

export function runCaseWithWatchdog({
  binary,
  caseId,
  outDir,
  receiptDir,
  sourceIdentity,
  configHash,
  headSha,
  functionTimeoutMs,
  functionTimeoutGraceMs = 2000,
  structure,
  structureThresholdMs,
  workerPath = WORKER_PATH,
  spawnFn = spawn,
}) {
  return new Promise(resolve => {
    fs.mkdirSync(receiptDir, { recursive: true });
    const inflightFile = path.join(receiptDir, 'inflight.json');
    let restarts = 0;
    const maxRestarts = 10000;
    let finalCode = null;
    let finalSignal = null;
    let finalError = null;
    let finalStderr = '';

    function hardTimeoutReceipt(timedOutFn, elapsedMs, name = null) {
      return {
        schema: FUNCTION_SCHEMA,
        caseId,
        address: timedOutFn.address,
        index: timedOutFn.index ?? null,
        name,
        end: null,
        sizeBytes: null,
        state: 'TIMEOUT',
        hard: true,
        completeness: null,
        reason: 'function-watchdog-timeout-hard',
        projection: null,
        unknownInstructions: null,
        coverageMode: null,
        structured: null,
        warnings: null,
        evidence: null,
        semantic: null,
        signature: null,
        elapsedMs,
        structure: null,
        pseudocodeChars: null,
        nonEmptyLines: null,
        gotos: null,
        pseudocode: null,
        sourceIdentity,
        configHash,
        headSha,
      };
    }

    function step() {
      let child;
      let activeFunction = null;
      let watchdogTimer = null;
      let stderrAccum = '';

      function clearWatchdog() {
        if (watchdogTimer) {
          clearTimeout(watchdogTimer);
          watchdogTimer = null;
        }
      }

      function resetWatchdog(fnInfo) {
        clearWatchdog();
        activeFunction = fnInfo;
        const totalTimeout = functionTimeoutMs + functionTimeoutGraceMs;
        watchdogTimer = setTimeout(() => {
          if (!activeFunction) return;
          const timedOutFn = activeFunction;
          const elapsedMs = performance.now() - timedOutFn.startedTime;
          // Record receipt as TIMEOUT with hard: true
          const receipt = hardTimeoutReceipt(timedOutFn, elapsedMs, readJson(inflightFile)?.name ?? null);
          atomicWriteJson(path.join(receiptDir, receiptFileName(timedOutFn.address)), receipt);
          fs.rmSync(inflightFile, { force: true });

          try {
            child.kill('SIGKILL');
          } catch {}
        }, totalTimeout);
      }

      try {
        child = spawnFn(process.execPath, [
          workerPath,
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
          '--inflight', inflightFile,
        ], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      } catch (err) {
        return resolve({ code: null, signal: null, error: err, stderr: '' });
      }

      child.stderr?.on('data', chunk => {
        stderrAccum = `${stderrAccum}${chunk}`.slice(-4000);
        finalStderr = `${finalStderr}${chunk}`.slice(-4000);
      });

      function handleProgress(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'function-start') {
          resetWatchdog({
            address: String(msg.address),
            index: msg.index,
            startedTime: performance.now(),
          });
        } else if (msg.type === 'function-end') {
          clearWatchdog();
          activeFunction = null;
        }
      }

      child.on('message', handleProgress);

      if (child.stdout) {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on('line', line => {
          if (!line.startsWith('{')) return;
          try {
            const parsed = JSON.parse(line);
            handleProgress(parsed);
          } catch {}
        });
      }

      child.once('error', error => {
        clearWatchdog();
        finalError = error;
      });

      child.once('close', (code, signal) => {
        clearWatchdog();
        finalCode = code;
        finalSignal = signal;

        // Check if killed by our watchdog or child crashed/signal while in-flight
        const inflight = readJson(inflightFile);
        const wasKilled = signal === 'SIGKILL' || (code === null && signal != null) || activeFunction != null;
        if (wasKilled && (activeFunction || inflight?.address)) {
          const address = activeFunction?.address ?? inflight?.address;
          const index = activeFunction?.index ?? inflight?.index ?? null;
          const startedTime = activeFunction?.startedTime ?? performance.now() - (functionTimeoutMs + functionTimeoutGraceMs);
          const elapsedMs = performance.now() - startedTime;
          const receiptPath = path.join(receiptDir, receiptFileName(address));
          const existingReceipt = readJson(receiptPath);
          if (!existingReceipt) {
            const receipt = hardTimeoutReceipt({ address:String(address), index }, elapsedMs, inflight?.name ?? null);
            atomicWriteJson(receiptPath, receipt);
          }
          fs.rmSync(inflightFile, { force: true });
          restarts++;
          if (restarts < maxRestarts) {
            return step();
          }
        }

        // If case record was written and complete, resolve
        const caseRecordPath = path.join(outDir, 'cases', caseFileName(caseId));
        const record = readJson(caseRecordPath);
        if (record?.schema === CASE_SCHEMA && record.state === 'MEASURED') {
          return resolve({ code, signal, error: null, stderr: finalStderr });
        }

        // If there are still unprocessed functions or worker exited prematurely after watchdog kills
        if (restarts > 0) {
          // Check if we can resume worker or if worker finished
          if (record?.schema === CASE_SCHEMA) {
            return resolve({ code, signal, error: null, stderr: finalStderr });
          }
        }

        resolve({ code, signal, error: finalError, stderr: finalStderr });
      });
    }

    step();
  });
}

function spawnCase(opts) {
  return runCaseWithWatchdog(opts);
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
  const functionTimeoutGraceMs = Number(optionValue(args, '--function-timeout-grace-ms', '2000'));
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
  const harnessHash = computeHarnessSourceHash(path.resolve(path.dirname(fileURLToPath(import.meta.url))));
  const selectedCaseIds = selected.map(c => c.id).sort();
  const caseSelectionHash = sha256(selectedCaseIds.join('\n'));
  const manifestBytes = fs.readFileSync(manifestFile);
  const benchmarkManifestHash = sha256(manifestBytes);

  const config = {
    label, functionTimeoutMs, functionTimeoutGraceMs, structure, structureThresholdMs, productTimeoutMs,
    harnessHash, caseSelectionHash, benchmarkManifestHash,
  };
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
          functionTimeoutMs, functionTimeoutGraceMs, structure, structureThresholdMs,
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
