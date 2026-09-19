#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_FAILURE_TAIL_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_FORCE_SETTLE_MS = 1_000;

export function parseQuietCommandArgs(argv) {
  let label = 'command';
  let separator = -1;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--') {
      separator = index;
      break;
    }
    if (argv[index] === '--label') {
      label = String(argv[++index] ?? '').trim();
      if (!label) throw new TypeError('--label requires a non-empty value');
      continue;
    }
    throw new TypeError(`unknown argument before --: ${argv[index]}`);
  }
  if (separator < 0 || separator === argv.length - 1) {
    throw new TypeError('usage: node scripts/run-quiet-command.mjs [--label name] -- <command> [args...]');
  }
  return Object.freeze({ label, command: argv[separator + 1], args: argv.slice(separator + 2) });
}

function safeLabel(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'command';
}

function appendTail(current, chunk) {
  const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  return next.length <= MAX_FAILURE_TAIL_BYTES ? next : next.subarray(next.length - MAX_FAILURE_TAIL_BYTES);
}

function commandForPlatform(command) {
  if (process.platform === 'win32' && command === 'npm') return 'npm.cmd';
  if (process.platform === 'win32' && command === 'npx') return 'npx.cmd';
  return command;
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('error', (error) => finish({ code: null, signal: null, error }));
    child.once('close', (code, signal) => finish({ code, signal, error: null }));
  });
}

function createTerminationController(child, { graceMs, forceSettleMs }) {
  let requested = false;
  let stopped = false;
  let graceTimer = null;
  let forceSettleTimer = null;
  let resolveForced;
  const forcedStatus = new Promise((resolve) => { resolveForced = resolve; });

  const childAppearsRunning = () => child.exitCode == null && child.signalCode == null;
  const stop = () => {
    stopped = true;
    if (graceTimer) clearTimeout(graceTimer);
    if (forceSettleTimer) clearTimeout(forceSettleTimer);
  };

  const request = () => {
    if (requested || stopped || !childAppearsRunning()) return;
    requested = true;
    try { child.kill('SIGTERM'); } catch {}
    graceTimer = setTimeout(() => {
      if (stopped || !childAppearsRunning()) return;
      try { child.kill('SIGKILL'); } catch {}
      forceSettleTimer = setTimeout(() => {
        if (stopped) return;
        // SIGKILL is the strongest termination available through ChildProcess.
        // Do not let a missing/hostile close event keep the quiet runner alive
        // after we have issued it. Detach owned pipes so a pathological child
        // cannot retain this process while the original sink failure is surfaced.
        try { child.stdout?.destroy?.(); } catch {}
        try { child.stderr?.destroy?.(); } catch {}
        try { child.unref?.(); } catch {}
        resolveForced({ code: null, signal: 'SIGKILL', error: null });
      }, forceSettleMs);
    }, graceMs);
  };

  return Object.freeze({ forcedStatus, request, stop });
}

