// Runtime functionality lane, shaped after CodeFuse-DeBench Step 3
// (`evaluator/semantic/run_instrumentation.py` + `analyze_traces.py`).
//
// Scope and honesty constraints:
//   * the ORIGINAL binary is always the ground-truth side;
//   * a compiled program is not treated as semantically correct - only the
//     runtime comparison decides;
//   * compile success never contributes to the functionality result;
//   * timeout, crash, mismatch, unsupported, and pass are separate states;
//   * every execution has a finite timeout.
//
// Reduction vs upstream (documented in upstream-contract.md): upstream derives
// "stable" program-level cases from the original benchmark source plus
// `case_stability_config.json`. That source is not part of this repository, so
// the stable set defaults to the union of test-ids observed on either side while
// the comparison key `(test_id, occurrence)` and normalization are unchanged.

import { spawn } from 'node:child_process';

export const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const STDOUT_CAPTURE_BYTES = 1024 * 1024;
const STDERR_CAPTURE_BYTES = 64 * 1024;
// Upstream `TEST_ID_RE` (evaluator/semantic/semantic_utils.py).
const TEST_ID_RE = /([A-Z]{2,}(?:-[A-Z0-9]+)+)/g;

export function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\u3000/g, ' ').split(/\s+/).filter(Boolean).join(' ');
}

export function parseStdoutCases(stdout) {
  const occurrences = new Map();
  const cases = [];
  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    TEST_ID_RE.lastIndex = 0;
    const match = TEST_ID_RE.exec(line);
    if (!match) continue;
    const testId = match[1];
    const occurrence = (occurrences.get(testId) ?? 0) + 1;
    occurrences.set(testId, occurrence);
    cases.push({ testId, occurrence, raw: line, normalized: normalizeWhitespace(line) });
  }
  return cases;
}

export function classifyRunIssue(run) {
  if (!run) return 'missing_run';
  const stderr = String(run.stderr || '');
  if (run.timedOut) return 'timeout';
  if (stderr.startsWith('Binary not found:')) return 'missing_binary';
  if (stderr.includes('GLIBC_')) return 'glibc_mismatch';
  if (stderr.includes('Exec format error') || stderr.includes('cannot execute binary file')) return 'exec_format_error';
  if (run.signal != null) return `signal_${run.signal}`;
  if (run.exitCode != null && run.exitCode !== 0) return `exit_${run.exitCode}`;
  return 'ok';
}

// Upstream treats these as "incomparable" rather than a quality failure.
const INCOMPARABLE_ISSUES = new Set(['missing_run', 'timeout', 'missing_binary', 'glibc_mismatch', 'exec_format_error']);

export async function runProgram({
  binary,
  args = [],
  cwd = process.cwd(),
  timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  spawnImpl = spawn,
  env = process.env,
} = {}) {
  if (!binary) throw new TypeError('codefuse-run-requires-binary');
  const timeout = Number(timeoutMs);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 900_000) throw new TypeError(`codefuse-run-timeout-out-of-range:${timeoutMs}`);
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: 'spawn_error', stdout: '', stderr: String(error?.message || error), exitCode: null, signal: null, timedOut: false, durationMs: 0, truncated: false });
      return;
    }
    if (!child?.once) {
      resolve({ status: 'spawn_error', stdout: '', stderr: 'invalid-child-process', exitCode: null, signal: null, timedOut: false, durationMs: 0, truncated: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...value, truncated, durationMs: Number(process.hrtime.bigint() - started) / 1e6 });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeout);
    child.stdout?.on?.('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > STDOUT_CAPTURE_BYTES) { stdout = stdout.slice(-STDOUT_CAPTURE_BYTES); truncated = true; }
    });
    child.stderr?.on?.('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > STDERR_CAPTURE_BYTES) { stderr = stderr.slice(-STDERR_CAPTURE_BYTES); truncated = true; }
    });
    child.once('error', (error) => finish({ status: 'spawn_error', stdout, stderr: String(error?.message || error), exitCode: null, signal: null, timedOut }));
    child.once('close', (code, signal) => finish({ status: timedOut ? 'timeout' : 'ok', stdout, stderr, exitCode: code, signal, timedOut }));
  });
}

