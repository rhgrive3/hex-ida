#!/usr/bin/env node

// Parallel runner for the canonical `npm run check` step list.
//
// Contract:
// - Runs EVERY step from package.json `scripts.check`, always. No step is
//   skipped, filtered, or weakened. A failure in one step never stops the
//   others; the final exit code fails closed if ANY step failed.
// - Wall-clock only change. Each step runs exactly the same command with the
//   same quiet-output wrapper as the serial gate.
// - `benchmark:baseline` is CPU-time-sensitive, so it runs alone after the
//   pool drains (exclusive tail), in canonical position.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQuietCommand } from './run-quiet-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUSIVE_TAIL_PATTERN = /^npm run benchmark:baseline$/;

export function parseCheckSteps(checkScript) {
  return String(checkScript)
    .split('&&')
    .map((step) => step.trim())
    .filter(Boolean);
}

export function stepLabel(command) {
  const match = /^npm (?:run -s |run )?(\S+)$/.exec(command);
  if (match) return `check:${match[1]}`;
  if (command === 'npm test') return 'check:test';
  return `check:${command.replace(/\s+/g, '-')}`;
}

function splitCommand(command) {
  const [name, ...args] = command.split(/\s+/);
  return { command: name, args };
}

function poolSize(stepCount) {
  const override = Number(process.env.HEX_CHECK_PARALLEL);
  const requested = Number.isSafeInteger(override) && override >= 1 ? override : os.availableParallelism();
  return Math.max(1, Math.min(requested, stepCount));
}

async function runPool(jobs, concurrency, onSettled) {
  const results = new Array(jobs.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      results[index] = await runQuietCommand({ ...job, cwd: root });
      onSettled?.(index, results[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  return results;
}

export async function runCheckParallel({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const steps = parseCheckSteps(pkg.scripts.check ?? '');
  if (steps.length === 0) throw new Error('run-check-parallel: no steps found in scripts.check');

  const jobs = steps.map((command) => ({ label: stepLabel(command), ...splitCommand(command) }));
  const tailIndexes = [];
  const poolJobs = [];
  const poolJobIndex = [];
  jobs.forEach((job, index) => {
    if (EXCLUSIVE_TAIL_PATTERN.test(commandFor(job))) tailIndexes.push(index);
    else { poolJobs.push(job); poolJobIndex.push(index); }
  });

  function commandFor(job) {
    return [job.command, ...job.args].join(' ');
  }

  const results = new Array(jobs.length);
  const started = process.hrtime.bigint();
  stdout.write(`check:parallel: ${jobs.length} steps, pool=${poolSize(poolJobs.length)}, exclusive tail=${tailIndexes.length}\n`);

  if (poolJobs.length > 0) {
    const settled = await runPool(poolJobs, poolSize(poolJobs.length), (poolIndex, result) => {
      const job = poolJobs[poolIndex];
      const line = result.ok
        ? `${job.label}: PASS (${(result.durationMs / 1000).toFixed(1)}s)\n`
        : `${job.label}: FAIL (${(result.durationMs / 1000).toFixed(1)}s)\n`;
      (result.ok ? stdout : stderr).write(line);
    });
    poolJobIndex.forEach((jobIndex, poolIndex) => { results[jobIndex] = settled[poolIndex]; });
  }

  for (const jobIndex of tailIndexes) {
    const job = jobs[jobIndex];
    stdout.write(`check:parallel: exclusive tail ${job.label}\n`);
    results[jobIndex] = await runQuietCommand({ ...job, cwd: root });
    const line = results[jobIndex].ok
      ? `${job.label}: PASS (${(results[jobIndex].durationMs / 1000).toFixed(1)}s)\n`
      : `${job.label}: FAIL (${(results[jobIndex].durationMs / 1000).toFixed(1)}s)\n`;
    (results[jobIndex].ok ? stdout : stderr).write(line);
  }

  const wallSeconds = (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1);
  const failures = [];
  stderr.write('\n--- check:parallel summary (canonical order) ---\n');
  jobs.forEach((job, index) => {
    const result = results[index];
    const ok = result?.ok === true;
    if (!ok) failures.push({ job, result });
    stderr.write(`${ok ? 'PASS' : 'FAIL'}  ${commandFor(job)}${result ? ` (${(result.durationMs / 1000).toFixed(1)}s)` : ' (missing result)'}\n`);
  });
  stderr.write(`check:parallel: ${jobs.length - failures.length}/${jobs.length} passed, wall ${wallSeconds}s\n`);
  if (failures.length > 0) {
    for (const { job, result } of failures) {
      if (result?.logPath) stderr.write(`Full log for ${job.label}: ${result.logPath}\n`);
    }
    stderr.write('Rerun a failed step with HEX_TEST_OUTPUT=verbose for live full output.\n');
  }
  return { results, failures, wallSeconds };
}

async function main() {
  const { failures } = await runCheckParallel();
  if (failures.length > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