export async function runQuietCommand({
  label,
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  spawnImpl = spawn,
  tempRoot = os.tmpdir(),
  createLogStream = (filePath) => fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 }),
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  forceSettleMs = DEFAULT_FORCE_SETTLE_MS,
} = {}) {
  if (!label || !command) throw new TypeError('label and command are required');
  const selectedMode = String(env.HEX_TEST_OUTPUT ?? '').trim().toLowerCase();
  const verbose = selectedMode === 'verbose' || selectedMode === 'full';
  const started = process.hrtime.bigint();

  if (verbose) {
    const child = spawnImpl(commandForPlatform(command), args, { cwd, env, stdio: 'inherit' });
    const status = await waitForChild(child);
    if (status.error) throw status.error;
    return Object.freeze({
      ok: status.code === 0,
      status: status.code,
      signal: status.signal,
      logPath: null,
      durationMs: Number(process.hrtime.bigint() - started) / 1e6,
    });
  }

  const directory = fs.mkdtempSync(path.join(tempRoot, `hex-${safeLabel(label)}-`));
  const cleanupDirectory = () => fs.rmSync(directory, { recursive: true, force: true });
  const logPath = path.join(directory, 'full.log');
  // A stream factory may throw before returning a stream (EMFILE/ENFILE/open
  // validation). That happens before the async 'error' path owns cleanup, so
  // the directory created on the line above must be released here without
  // masking the original initialization error.
  let log;
  try {
    log = createLogStream(logPath);
  } catch (error) {
    try { cleanupDirectory(); } catch { /* preserve the initialization error */ }
    throw error;
  }
  // 'finish' flushes writes but can precede descriptor close. NFS cleanup
  // must wait for 'close' so an open log cannot leave a transient .nfs entry.
  const logClosed = new Promise((resolve) => log.once('close', resolve));
  let tail = Buffer.alloc(0);
  let logError = null;
  let child;
  let terminationController = null;

  let backpressured = false;
  const sources = new Set();

  const pauseSources = () => {
    if (backpressured) return;
    backpressured = true;
    for (const source of sources) {
      if (typeof source.pause === 'function') {
        try { source.pause(); } catch {}
      }
    }
  };

  const resumeSources = () => {
    if (!backpressured) return;
    backpressured = false;
    for (const source of sources) {
      if (typeof source.resume === 'function') {
        try { source.resume(); } catch {}
      }
    }
  };

  log.on('drain', resumeSources);
  log.on('error', (error) => {
    if (!logError) logError = error;
    resumeSources();
    terminationController?.request();
  });

  try {
    child = spawnImpl(commandForPlatform(command), args, {
      cwd,
      env: { ...env, HEX_TEST_OUTPUT: env.HEX_TEST_OUTPUT ?? 'quiet' },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
  } catch (error) {
    try { log.end(); } catch {}
    try { await logClosed; } catch {}
    cleanupDirectory();
    throw error;
  }

  const childStatus = waitForChild(child);
  terminationController = createTerminationController(child, {
    graceMs: Math.max(0, Number(terminationGraceMs) || 0),
    forceSettleMs: Math.max(0, Number(forceSettleMs) || 0),
  });
  if (logError) terminationController.request();

  if (child.stdout) sources.add(child.stdout);
  if (child.stderr) sources.add(child.stderr);
  for (const source of sources) {
    source.once('end', () => sources.delete(source));
    source.once('close', () => sources.delete(source));
  }

  const capture = (source, prefix) => {
    source?.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const accepted = log.write(bytes);
      tail = appendTail(tail, Buffer.concat([Buffer.from(prefix), bytes]));
      if (!accepted) {
        pauseSources();
      }
    });
  };
  capture(child.stdout, '');
  capture(child.stderr, '[stderr] ');

  const status = await Promise.race([childStatus, terminationController.forcedStatus]);
  terminationController.stop();
  if (status.error) {
    const diagnostic = Buffer.from(`${status.error.stack || status.error}\n`);
    tail = appendTail(tail, diagnostic);
    try { log.write(diagnostic); } catch {}
  }
  try { log.end(); } catch {}
  try { await logClosed; } catch {}

  if (logError) {
    try { cleanupDirectory(); } catch {}
    throw logError;
  }
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (!status.error && status.code === 0) {
    cleanupDirectory();
    stdout.write(`${label}: PASS (${(durationMs / 1000).toFixed(1)}s)\n`);
    return Object.freeze({ ok: true, status: 0, signal: null, logPath: null, durationMs });
  }

  const spawnFailure = Boolean(status.error);
  if (spawnFailure) cleanupDirectory();
  const statusText = status.error
    ? `spawn error: ${status.error.code || status.error.message}`
    : (status.signal ? `signal ${status.signal}` : `exit ${status.code}`);
  stderr.write(`${label}: FAIL (${statusText}, ${(durationMs / 1000).toFixed(1)}s)\n`);
  const text = tail.toString('utf8').trim();
  if (text) stderr.write(`--- failure tail (max 64 KiB) ---\n${text}\n--- end failure tail ---\n`);
  if (spawnFailure) stderr.write('Spawn failure log cleaned after diagnostic capture.\n');
  else stderr.write(`Full log: ${logPath}\n`);
  stderr.write('Rerun with HEX_TEST_OUTPUT=verbose for live full output.\n');
  return Object.freeze({
    ok: false,
    status: status.code,
    signal: status.signal,
    error: status.error ?? null,
    logPath: spawnFailure ? null : logPath,
    durationMs,
  });
}

async function main() {
  const parsed = parseQuietCommandArgs(process.argv.slice(2));
  const result = await runQuietCommand(parsed);
  if (!result.ok) process.exitCode = result.status || 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
