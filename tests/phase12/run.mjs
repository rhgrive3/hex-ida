import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(ROOT, '../..');
const CHILD_MAX_BUFFER = 512 * 1024 * 1024;

export function findTests(dir = ROOT) {
  const results = [];
  for (const file of readdirSync(dir).sort()) {
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) results.push(...findTests(fullPath));
    else if (file.endsWith('.test.mjs')) results.push(fullPath);
  }
  return results.sort();
}

function runIsolatedTest(file, { cwd, spawn = spawnSync } = {}) {
  const child = spawn(process.execPath, [
    '--test',
    '--test-reporter=spec',
    resolve(file),
  ], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: CHILD_MAX_BUFFER,
  });
  if (child?.error) throw child.error;
  return child;
}

function outputOf(child) {
  return [child?.stdout, child?.stderr]
    .filter((value) => value != null && String(value).length > 0)
    .map(String)
    .join('');
}

export async function runPhase12Tests(argv = [], { root = ROOT, cwd = REPOSITORY_ROOT, spawn = spawnSync } = {}) {
  if (argv.length) throw new TypeError(`phase12: unknown test argument: ${argv[0]}`);
  const testFiles = findTests(root);
  console.log(`Phase 12 tests: discovered ${testFiles.length} files`);
  let passed = 0;
  const failures = [];
  for (const file of testFiles) {
    const child = runIsolatedTest(file, { cwd, spawn });
    if (child?.status === 0) {
      passed++;
      continue;
    }
    const failure = Object.freeze({
      file: relative(root, file),
      status: child?.status ?? null,
      signal: child?.signal ?? null,
      stdout: String(child?.stdout || ''),
      stderr: String(child?.stderr || ''),
    });
    failures.push(failure);
    console.error(`FAIL: ${failure.file}`);
    const output = outputOf(child);
    if (output) console.error(output.trimEnd());
    else console.error(`phase12 child exited with status=${failure.status} signal=${failure.signal || 'none'}`);
  }
  console.log(`Phase 12 results: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    const error = new Error(`phase12: ${failures.length} tests failed`);
    error.failures = Object.freeze(failures);
    throw error;
  }
  return Object.freeze({ passed, failed: failures.length, total: testFiles.length, files: testFiles });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runPhase12Tests(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
