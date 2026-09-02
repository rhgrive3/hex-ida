import os from 'node:os';
import path from 'node:path';

import { runQuietCommand } from '../../scripts/run-quiet-command.mjs';

const MAX_OVERRIDE_CONCURRENCY = 16;

export function resolveBoundedNodeConcurrency({
  env = process.env,
  envName = 'HEX_TEST_FILE_CONCURRENCY',
  availableParallelism = os.availableParallelism(),
  maxDefault = 4,
  reserveCores = 1,
} = {}) {
  const override = Number(env?.[envName]);
  if (Number.isSafeInteger(override) && override >= 1) {
    return Math.min(MAX_OVERRIDE_CONCURRENCY, override);
  }
  const available = Number.isSafeInteger(availableParallelism) && availableParallelism >= 1
    ? availableParallelism
    : 1;
  const boundedDefault = Number.isSafeInteger(maxDefault) && maxDefault >= 1 ? maxDefault : 1;
  const reserved = Number.isSafeInteger(reserveCores) && reserveCores >= 0 ? reserveCores : 1;
  return Math.max(1, Math.min(boundedDefault, Math.max(1, available - reserved)));
}

/**
 * Build a stable work queue while retaining each file's canonical result slot.
 * A scheduling hint is deliberately non-authoritative: it may change launch
 * order only. Evidence/result order remains the caller's original file order.
 */
export function scheduleNodeTestFiles(files, priorityForFile = null) {
  if (!Array.isArray(files)) throw new TypeError('node test scheduler: files must be an array');
  const work = files.map((file, index) => {
    const rawPriority = typeof priorityForFile === 'function' ? priorityForFile(file, index) : 0;
    const priority = typeof rawPriority === 'number' && Number.isFinite(rawPriority) ? rawPriority : 0;
    return { file, index, priority };
  });
  if (typeof priorityForFile === 'function') {
    work.sort((left, right) => right.priority - left.priority || left.index - right.index);
  }
  return work;
}

/**
 * Run independent Node test entrypoints in isolated child processes with bounded
 * parallelism. Every file still executes exactly once. Failures are collected
 * fail-closed after the pool drains, and runQuietCommand keeps success output
 * compact while retaining a full log for any failed child.
 */
export async function runBoundedNodeSuite({
  label,
  files,
  cwd,
  env = process.env,
  envName = 'HEX_TEST_FILE_CONCURRENCY',
  maxDefault = 4,
  reserveCores = 1,
  stdout = process.stdout,
  stderr = process.stderr,
  runCommand = runQuietCommand,
  availableParallelism = os.availableParallelism(),
  priorityForFile = null,
} = {}) {
  if (!label) throw new TypeError('bounded node suite: label is required');
  if (!Array.isArray(files) || files.length === 0) throw new TypeError(`${label}: no test files supplied`);
  if (!cwd) throw new TypeError(`${label}: cwd is required`);

  const outputMode = String(env?.HEX_TEST_OUTPUT ?? '').trim().toLowerCase();
  const verbose = outputMode === 'verbose' || outputMode === 'full';
  const concurrency = verbose
    ? 1
    : Math.min(files.length, resolveBoundedNodeConcurrency({
      env,
      envName,
      availableParallelism,
      maxDefault,
      reserveCores,
    }));
  const results = new Array(files.length);
  const workItems = scheduleNodeTestFiles(files, verbose ? null : priorityForFile);
  let nextWorkIndex = 0;
  const started = process.hrtime.bigint();

  stdout.write(`${label}: ${files.length} files, concurrency=${concurrency}${verbose ? ' (verbose serial)' : ''}\n`);

  async function worker() {
    while (true) {
      const item = workItems[nextWorkIndex++];
      if (!item) return;
      const { file, index } = item;
      try {
        results[index] = await runCommand({
          label: `${label}:${path.basename(file)}`,
          command: process.execPath,
          args: [file],
          cwd,
          env,
          stdout,
          stderr,
        });
      } catch (error) {
        results[index] = Object.freeze({
          ok: false,
          status: null,
          signal: null,
          error,
          logPath: null,
          durationMs: null,
        });
        stderr.write(`${label}:${path.basename(file)}: FAIL (${error?.message || String(error)})\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const failures = [];
  results.forEach((result, index) => {
    if (result?.ok !== true) failures.push({ file: files[index], result });
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (failures.length > 0) {
    const names = failures.map(({ file }) => path.basename(file)).join(', ');
    throw new Error(`${label}: ${failures.length}/${files.length} test files failed (${names})`);
  }

  stdout.write(`${label}: PASS (${files.length}/${files.length} files, ${(durationMs / 1000).toFixed(1)}s wall)\n`);
  return Object.freeze({
    passed: files.length,
    failed: 0,
    total: files.length,
    concurrency,
    durationMs,
  });
}
