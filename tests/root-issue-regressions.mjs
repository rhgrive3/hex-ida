import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTIC_BYTES = 12 * 1024;

// Keep the exclusion surface explicit even while every root issue regression is
// executable. Adding an entry requires a durable owner/reason/review record;
// omission from this table is never a way to remove a regression from the gate.
export const ROOT_ISSUE_EXCLUSIONS = Object.freeze({
  'issue-6262-destroy-resize-timer.mjs': Object.freeze({
    reason: 'requires the Playwright Chromium executable; delegated to the required AI browser regression lane',
    owner: 'rhgrive3',
    reviewed: '2026-09-17',
    script: 'ai:browser',
  }),
  'issue-6264-ai-capability-refresh.mjs': Object.freeze({
    reason: 'requires the Playwright Chromium executable; delegated to the required AI browser regression lane',
    owner: 'rhgrive3',
    reviewed: '2026-09-17',
    script: 'ai:browser',
  }),
});

function compareFileNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveInteger(value, fallback, label) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function packageScripts(root) {
  const packagePath = path.join(root, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (!packageJson.scripts || typeof packageJson.scripts !== 'object') {
    throw new Error('root issue exclusion policy requires package scripts');
  }
  return packageJson.scripts;
}

function validateExclusions(allNames, scripts) {
  for (const [name, record] of Object.entries(ROOT_ISSUE_EXCLUSIONS)) {
    if (!allNames.includes(name)) throw new Error(`root issue exclusion names missing file: ${name}`);
    if (!record || typeof record !== 'object'
      || typeof record.reason !== 'string' || record.reason.trim() === ''
      || typeof record.owner !== 'string' || record.owner.trim() === ''
      || typeof record.reviewed !== 'string' || record.reviewed.trim() === ''
      || typeof record.script !== 'string' || record.script.trim() === '') {
      throw new TypeError(`root issue exclusion requires reason, owner, reviewed, and script: ${name}`);
    }
    if (typeof scripts[record.script] !== 'string' || !scripts[record.script].includes(name)) {
      throw new Error(`root issue exclusion is not delegated to its declared package script: ${name} -> ${record.script}`);
    }
  }
}

export function discoverRootIssueRegressions(root = TESTS_ROOT) {
  const names = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.name.startsWith('issue-')) return false;
      // Follow links explicitly so a root regression cannot disappear from the
      // gate merely because it was materialized as a symlink.
      return entry.isFile() || (entry.isSymbolicLink() && fs.statSync(path.join(root, entry.name)).isFile());
    })
    .map((entry) => entry.name)
    .sort(compareFileNames);
  if (names.length === 0) throw new Error('root issue regression discovery found no tests/issue-* files');
  validateExclusions(names, packageScripts(root));
  const excluded = names.filter((name) => Object.hasOwn(ROOT_ISSUE_EXCLUSIONS, name));
  const executed = names.filter((name) => !Object.hasOwn(ROOT_ISSUE_EXCLUSIONS, name));
  return Object.freeze({
    all: Object.freeze(names),
    executed: Object.freeze(executed),
    excluded: Object.freeze(excluded),
  });
}

function appendTail(current, chunk) {
  const next = current + chunk.toString();
  return next.length > MAX_DIAGNOSTIC_BYTES ? next.slice(-MAX_DIAGNOSTIC_BYTES) : next;
}

function terminate(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  try { child.kill('SIGTERM'); } catch { /* process already exited */ }
  setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGKILL'); } catch { /* process already exited */ }
    }
  }, 1_000).unref();
}

function runOne(name, { timeoutMs }) {
  const file = path.join(TESTS_ROOT, name);
  const executable = path.extname(name) === '.py' ? (process.env.PYTHON || 'python3') : process.execPath;
  return new Promise((resolve) => {
    const child = spawn(executable, [file], {
      cwd: path.dirname(TESTS_ROOT),
      env: { ...process.env, HEX_ROOT_ISSUE_REGRESSION: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostic = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { diagnostic = appendTail(diagnostic, chunk); });
    child.stderr.on('data', (chunk) => { diagnostic = appendTail(diagnostic, chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ name, ok: false, code: null, signal: null, timedOut, diagnostic: `${diagnostic}\n${error.stack || error}` });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ name, ok: !timedOut && code === 0, code, signal, timedOut, diagnostic });
    });
  });
}

export async function runRootIssueRegressions({
  concurrency = positiveInteger(process.env.HEX_ROOT_ISSUE_CONCURRENCY, DEFAULT_CONCURRENCY, 'HEX_ROOT_ISSUE_CONCURRENCY'),
  timeoutMs = positiveInteger(process.env.HEX_ROOT_ISSUE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'HEX_ROOT_ISSUE_TIMEOUT_MS'),
} = {}) {
  const inventory = discoverRootIssueRegressions();
  const results = new Array(inventory.executed.length);
  let next = 0;
  const workerCount = Math.min(concurrency, inventory.executed.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= inventory.executed.length) return;
      results[index] = await runOne(inventory.executed[index], { timeoutMs });
    }
  }));
  return Object.freeze({ inventory, results: Object.freeze(results) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { inventory, results } = await runRootIssueRegressions();
    const failures = results.filter((result) => !result.ok);
    console.log(`root issue regressions: ${results.length - failures.length}/${results.length} passed; ${inventory.excluded.length} explicitly excluded; concurrency=${Math.min(positiveInteger(process.env.HEX_ROOT_ISSUE_CONCURRENCY, DEFAULT_CONCURRENCY, 'HEX_ROOT_ISSUE_CONCURRENCY'), results.length)}`);
    for (const result of failures) {
      const status = result.timedOut ? 'TIMEOUT' : `exit=${result.code ?? 'null'}${result.signal ? ` signal=${result.signal}` : ''}`;
      console.error(`FAIL ${result.name} (${status})\n${result.diagnostic}`);
    }
    for (const name of inventory.excluded) {
      const record = ROOT_ISSUE_EXCLUSIONS[name];
      console.error(`EXCLUDED ${name}: ${record.reason} [owner=${record.owner}; reviewed=${record.reviewed}]`);
    }
    process.exitCode = failures.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}
