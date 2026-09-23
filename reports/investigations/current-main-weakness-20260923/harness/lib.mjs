/*
 * Shared helpers for the current-main weakness measurement harness.
 *
 * Measurement-only lane: nothing here imports or mutates production analysis
 * semantics. The product path is exercised through the existing read-only
 * terminal host in tools/validation/public-benchmark/product-host.mjs.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const HARNESS_REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
export const RUN_SCHEMA = 'hex-current-main-harness-run/v1';
export const SUMMARY_SCHEMA = 'hex-current-main-harness-summary/v1';
export const CASE_SCHEMA = 'hex-current-main-harness-case/v1';
export const FUNCTION_SCHEMA = 'hex-current-main-harness-function/v1';

export function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index < 0 || index + 1 >= args.length ? fallback : args[index + 1];
}

export function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1] != null) values.push(args[index + 1]);
  }
  return values;
}

export function hasFlag(args, name) {
  return args.includes(name);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(stable(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function atomicWriteJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, target);
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

export function receiptFileName(address) {
  return `${sha256(String(address)).slice(0, 24)}.json`;
}

export function caseFileName(caseId) {
  return `${Buffer.from(String(caseId)).toString('hex')}.json`;
}

export function configDigest(config) {
  return sha256(stableJson({ schema: 'hex-current-main-harness-config/v1', ...config }));
}

export function computeHarnessSourceHash(harnessDir) {
  const files = fs.readdirSync(harnessDir).filter(f => f.endsWith('.mjs') || f.endsWith('.js')).sort();
  const hashes = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(harnessDir, f));
    hashes.push(`${f}:${sha256(content)}`);
  }
  return sha256(hashes.join('\n'));
}

export function captureSourceIdentity({ repoRoot = HARNESS_REPO_ROOT, gitExec = execFileSync } = {}) {
  const root = path.resolve(repoRoot);
  try {
    const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 };
    const head = gitExec('git', ['rev-parse', 'HEAD'], options).trim();
    if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('source-head-invalid');
    const status = String(gitExec('git', [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--',
      'js', 'tools/validation/public-benchmark', 'package.json', 'package-lock.json',
      'capstone.js', 'capstone.wasm', 'worker-entry.js', 'worker.js',
    ], options));
    const dirty = [];
    for (const entry of status.split('\0').filter(Boolean)) {
      const state = entry.slice(0, 2);
      const relative = entry.slice(3);
      dirty.push([state, relative.split(path.sep).join('/')]);
    }
    return { kind: 'git-worktree', head, dirty, identity: sha256(stableJson({ head, dirty })) };
  } catch (error) {
    return { kind: 'unavailable', head: null, dirty: [], identity: null, reason: String(error?.message || error) };
  }
}

function finiteSorted(values) {
  return values.filter(Number.isFinite).slice().sort((left, right) => left - right);
}

// Nearest-rank percentile over the observed population (same convention as
// tools/validation/public-benchmark/fresh-state.mjs `percentile`).
export function percentile(values, p) {
  const sorted = finiteSorted(values);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function distribution(values) {
  const sorted = finiteSorted(values);
  if (!sorted.length) return { count: 0, min: null, p50: null, p90: null, p95: null, p99: null, max: null, sum: null, mean: null };
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    sum,
    mean: sum / sorted.length,
  };
}

export function countBy(rows, keyOf) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]))));
}

export function round(value, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}
