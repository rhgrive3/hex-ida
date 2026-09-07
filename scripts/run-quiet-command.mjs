#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_FAILURE_TAIL_BYTES = 64 * 1024;

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
  const logPath = path.join(directory, 'full.log');
  const log = fs.createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
  let tail = Buffer.alloc(0);
  let logError = null;
  log.on('error', (error) => { logError = error; });

  let child;
  try {
    child = spawnImpl(commandForPlatform(command), args, {
      cwd,
      env: { ...env, HEX_TEST_OUTPUT: env.HEX_TEST_OUTPUT ?? 'quiet' },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
  } catch (error) {
    await new Promise((resolve) => log.end(resolve));
    throw error;
  }

  const capture = (source, prefix) => {
    source?.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      log.write(bytes);
      tail = appendTail(tail, Buffer.concat([Buffer.from(prefix), bytes]));
    });
  };
  capture(child.stdout, '');
  capture(child.stderr, '[stderr] ');

  const status = await waitForChild(child);
  if (status.error) {
    const diagnostic = Buffer.from(`${status.error.stack || status.error}\n`);
    tail = appendTail(tail, diagnostic);
    log.write(diagnostic);
  }
  await new Promise((resolve) => log.end(resolve));

  if (logError) throw logError;
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (!status.error && status.code === 0) {
    fs.rmSync(directory, { recursive: true, force: true });
    stdout.write(`${label}: PASS (${(durationMs / 1000).toFixed(1)}s)\n`);
    return Object.freeze({ ok: true, status: 0, signal: null, logPath: null, durationMs });
  }

  const statusText = status.error
    ? `spawn error: ${status.error.code || status.error.message}`
    : (status.signal ? `signal ${status.signal}` : `exit ${status.code}`);
  stderr.write(`${label}: FAIL (${statusText}, ${(durationMs / 1000).toFixed(1)}s)\n`);
  const text = tail.toString('utf8').trim();
  if (text) stderr.write(`--- failure tail (max 64 KiB) ---\n${text}\n--- end failure tail ---\n`);
  stderr.write(`Full log: ${logPath}\n`);
  stderr.write('Rerun with HEX_TEST_OUTPUT=verbose for live full output.\n');
  return Object.freeze({
    ok: false,
    status: status.code,
    signal: status.signal,
    error: status.error ?? null,
    logPath,
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
