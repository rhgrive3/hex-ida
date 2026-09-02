import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBoundedNodeConcurrency } from '../support/bounded-node-suite.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shouldRun = !process.env.GITHUB_ACTIONS || process.env.GITHUB_WORKFLOW === 'Semantic IR v2 contracts';
const FAILURE_TAIL_CHARS = 5000;

function appendTail(current, text) {
  const next = current + text;
  return next.length <= FAILURE_TAIL_CHARS ? next : next.slice(-FAILURE_TAIL_CHARS);
}

function runScript(script, env, verbose) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    let tail = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(npm, ['run', script], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 600_000);
    timer.unref?.();
    const consume = (stream, target) => stream?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      tail = appendTail(tail, text);
      if (verbose) target.write(text);
    });
    consume(child.stdout, process.stdout);
    consume(child.stderr, process.stderr);

    const finish = (status, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const passed = !error && status === 0 && !timedOut;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (!verbose) {
        process.stdout.write(`[phase3-required] ${script}: ${passed ? 'PASS' : 'FAIL'} (${(durationMs / 1000).toFixed(1)}s)\n`);
        if (!passed && tail.trim()) process.stderr.write(`${tail.trim()}\n`);
      }
      resolve({ script, status, signal: signal ?? null, timedOut, passed, error: error ? String(error.message || error) : null, durationMs });
    };
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (status, signal) => finish(status, signal));
  });
}

async function runPool(scripts, env) {
  const mode = String(env.HEX_TEST_OUTPUT ?? '').trim().toLowerCase();
  const verbose = mode === 'verbose' || mode === 'full';
  const concurrency = verbose ? 1 : Math.min(scripts.length, resolveBoundedNodeConcurrency({
    env,
    envName: 'HEX_PHASE3_REQUIRED_CONCURRENCY',
    maxDefault: 2,
    reserveCores: 0,
  }));
  const results = new Array(scripts.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= scripts.length) return;
      results[index] = await runScript(scripts[index], env, verbose);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

if (!shouldRun) {
  console.log(`Phase 3 mandatory existing regression commands: delegated to Semantic IR v2 contracts workflow (current=${process.env.GITHUB_WORKFLOW ?? 'unknown'})`);
} else {
  // These suites do not recursively contain the other mandatory heavy proofs and
  // can safely overlap in a small bounded pool.
  const lightScripts = [
    'core:test',
    'migration:test',
    'semantic:test',
    'platform:test',
    'runtime:test',
    'ui:test',
  ];
  // Preserve every historical command, but never overlap the duplicate-heavy
  // proofs: invariants:test itself executes MachineEffects + compiler-truth,
  // while decompiler:test itself executes compiler-truth. Running these commands
  // against one another only duplicates CPU work and can make local wall time and
  // timing-sensitive diagnostics worse.
  const heavyScripts = [
    'effects:test',
    'invariants:test',
    'decompiler:test',
    'compiler-truth',
  ];
  const childEnv = {
    ...process.env,
    NODE_OPTIONS: '',
    HEX_SEMANTIC_TEST_CONCURRENCY: process.env.HEX_SEMANTIC_TEST_CONCURRENCY ?? '2',
    HEX_DECOMPILER_TEST_CONCURRENCY: process.env.HEX_DECOMPILER_TEST_CONCURRENCY ?? '2',
  };
  const results = await runPool(lightScripts, childEnv);
  const verbose = ['verbose','full'].includes(String(childEnv.HEX_TEST_OUTPUT ?? '').toLowerCase());
  for (const script of heavyScripts) results.push(await runScript(script, childEnv, verbose));
  // Timing-sensitive baseline runs only after every CPU-heavy proof fully drains.
  results.push(await runScript('benchmark:baseline', childEnv, verbose));
  globalThis.__HEX_PHASE3_REQUIRED_REGRESSION_GATES__ = Object.freeze(results);
  const failures = results.filter((result) => !result.passed);
  assert.deepEqual(failures, [], `mandatory existing regression commands failed: ${JSON.stringify(failures)}`);
  console.log('Phase 3 mandatory existing regression commands: PASS');
}
