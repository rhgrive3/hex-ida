#!/usr/bin/env node
/**
 * G direct-recompilability measurement entry point built on the resumable
 * harness (`resumable-measurement.mjs`).
 *
 * Per manifest case:
 *  1. run the existing public-benchmark subject runner (`runCase`) to collect
 *     decompiled function pseudocode (reuses tools/validation/public-benchmark);
 *  2. reconstruct one C translation unit from non-null pseudocode bodies
 *     (same rule as the investigation baseline: join in function order);
 *  3. `clang -fsyntax-only` then `clang -O0` link check with per-stage timeout.
 *
 * Case verdicts use the harness contract states (PASS | FAIL | TIMEOUT |
 * CRASH | NOT_RUN). Subject TIMEOUT/CRASH propagate; clang-stage timeouts are
 * recorded as TIMEOUT, never as PASS.
 *
 * Measurement-only: this file must not change production emitter/analysis code.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, verifyInputs } from '../public-benchmark/manifest.mjs';
import { runCase } from '../public-benchmark/run-case.mjs';
import { countFunctionStates } from '../public-benchmark/outcome.mjs';
import {
  buildRetryManifest,
  formatSummaryLine,
  measureCases,
  openRun,
} from './resumable-measurement.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index < 0 || index + 1 >= args.length ? fallback : args[index + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

export function reconstructSource(functions) {
  const bodies = [];
  for (const fn of Array.isArray(functions) ? functions : []) {
    if (typeof fn?.pseudocode === 'string' && fn.pseudocode.trim()) bodies.push(fn.pseudocode);
  }
  if (bodies.length === 0) return null;
  return `${bodies.join('\n')}\n`;
}

function runClang({ clang, sourceFile, mode, timeoutMs, spawnRunner = spawnSync }) {
  const args = mode === 'syntax'
    ? ['-std=gnu11', '-fsyntax-only', '-ferror-limit=0', sourceFile]
    : ['-std=gnu11', '-O0', '-ferror-limit=0', sourceFile, '-o', path.join(os.tmpdir(), `hex-g-link-${process.pid}-${Date.now()}.out`)];
  try {
    const result = spawnRunner(clang, args, { encoding: 'utf8', timeout: timeoutMs });
    if (result.error?.code === 'ETIMEDOUT') return { ok: false, timedOut: true, diagnostics: '' };
    if (result.error) return { ok: false, timedOut: false, diagnostics: String(result.error?.message || result.error).slice(0, 2000) };
    if (result.signal) return { ok: false, timedOut: false, diagnostics: `clang-signal:${result.signal}` };
    if (result.status !== 0) {
      return { ok: false, timedOut: false, diagnostics: String(result.stderr || result.stdout || '').slice(-4000) };
    }
    return { ok: true, timedOut: false, diagnostics: '' };
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') return { ok: false, timedOut: true, diagnostics: '' };
    return { ok: false, timedOut: false, diagnostics: String(error?.message || error).slice(0, 2000) };
  }
}

export function createGCaseRunner({
  clang = 'clang',
  clangTimeoutMs = 30000,
  subjectTimeoutMs = 120000,
  tmpRoot = null,
  spawnRunner = spawnSync,
  runSubject = runCase,
} = {}) {
  const scratch = tmpRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hex-g-measure-'));
  fs.mkdirSync(scratch, { recursive: true });
  return async (manifestCase) => {
    const subjectOut = path.join(scratch, `${Buffer.from(manifestCase.id).toString('hex')}.subject.json`);
    let subject;
    try {
      const completed = await runSubject({ binary: manifestCase.path, out: subjectOut, timeout: subjectTimeoutMs });
      subject = completed.row;
    } catch (error) {
      return { state: 'CRASH', reason: `subject-runner-throw:${String(error?.message || error).slice(0, 200)}`, functions: null };
    }
    const functionStates = countFunctionStates(subject.functions);
    const progress = {
      total: subject.functions.length,
      states: functionStates,
      extra: { subjectState: subject.state, subjectReason: subject.reason ?? null },
    };
    if (subject.state === 'TIMEOUT') return { state: 'TIMEOUT', reason: subject.reason || 'subject-timeout', functions: progress };
    if (subject.state === 'CRASH') return { state: 'CRASH', reason: subject.reason || 'subject-crash', functions: progress };
    if (subject.state !== 'PASS') {
      return { state: 'FAIL', reason: `subject-${subject.state.toLowerCase()}:${(subject.reason || 'no-reason').slice(0, 160)}`, functions: progress };
    }
    const source = reconstructSource(subject.functions);
    if (source === null) return { state: 'FAIL', reason: 'no-decompiled-bodies', functions: progress };
    const sourceFile = path.join(scratch, `${Buffer.from(manifestCase.id).toString('hex')}.c`);
    fs.writeFileSync(sourceFile, source);
    const syntax = runClang({ clang, sourceFile, mode: 'syntax', timeoutMs: clangTimeoutMs, spawnRunner });
    if (syntax.timedOut) return { state: 'TIMEOUT', reason: 'clang-syntax-timeout', functions: progress };
    if (!syntax.ok) return { state: 'FAIL', reason: 'syntax-failed', functions: progress };
    const link = runClang({ clang, sourceFile, mode: 'link', timeoutMs: clangTimeoutMs, spawnRunner });
    if (link.timedOut) return { state: 'TIMEOUT', reason: 'clang-link-timeout', functions: progress };
    if (!link.ok) return { state: 'FAIL', reason: 'link-failed', functions: progress };
    return { state: 'PASS', reason: null, functions: progress };
  };
}

export async function measureG({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  repoRoot = REPOSITORY_ROOT,
  spawnRunner = spawnSync,
  runSubject = runCase,
  log = console.log,
} = {}) {
  const manifestFile = path.resolve(cwd, optionValue(args, '--manifest', 'benchmarks/public/codefuse-arm64/manifest.json'));
  const storeDir = path.resolve(cwd, optionValue(args, '--store-dir', null) ?? (() => { throw new Error('measure-g-store-dir-required'); })());
  const limit = Number(optionValue(args, '--limit', '0'));
  const onlyRaw = optionValue(args, '--only', '');
  const subjectTimeoutMs = Number(optionValue(args, '--subject-timeout-ms', '120000'));
  const clangTimeoutMs = Number(optionValue(args, '--clang-timeout-ms', '30000'));
  const clang = optionValue(args, '--clang', 'clang');
  const writeRetry = hasFlag(args, '--retry-manifest');
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('measure-g-limit-invalid');
  if (!Number.isSafeInteger(subjectTimeoutMs) || subjectTimeoutMs < 1000 || subjectTimeoutMs > 900000) {
    throw new Error('measure-g-subject-timeout-invalid');
  }
  if (!Number.isSafeInteger(clangTimeoutMs) || clangTimeoutMs < 1000 || clangTimeoutMs > 600000) {
    throw new Error('measure-g-clang-timeout-invalid');
  }

  const manifest = loadManifest(manifestFile);
  const suiteRoot = path.dirname(manifestFile);
  const inputs = verifyInputs(manifest, suiteRoot);
  const byId = new Map(inputs.map(entry => [entry.id, entry]));
  let selected = manifest.cases;
  if (onlyRaw) {
    const wanted = onlyRaw.split(',').map(part => part.trim()).filter(Boolean);
    selected = wanted.map(id => {
      const found = manifest.cases.find(entry => entry.id === id);
      if (!found) throw new Error(`measure-g-unknown-case:${id}`);
      return found;
    });
  } else if (limit > 0) {
    selected = manifest.cases.slice(0, limit);
  }
  const cases = selected.map(entry => ({ ...entry, path: byId.get(entry.id)?.path ?? null, inputState: byId.get(entry.id)?.state ?? 'MISSING' }));

  const { execFileSync } = await import('node:child_process');
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const run = openRun({ storeDir, manifest, headSha });
  log(`run store: ${storeDir}`);
  log(`head: ${headSha} manifest: ${run.manifestSha256} denominator: ${manifest.cases.length}`);

  const runner = createGCaseRunner({ clang, clangTimeoutMs, subjectTimeoutMs, tmpRoot: path.join(storeDir, 'tmp'), spawnRunner, runSubject });
  const runCaseWithInputs = async (manifestCase) => {
    if (manifestCase.inputState !== 'READY') {
      return { state: 'NOT_RUN', reason: `input-not-ready:${manifestCase.inputState}`, functions: null };
    }
    return runner(manifestCase);
  };

  const summary = await measureCases({
    storeDir,
    manifest,
    cases,
    runCase: runCaseWithInputs,
    headSha,
    onProgress: ({ id, state, resumed }) => log(`${resumed ? 'resume-skip' : 'measured'} ${id}: ${state}`),
  });
  log(formatSummaryLine(summary));
  if (!summary.complete) log('INCOMPLETE RUN: not all manifest cases hold terminal verdicts; see summary.json warnings/results.');
  if (writeRetry) {
    const retry = buildRetryManifest({ storeDir, manifest, headSha });
    log(`retry manifest -> ${path.join(storeDir, 'retry.json')} (${retry.cases.length} cases)`);
  }
  return { summary, storeDir, exitCode: summary.complete ? 0 : 2 };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const { exitCode } = await measureG();
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
