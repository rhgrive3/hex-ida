import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const expected = String(pkg.scripts?.check || '')
  .split(/\s+&&\s+/)
  .map((command) => command.trim())
  .filter(Boolean);
if (expected.length < 2) throw new Error('npm check must contain at least two top-level commands');
if (new Set(expected).size !== expected.length) throw new Error('npm check contains duplicate top-level commands');

const priority = new Map([
  ['npm test', 100],
  ['npm run phase8:test', 95],
  ['npm run invariants:test', 90],
  ['npm run phase5:test', 85],
  ['npm run semantic-v2:test', 80],
  ['npm run phase6:test', 75],
  ['npm run phase12:test', 70],
  ['npm run phase11:test', 65],
  ['npm run phase4:test', 60],
  ['npm run phase9:test', 55],
  ['npm run phase10:test', 50],
  ['npm run phase7:test', 45],
  ['npm run benchmark:baseline', 40],
]);
const commands = expected
  .map((command, index) => ({ command, originalIndex:index }))
  .sort((a, b) => (priority.get(b.command) || 0) - (priority.get(a.command) || 0) || a.originalIndex - b.originalIndex);

function concurrencyFromEnv() {
  const raw = process.env.HEX_CHECK_CONCURRENCY;
  if (raw != null && raw !== '') {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 4) throw new TypeError('HEX_CHECK_CONCURRENCY must be an integer in [1,4]');
    return value;
  }
  return Math.min(4, Math.max(1, os.availableParallelism()));
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding:'utf8', maxBuffer:16 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
  return result.stdout?.trim() || '';
}

const tempRoot = path.join(process.env.RUNNER_TEMP || os.tmpdir(), `hex-check-${process.pid}-${Date.now()}`);
fs.mkdirSync(tempRoot, { recursive:true });
const nodeModules = path.join(root, 'node_modules');
if (!fs.existsSync(nodeModules)) throw new Error('ci-parallel-check requires root node_modules');

const worktrees = [];
function createWorktree(index) {
  const directory = path.join(tempRoot, `shard-${String(index).padStart(2, '0')}`);
  git(['worktree', 'add', '--detach', '--quiet', directory, 'HEAD']);
  worktrees.push(directory);
  const target = path.join(directory, 'node_modules');
  try {
    fs.symlinkSync(nodeModules, target, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return directory;
}

function execute(item, index) {
  const cwd = createWorktree(index);
  const invariant = item.command === 'npm run invariants:test';
  const command = invariant
    ? 'node tools/validation/invariant-pr-baseline.mjs'
    : item.command;
  const env = {
    ...process.env,
    HEX_PHASE_TEST_CONCURRENCY: process.env.HEX_PHASE_TEST_CONCURRENCY || '2',
    HEX_INVARIANT_CONCURRENCY: process.env.HEX_INVARIANT_CONCURRENCY || '2',
    ...(invariant ? { HEX_INVARIANT_BASE_REF: 'refs/remotes/origin/main' } : {}),
  };
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      env,
      shell:true,
      stdio:['ignore','pipe','pipe'],
    });
    const stdout = [];
    const stderr = [];
    let error = null;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (value) => { error = value; });
    child.once('close', (code, signal) => resolve({
      ...item,
      commandRun:command,
      code:error ? 1 : code,
      signal,
      error,
      durationMs:Date.now() - startedAt,
      stdout:Buffer.concat(stdout).toString('utf8'),
      stderr:Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

const concurrency = concurrencyFromEnv();
const results = new Array(commands.length);
let next = 0;
async function worker() {
  while (true) {
    const index = next++;
    if (index >= commands.length) return;
    results[index] = await execute(commands[index], index);
  }
}

try {
  await Promise.all(Array.from({ length:Math.min(concurrency, commands.length) }, () => worker()));
} finally {
  for (const directory of worktrees.reverse()) {
    spawnSync('git', ['worktree','remove','--force',directory], { cwd:root, stdio:'ignore' });
  }
  spawnSync('git', ['worktree','prune'], { cwd:root, stdio:'ignore' });
  fs.rmSync(tempRoot, { recursive:true, force:true });
}

const failures = [];
const executed = new Map();
for (const result of results) {
  if (!result) continue;
  executed.set(result.command, (executed.get(result.command) || 0) + 1);
  process.stdout.write(`\n[ci-check] ${result.command} (${(result.durationMs / 1000).toFixed(1)}s)\n`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) process.stderr.write(`${result.error.stack || result.error.message || result.error}\n`);
  if (result.code !== 0 || result.signal) failures.push(result);
}
for (const command of expected) {
  if (executed.get(command) !== 1) failures.push({ command, code:1, signal:null });
}
if (executed.size !== expected.length) throw new Error('ci-parallel-check command accounting mismatch');
if (failures.length) {
  throw new Error(`ci-parallel-check failed: ${failures.map(({ command }) => command).join(', ')}`);
}
console.log(`ci-parallel-check: PASS (${expected.length} exact top-level commands; concurrency=${concurrency})`);
