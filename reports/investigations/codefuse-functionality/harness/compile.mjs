// Raw recompilability lane (no LLM), mirroring the compile/link boundary of
// CodeFuse-DeBench Step 2 (`evaluator/syntactic/utils/compiler.py`).
//
// Rules enforced here:
//   * every external process has a finite timeout and is killed on expiry;
//   * diagnostics are reduced to a bounded, machine-readable summary - the full
//     compiler stderr is never returned or committed;
//   * a failed/timed-out/unsupported compile is a recorded state, never a drop.

import { spawn, spawnSync } from 'node:child_process';

export const MAX_TIMEOUT_MS = 900_000;
export const DEFAULT_COMPILE_TIMEOUT_MS = 120_000;
const STDERR_CAPTURE_BYTES = 256 * 1024;
const FIRST_ERROR_MESSAGE_LIMIT = 400;

export function validateTimeout(timeoutMs, fallback = DEFAULT_COMPILE_TIMEOUT_MS) {
  const value = timeoutMs == null ? fallback : Number(timeoutMs);
  if (!Number.isSafeInteger(value) || value < 1000 || value > MAX_TIMEOUT_MS) {
    throw new TypeError(`codefuse-timeout-out-of-range:${timeoutMs}`);
  }
  return value;
}

function parseErrorLocation(line) {
  // gcc/clang: "path:line:col: error: message" (col is optional).
  const match = /^(.*?):(\d+)(?::(\d+))?:\s*(?:fatal error|error):\s*(.*)$/.exec(line);
  if (!match) return null;
  return {
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : null,
    message: String(match[4]).slice(0, FIRST_ERROR_MESSAGE_LIMIT),
  };
}

// Compiler output quotes the source path exactly as it was passed on the command
// line. Rewriting the repository root away keeps committed evidence portable and
// stops a builder's filesystem layout from leaking into artifacts. Any absolute
// path is reduced to the path relative to `rootDir`.
export function stripHostRoot(line, rootDir) {
  const text = String(line ?? '');
  if (!rootDir) return text;
  const root = String(rootDir).replace(/\/+$/, '');
  if (!root) return text;
  return text.split(`${root}/`).join('');
}

// Bounded, machine-readable reduction of compiler stderr.
export function summarizeDiagnostics(stderr, { rootDir = null } = {}) {
  const text = String(stderr ?? '');
  const lines = text.split('\n');
  let errorCount = 0;
  let warningCount = 0;
  let firstError = null;
  let firstErrorRaw = null;
  for (const rawLine of lines) {
    const line = stripHostRoot(rawLine, rootDir);
    if (/:\s*(?:fatal error|error):/.test(line)) {
      errorCount += 1;
      if (!firstError) {
        firstError = parseErrorLocation(line) ?? { line: null, column: null, message: line.trim().slice(0, FIRST_ERROR_MESSAGE_LIMIT) };
        firstErrorRaw = line.trim().slice(0, FIRST_ERROR_MESSAGE_LIMIT);
      }
    } else if (/:\s*warning:/.test(line)) {
      warningCount += 1;
    }
  }
  return { errorCount, warningCount, firstError, firstErrorRaw, stderrBytes: Buffer.byteLength(text, 'utf8') };
}

export function runTool(command, args, {
  cwd = process.cwd(),
  timeoutMs = DEFAULT_COMPILE_TIMEOUT_MS,
  spawnImpl = spawn,
  env = process.env,
} = {}) {
  const timeout = validateTimeout(timeoutMs);
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: 'spawn_error', exitCode: null, signal: null, stderr: '', reason: String(error?.message || error), durationMs: 0 });
      return;
    }
    if (!child?.once || !child.stderr?.on) {
      resolve({ status: 'spawn_error', exitCode: null, signal: null, stderr: '', reason: 'invalid-child-process', durationMs: 0 });
      return;
    }
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...value,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeout);
    child.stderr.on('data', (chunk) => {
      const next = stderr + chunk.toString();
      stderr = next.length > STDERR_CAPTURE_BYTES ? next.slice(-STDERR_CAPTURE_BYTES) : next;
    });
    child.once('error', (error) => finish({ status: 'spawn_error', exitCode: null, signal: null, stderr, reason: String(error?.message || error) }));
    child.once('close', (code, signal) => {
      if (timedOut) finish({ status: 'timeout', exitCode: code, signal, stderr, reason: `timeout:${timeout}` });
      else finish({ status: code === 0 ? 'ok' : 'failed', exitCode: code, signal, stderr, reason: null });
    });
  });
}

export async function compileSource({
  file,
  cc = 'gcc',
  args = [],
  cwd = process.cwd(),
  timeoutMs = DEFAULT_COMPILE_TIMEOUT_MS,
  spawnImpl = spawn,
  objectFile = null,
  rootDir = cwd,
} = {}) {
  if (!file) throw new TypeError('codefuse-compile-requires-file');
  const output = objectFile ?? `${file}.o`;
  const tool = await runTool(cc, [...args, '-c', '-o', output, file], { cwd, timeoutMs, spawnImpl });
  if (tool.status !== 'ok') {
    return {
      status: tool.status === 'timeout' ? 'timeout' : tool.status === 'spawn_error' ? 'spawn_error' : 'compile_failed',
      compileSucceeded: false,
      objectFile: null,
      exitCode: tool.exitCode,
      signal: tool.signal,
      reason: tool.reason,
      durationMs: tool.durationMs,
      diagnostics: summarizeDiagnostics(tool.stderr, { rootDir }),
    };
  }
  return {
    status: 'ok',
    compileSucceeded: true,
    objectFile: output,
    exitCode: 0,
    signal: null,
    reason: null,
    durationMs: tool.durationMs,
    diagnostics: summarizeDiagnostics(tool.stderr, { rootDir }),
  };
}

export async function linkBinary({
  file,
  cc = 'gcc',
  args = [],
  out,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_COMPILE_TIMEOUT_MS,
  spawnImpl = spawn,
  rootDir = cwd,
} = {}) {
  if (!file || !out) throw new TypeError('codefuse-link-requires-file-and-out');
  const tool = await runTool(cc, [...args, '-o', out, file], { cwd, timeoutMs, spawnImpl });
  if (tool.status !== 'ok') {
    return {
      status: tool.status === 'timeout' ? 'timeout' : tool.status === 'spawn_error' ? 'spawn_error' : 'linker_failed',
      linkSucceeded: false,
      binary: null,
      exitCode: tool.exitCode,
      signal: tool.signal,
      reason: tool.reason,
      durationMs: tool.durationMs,
      diagnostics: summarizeDiagnostics(tool.stderr, { rootDir }),
    };
  }
  return {
    status: 'ok',
    linkSucceeded: true,
    binary: out,
    exitCode: 0,
    signal: null,
    reason: null,
    durationMs: tool.durationMs,
    diagnostics: summarizeDiagnostics(tool.stderr, { rootDir }),
  };
}

// Record the exact compiler identity used for a run (bounded, best effort).
export function compilerIdentity(command, { timeoutMs = 20_000 } = {}) {
  const timeout = validateTimeout(timeoutMs, 20_000);
  try {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    const firstLine = String(result.stdout || result.stderr || '').split('\n')[0].trim();
    return { command, version: firstLine || null, status: result.status ?? null, timedOut: result.error?.code === 'ETIMEDOUT' };
  } catch (error) {
    return { command, version: null, status: null, error: String(error?.message || error) };
  }
}
