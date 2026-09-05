import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  resolveBoundedNodeConcurrency,
  scheduleNodeTestFiles,
} from './bounded-node-suite.mjs';
import { phase3SchedulingPriority } from './semantic-corpus-manifest.mjs';

const FAILURE_TAIL_CHARS = 3500;
const DEFAULT_KILL_GRACE_MS = 1_000;
const inProcessRunCache = new Map();

function appendTail(current, chunk) {
  const next = current + String(chunk);
  return next.length <= FAILURE_TAIL_CHARS ? next : next.slice(-FAILURE_TAIL_CHARS);
}

function signalProcessTree(child, signal) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    if (signal === 'SIGKILL') {
      // taskkill /T is the Windows process-tree equivalent of signalling the
      // detached POSIX process group. Keep this synchronous and bounded to one
      // invocation; runOne settles independently and never waits for cleanup.
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: DEFAULT_KILL_GRACE_MS,
        });
      } catch { /* best-effort cleanup after the proof has already failed */ }
      return;
    }
    try { child.kill(signal); } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function runOne({ suite, index, file, root, env, timeoutMs, killGraceMs, verbose }) {
  const display = `node ${file}`;
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const child = spawn(process.execPath, [path.join(root, file)], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A dedicated process group lets the timeout terminate descendants in a
      // single bounded operation rather than sleeping once per child.
      detached: process.platform !== 'win32',
    });

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
      if (killTimer) clearTimeout(killTimer);
      const passed = !error && status === 0 && !timedOut;
      const combined = `${stdoutTail}\n${stderrTail}`.trim();
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (!verbose) {
        const state = passed ? 'PASS' : 'FAIL';
        process.stdout.write(`[phase3-${suite} ${index + 1}] ${state} ${display} (${(durationMs / 1000).toFixed(1)}s)\n`);
        if (!passed && combined) process.stderr.write(`${combined}\n`);
      }
      resolve(Object.freeze({
        command: display,
        status,
        signal: signal ?? null,
        timedOut,
        passed,
        durationMs,
        ...(passed ? {} : { failureTail: combined.slice(-FAILURE_TAIL_CHARS), error: error ? String(error.message || error) : null }),
      }));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL');
        // Do not make proof completion depend on a hostile child's `close`
        // event. We have issued the strongest platform cleanup and settle the
        // failed leaf at one global deadline. Destroying pipes/unref prevents a
        // stubborn descendant from retaining the runner event loop.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
        finish(null, 'SIGKILL', new Error(`phase3 corpus command timed out after ${timeoutMs}ms`));
      }, killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (error) => finish(null, null, error));
    child.once('close', (status, signal) => finish(status, signal));
  });
}

function digestEnvironment(env) {
  const hash = createHash('sha256');
  for (const [key, value] of Object.entries(env || {}).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(key); hash.update('\0'); hash.update(String(value)); hash.update('\0');
  }
  return hash.digest('hex');
}

export function phase3CorpusReuseKey({ suite, files, root, env, timeoutMs, killGraceMs, envName, concurrency } = {}) {
  const token = String(env?.HEX_PHASE3_INPROCESS_REUSE_TOKEN ?? '').trim();
  if (!token) return null;
  const hash = createHash('sha256');
  hash.update(token); hash.update('\0');
  hash.update(String(suite)); hash.update('\0');
  hash.update(path.resolve(root)); hash.update('\0');
  hash.update(String(timeoutMs)); hash.update('\0');
  hash.update(String(killGraceMs)); hash.update('\0');
  hash.update(String(envName)); hash.update('\0');
  hash.update(String(concurrency)); hash.update('\0');
  hash.update(digestEnvironment(env)); hash.update('\0');
  for (const file of files) { hash.update(String(file)); hash.update('\0'); }
  return hash.digest('hex');
}

async function executePhase3Corpus({ suite, files, root, env, timeoutMs, killGraceMs, concurrency, priorityForFile }) {
  const outputMode = String(env.HEX_TEST_OUTPUT ?? '').trim().toLowerCase();
  const verbose = outputMode === 'verbose' || outputMode === 'full';
  // The 25-leaf corpus is already an outer process pool. compiler-truth is one
  // leaf, so its standalone component fanout must be suppressed here to avoid
  // nested N x 3 oversubscription. This changes scheduling only, not its proof.
  const childEnv = concurrency > 1
    ? { ...env, HEX_COMPILER_TRUTH_CONCURRENCY: '1' }
    : env;
  const results = new Array(files.length);
  const workItems = scheduleNodeTestFiles(files, verbose ? null : priorityForFile);
  let nextWorkIndex = 0;

  async function worker() {
    while (true) {
      const item = workItems[nextWorkIndex++];
      if (!item) return;
      results[item.index] = await runOne({
        suite,
        index: item.index,
        file: item.file,
        root,
        env: childEnv,
        timeoutMs,
        killGraceMs,
        verbose,
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return Object.freeze({ results: Object.freeze(results), concurrency });
}

/**
 * Run the locked Phase 3 unchanged-assertion corpus with bounded process
 * parallelism. Every command executes exactly once and result order remains the
 * canonical manifest order, so the v1/v2 differential denominator is unchanged.
 * Launch order is longest-first by non-authoritative hint to reduce pool tail.
 *
 * An explicit process-scoped reuse token enables single-flight/replay of an
 * identical invocation only inside this Node process. The Semantic-v2 evidence
 * chain uses it to prestart the independent legacy corpus beside the v2 corpus.
 * Normal callers have no token and always execute fresh proof work.
 */
export async function runPhase3Corpus({
  suite,
  files,
  root,
  env = process.env,
  timeoutMs = 600_000,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  envName = 'HEX_PHASE3_CORPUS_CONCURRENCY',
  availableParallelism,
  priorityForFile = phase3SchedulingPriority,
} = {}) {
  if (!suite || !Array.isArray(files) || !files.length || !root) {
    throw new TypeError('phase3 corpus runner requires suite, files and root');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('phase3 corpus runner timeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs <= 0) {
    throw new TypeError('phase3 corpus runner killGraceMs must be a positive safe integer');
  }
  const outputMode = String(env.HEX_TEST_OUTPUT ?? '').trim().toLowerCase();
  const verbose = outputMode === 'verbose' || outputMode === 'full';
  const concurrency = verbose ? 1 : Math.min(files.length, resolveBoundedNodeConcurrency({
    env,
    envName,
    availableParallelism,
    // Standalone/current-corpus execution is an outer process pool with isolated
    // leaves, so use up to six local CPUs. Dual-mode execution sets an explicit
    // 2-4 worker override per corpus and therefore remains bounded separately.
    maxDefault: 6,
    reserveCores: 0,
  }));

  const reuseKey = phase3CorpusReuseKey({ suite, files, root, env, timeoutMs, killGraceMs, envName, concurrency });
  if (!reuseKey) {
    return executePhase3Corpus({ suite, files, root, env, timeoutMs, killGraceMs, concurrency, priorityForFile });
  }

  let cached = inProcessRunCache.get(reuseKey);
  if (!cached) {
    cached = executePhase3Corpus({ suite, files, root, env, timeoutMs, killGraceMs, concurrency, priorityForFile });
    inProcessRunCache.set(reuseKey, cached);
  }
  return cached;
}
