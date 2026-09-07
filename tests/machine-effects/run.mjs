import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) throw new Error('machine-effects: no Phase 2 tests discovered');

// Each MachineEffects test file is an independent denominator/contract proof.
// Run files in isolated Node processes so heavy finite-denominator scans can use
// separate cores without sharing module/global state. Keep concurrency bounded
// to avoid oversubscribing hosted CI runners and preserve deterministic output
// by publishing captured results in filename order after every worker settles.
const concurrency = Math.max(1, Math.min(4, os.availableParallelism()));
const results = new Array(files.length);
let nextIndex = 0;

async function worker() {
  while (true) {
    const index = nextIndex++;
    if (index >= files.length) return;
    results[index] = await runFile(files[index]);
  }
}

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(directory, file)], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolve({
      file,
      code: spawnError ? 1 : code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: `${Buffer.concat(stderr).toString('utf8')}${spawnError ? `${spawnError.stack || spawnError.message || String(spawnError)}\n` : ''}`,
    }));
  });
}

await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));

const failures = [];
for (const result of results) {
  process.stdout.write(`[machine-effects] ${result.file}\n`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code !== 0 || result.signal) failures.push(result);
}

if (failures.length > 0) {
  const summary = failures
    .map(({ file, code, signal }) => `${file}:${signal ? `signal=${signal}` : `exit=${code}`}`)
    .join(', ');
  throw new Error(`machine-effects: ${failures.length} file(s) failed: ${summary}`);
}

console.log(`machine-effects: PASS (${files.length} files; concurrency=${concurrency})`);