// Compare a candidate run against the original (ground truth). Returns an
// explicit state that can never conflate a mismatch with a pass.
export function compareFunctionality({ originalRun, candidateRun, stableCaseIds = null } = {}) {
  const originalIssue = classifyRunIssue(originalRun);
  const candidateIssue = classifyRunIssue(candidateRun);
  const originalCases = parseStdoutCases(originalRun?.stdout);
  const candidateCases = parseStdoutCases(candidateRun?.stdout);
  const stable = stableCaseIds ? new Set(stableCaseIds) : null;
  const isStable = (testId) => (stable ? stable.has(testId) : true);

  const originalStable = new Map();
  const candidateStable = new Map();
  for (const entry of originalCases) if (isStable(entry.testId)) originalStable.set(`${entry.testId}#${entry.occurrence}`, entry);
  for (const entry of candidateCases) if (isStable(entry.testId)) candidateStable.set(`${entry.testId}#${entry.occurrence}`, entry);

  const keys = [...new Set([...originalStable.keys(), ...candidateStable.keys()])];
  const comparisons = [];
  let matched = 0;
  for (const key of keys) {
    const left = originalStable.get(key);
    const right = candidateStable.get(key);
    const same = Boolean(left && right && left.normalized === right.normalized);
    if (same) matched += 1;
    comparisons.push({ key, matched: same, original: left?.raw ?? null, candidate: right?.raw ?? null });
  }
  const denominator = keys.length;
  const matchRatio = denominator ? matched / denominator : 0;

  const processStatusMatch = Boolean(originalRun && candidateRun
    && originalRun.exitCode === candidateRun.exitCode
    && (originalRun.signal ?? null) === (candidateRun.signal ?? null));

  const base = {
    processStatusMatch,
    stdoutExactMatch: Boolean(originalRun && candidateRun && originalRun.stdout === candidateRun.stdout),
    stableCaseTotal: denominator,
    stableCaseMatched: matched,
    stdoutCaseMatchRatio: Number(matchRatio.toFixed(4)),
    originalRunIssue: originalIssue,
    candidateRunIssue: candidateIssue,
    originalExitCode: originalRun?.exitCode ?? null,
    candidateExitCode: candidateRun?.exitCode ?? null,
    originalSignal: originalRun?.signal ?? null,
    candidateSignal: candidateRun?.signal ?? null,
    comparisonsTotal: comparisons.length,
    comparisons,
  };

  // Original side cannot be executed here: no comparable evidence exists.
  if (INCOMPARABLE_ISSUES.has(originalIssue)) {
    return { ...base, state: 'unsupported', reason: `original-run-incomparable:${originalIssue}` };
  }
  if (candidateIssue === 'timeout') return { ...base, state: 'timeout', reason: 'candidate-timeout' };
  if (candidateIssue.startsWith('signal_') || INCOMPARABLE_ISSUES.has(candidateIssue)) {
    return { ...base, state: 'crash', reason: `candidate-run-failed:${candidateIssue}` };
  }
  if (!base.processStatusMatch) {
    return { ...base, state: 'mismatch', reason: `process-status-mismatch:${originalIssue}->${candidateIssue}` };
  }
  if (denominator === 0) {
    const anyStdout = Boolean(normalizeWhitespace(candidateRun?.stdout));
    return { ...base, state: anyStdout ? 'mismatch' : 'unsupported', reason: anyStdout ? 'no-comparable-cases' : 'no-stdout-evidence' };
  }
  if (matched === denominator && candidateStable.size > 0) return { ...base, state: 'pass', reason: null };
  if (matched > 0) return { ...base, state: 'partial', reason: 'partial-case-match' };
  return { ...base, state: 'mismatch', reason: 'no-case-match' };
}

// Aggregate the published "Exact Stdout + Partial" functionality rate over a
// fixed denominator. Failed/unsupported cases stay in the denominator.
export function functionalityRate(results) {
  const denominator = results.length;
  const exact = results.filter((entry) => entry.state === 'pass').length;
  const partial = results.filter((entry) => entry.state === 'partial').length;
  return {
    denominator,
    exact,
    partial,
    exactPartialRate: denominator ? Number(((exact + partial) / denominator).toFixed(4)) : null,
  };
}
