import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  resolveBoundedNodeConcurrency,
  scheduleNodeTestFiles,
} from './bounded-node-suite.mjs';
import { phase3SchedulingPriority } from './semantic-corpus-manifest.mjs';

const FAILURE_TAIL_CHARS = 3500;

function appendTail(current, chunk) {
  const next = current + String(chunk);
  return next.length <= FAILURE_TAIL_CHARS ? next : next.slice(-FAILURE_TAIL_CHARS);
}

function runOne({ suite, index, file, root, env, timeoutMs, verbose }) {
  const display = `node ${file}`;
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(process.execPath, [path.join(root, file)], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref?.();

    const consume = (stream, isError) => {
      stream?.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (isError) stderrTail = appendTail(stderrTail, text);
        else stdoutTail = appendTail(stdoutTail, text);
        if (verbose) (isError ? process.stderr : process.stdout).write(text);
      });
    };
    consume(child.stdout, false);
    consume(child.stderr, true);

    const finish = (status, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const passed = !error && status === 0 && !timedOut;
      const combined = `${stdoutTail}\n${stderrTail}`.trim();
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (!verbose) {
        const state = passed ? 'PASS' : 'FAIL';
        process.stdout.write(`[phase3-${suite} ${index + 1}] ${state} ${display} (${(durationMs / 1000).toFixed(1)}s)\n`);
        if (!passed && combined) process.stderr.write(`${combined}\n`);
      }
      resolve({
        command: display,
        status,
        signal: signal ?? null,
        timedOut,
        passed,
        durationMs,
        ...(passed ? {} : { failureTail: combined.slice(-FAILURE_TAIL_CHARS), error: error ? String(error.message || error) : null }),
      });
    };

    child.once('error', (error) => finish(null, null, error));
    child.once('close', (status, signal) => finish(status, signal));
  });
}

/**
 * Run the locked Phase 3 unchanged-assertion corpus with bounded process
 * parallelism. Every command executes exactly once and result order remains the
 * canonical manifest order, so the v1/v2 differential denominator is unchanged.
 * Launch order is longest-first by non-authoritative hint to reduce pool tail.
 */
export async function runPhase3Corpus({
  suite,
  files,
  root,
  env = process.env,
  timeoutMs = 600_000,
  envName = 'HEX_PHASE3_CORPUS_CONCURRENCY',
  availableParallelism,
  priorityForFile = phase3SchedulingPriority,
} = {}) {
  if (!suite || !Array.isArray(files) || !files.length || !root) {
    throw new TypeError('phase3 corpus runner requires suite, files and root');
  }
  const outputMode = String(env.HEX_TEST_OUTPUT ?? '').trim().toLowerCase();
  const verbose = outputMode === 'verbose' || outputMode === 'full';
  const concurrency = verbose ? 1 : Math.min(files.length, resolveBoundedNodeConcurrency({
    env,
    envName,
    availableParallelism,
    maxDefault: 4,
    reserveCores: 0,
  }));
  const results = new Array(files.length);
  const workItems = scheduleNodeTestFiles(files, verbose ? null : priorityForFile);
  let nextWorkIndex = 0;

  async function worker() {
    while (true) {
      const item = workItems[nextWorkIndex++];
      if (!item) return;
      results[item.index] = await runOne({ suite, index: item.index, file: item.file, root, env, timeoutMs, verbose });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return Object.freeze({ results: Object.freeze(results), concurrency });
}
