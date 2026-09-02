import os from 'node:os';
import { spawn } from 'node:child_process';

export function resolveCompilerTruthConcurrency({ env = process.env, availableParallelism = os.availableParallelism() } = {}) {
  // Hosted exact-head proof keeps the historical in-process serial path. Local
  // developer runs may overlap the three independent compiler-truth families.
  if (env?.GITHUB_ACTIONS) return 1;
  const requested = Number(env?.HEX_COMPILER_TRUTH_CONCURRENCY);
  if (Number.isSafeInteger(requested) && requested >= 1) return Math.min(3, requested);
  const available = Number.isSafeInteger(availableParallelism) && availableParallelism >= 1 ? availableParallelism : 1;
  return Math.max(1, Math.min(3, available - 1));
}

function runOne(file, { cwd, env }) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let settled = false;
    let spawnError = null;
    const child = spawn(process.execPath, [file], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve(Object.freeze({
        file,
        code: spawnError ? null : code,
        signal: signal ?? null,
        error: spawnError,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }));
    });
  });
}

/**
 * Run independent compiler-truth proof families on isolated local processes.
 * Child output is replayed in canonical component order after all processes
 * settle, so launch concurrency cannot reorder machine-readable proof markers.
 */
export async function runCompilerTruthComponents({
  files,
  cwd,
  env = process.env,
  concurrency = resolveCompilerTruthConcurrency({ env }),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new TypeError('compiler-truth components are required');
  if (!cwd) throw new TypeError('compiler-truth component cwd is required');
  const width = Math.max(1, Math.min(files.length, concurrency));
  const results = new Array(files.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      results[index] = await runOne(files[index], { cwd, env });
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()));

  const failures = [];
  results.forEach((result, index) => {
    if (result.stdout.length) stdout.write(result.stdout);
    if (result.stderr.length) stderr.write(result.stderr);
    if (result.error || result.code !== 0 || result.signal) failures.push({ index, result });
  });
  if (failures.length) {
    const summary = failures.map(({ result }) => {
      if (result.error) return `${result.file}:spawn=${result.error.code || result.error.message}`;
      return `${result.file}:${result.signal ? `signal=${result.signal}` : `exit=${result.code}`}`;
    }).join(', ');
    throw new Error(`compiler-truth: ${failures.length}/${files.length} component(s) failed: ${summary}`);
  }
  return Object.freeze({ passed:files.length, total:files.length, concurrency:width });
}
