#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, verifyInputs } from './manifest.mjs';
import { aggregateComparisons, compareCase } from './compare.mjs';
import { classifySubjectResult, SUBJECT_RESULT_STATES, SUBJECT_RESULT_SCHEMA } from './outcome.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CASE_RUNNER = path.join(REPOSITORY_ROOT, 'tools/validation/public-benchmark/run-case.mjs');
const HARD_STATES = new Set([
  'MISSING',
  'MISSING_REFERENCE',
  'HASH_MISMATCH',
  'REFERENCE_HASH_MISMATCH',
  'UNSUPPORTED',
  'ERROR',
  'CRASH',
  'TIMEOUT',
]);

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function outputPathspec(repoRoot, outputDir) {
  const relative = path.relative(repoRoot, outputDir).split(path.sep).join('/');
  if (!relative || relative === '.' || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return `:(exclude)${relative}/**`;
}

export function captureRunProvenance({ repoRoot = REPOSITORY_ROOT, manifestFile, outputDir, gitExec = execFileSync } = {}) {
  const root = path.resolve(repoRoot);
  const manifestBytes = fs.readFileSync(manifestFile);
  const gitOptions = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const gitSha = gitExec('git', ['rev-parse', 'HEAD'], gitOptions).trim();
  if (!/^[0-9a-f]{40,64}$/.test(gitSha)) throw new Error('public-benchmark-source-sha-invalid');

  const statusArgs = ['status', '--porcelain=v1', '--untracked-files=all', '--', '.'];
  const excludedOutput = outputPathspec(root, path.resolve(outputDir));
  if (excludedOutput) statusArgs.push(excludedOutput);
  const status = gitExec('git', statusArgs, gitOptions).trim();
  const dirtyEntries = status ? status.split(/\r?\n/).filter(Boolean) : [];
  const manifestPath = path.relative(root, path.resolve(manifestFile)).split(path.sep).join('/');

  return {
    git: {
      sha: gitSha,
      dirty: dirtyEntries.length > 0,
      dirtyEntries,
    },
    manifest: {
      path: manifestPath.startsWith('../') || path.isAbsolute(manifestPath) ? path.resolve(manifestFile) : manifestPath,
      sha256: sha256(manifestBytes),
    },
  };
}

function readFreshResult(resultPath) {
  if (!fs.existsSync(resultPath)) {
    return { schema: SUBJECT_RESULT_SCHEMA, state: 'ERROR', reason: 'result-missing', functions: [] };
  }
  let result;
  try {
    result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch {
    return { schema: SUBJECT_RESULT_SCHEMA, state: 'ERROR', reason: 'result-invalid-json', functions: [] };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.schema !== SUBJECT_RESULT_SCHEMA
    || !SUBJECT_RESULT_STATES.has(result.state)
    || !Array.isArray(result.functions)) {
    return { schema: SUBJECT_RESULT_SCHEMA, state: 'ERROR', reason: 'result-invalid', functions: [] };
  }
  return classifySubjectResult(result);
}

function applyRunnerStatus(result, run) {
  if (run.error?.code === 'ETIMEDOUT') {
    return { schema: SUBJECT_RESULT_SCHEMA, state: 'TIMEOUT', reason: 'outer-runner-timeout', functions: [], runnerErrorCode: run.error.code };
  }
  if (run.error) {
    return { schema: SUBJECT_RESULT_SCHEMA, state: 'ERROR', reason: `outer-runner-error:${run.error.code || run.error.name || 'unknown'}`, functions: [] };
  }
  if (run.signal) {
    return { schema: SUBJECT_RESULT_SCHEMA, state: 'CRASH', reason: `case-runner-signal:${run.signal}`, functions: [], runnerSignal: run.signal };
  }
  if (run.status !== 0 && !HARD_STATES.has(result.state)) {
    return {
      ...result,
      state: 'ERROR',
      reason: `case-runner-nonzero-exit:${String(run.status)}`,
      runnerExitCode: run.status ?? null,
      subjectReportedState: result.state ?? null,
    };
  }
  if (run.status !== 0) return { ...result, runnerExitCode: run.status ?? null };
  return result;
}

export function runBenchmark({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  repoRoot = REPOSITORY_ROOT,
  spawnRunner = spawnSync,
  log = console.log,
} = {}) {
  const suite = optionValue(args, '--suite', 'codefuse-arm64');
  const manifestFile = path.resolve(cwd, optionValue(args, '--manifest', `benchmarks/public/${suite}/manifest.json`));
  const outputDir = path.resolve(cwd, optionValue(args, '--output', `reports/public-benchmark/${suite}`));
  const timeout = Number(optionValue(args, '--timeout-ms', '120000'));
  const limit = Number(optionValue(args, '--limit', '0'));
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 900000) throw new Error('benchmark-timeout-invalid');
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('benchmark-limit-invalid');

  const manifest = loadManifest(manifestFile);
  const provenance = captureRunProvenance({ repoRoot, manifestFile, outputDir });
  const suiteRoot = path.dirname(manifestFile);
  const inputs = verifyInputs(manifest, suiteRoot);
  const selected = limit > 0 ? inputs.slice(0, limit) : inputs;
  fs.mkdirSync(outputDir, { recursive: true });

  const states = {};
  const functionStates = {};
  const comparisons = [];
  const results = [];
  for (const entry of selected) {
    if (entry.state !== 'READY') {
      states[entry.state] = (states[entry.state] || 0) + 1;
      results.push({ id: entry.id, state: entry.state });
      continue;
    }

    const resultPath = path.join(outputDir, `${Buffer.from(entry.id).toString('hex')}.json`);
    fs.rmSync(resultPath, { force: true });
    let runnerResult;
    try {
      runnerResult = spawnRunner(process.execPath, [CASE_RUNNER, entry.path, resultPath, String(timeout)], {
        encoding: 'utf8',
        timeout: timeout + 5000,
        cwd: repoRoot,
      });
    } catch (error) {
      runnerResult = { status: null, signal: null, error };
    }

    const subject = applyRunnerStatus(readFreshResult(resultPath), runnerResult);
    states[subject.state] = (states[subject.state] || 0) + 1;
    const caseFunctionStates = subject.functionStateCounts ?? {};
    for (const [state, count] of Object.entries(caseFunctionStates)) {
      functionStates[state] = (functionStates[state] || 0) + count;
    }
    results.push({
      id: entry.id,
      state: subject.state,
      reason: subject.reason ?? null,
      functionStates: caseFunctionStates,
      runnerExitCode: runnerResult.status ?? null,
      runnerSignal: runnerResult.signal ?? null,
    });
    comparisons.push(compareCase({ caseEntry: entry, hexResult: subject, suiteRoot }));
    log(`${entry.id}: ${subject.state} (${subject.functions?.length ?? 0} functions)`);
  }

  const summary = {
    schema: 'hex-public-benchmark-report/v1',
    suite: manifest.suite,
    total: selected.length,
    denominatorFrozen: manifest.denominatorFrozen === true,
    provenance,
    states,
    functionStates,
    reference: manifest.reference,
    comparison: {
      scope: 'published-artifact-quality-only',
      aggregate: aggregateComparisons(comparisons),
      cases: comparisons,
    },
    claims: {
      nativeCompetitorRun: false,
      scpaNativeCellsConsumed: 0,
      semantic: 'UNMEASURED',
      recompilability: 'UNMEASURED',
      competitorLatency: 'UNMEASURED',
    },
    results,
  };
  const summaryPath = path.join(outputDir, 'summary.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  log(`summary -> ${summaryPath}`);
  return { summary, summaryPath, exitCode: results.some(result => HARD_STATES.has(result.state)) ? 1 : 0 };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runBenchmark().exitCode;
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
