/**
 * Resumable measurement harness for G direct recompilability.
 *
 * Contract (measurement-only; never touches production emitter/analysis code):
 * - every manifest case gets one durable per-case record (atomic tmp+rename write);
 * - resume re-executes only NOT_RUN and TIMEOUT records by default (configurable);
 * - case states are explicit: PASS | FAIL | TIMEOUT | CRASH | NOT_RUN;
 * - missing/corrupt records are surfaced, never silently dropped;
 * - the summary denominator is always the full manifest case count;
 * - an incomplete run is reported with complete:false and must never be
 *   presented as complete;
 * - retry manifests list only retry-eligible cases (deduplicated);
 * - per-case records are keyed by case id, so duplicate execution cannot
 *   double-count;
 * - the source HEAD SHA and manifest hash are recorded and enforced, so
 *   results from a different HEAD/manifest cannot be mixed in;
 * - function-level progress reported by the runner is preserved per case.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RUN_SCHEMA = 'hex-recompilability-resumable-run/v1';
export const CASE_SCHEMA = 'hex-recompilability-resumable-case/v1';
export const SUMMARY_SCHEMA = 'hex-recompilability-resumable-summary/v1';
export const RETRY_SCHEMA = 'hex-recompilability-resumable-retry/v1';

export const CASE_STATES = ['PASS', 'FAIL', 'TIMEOUT', 'CRASH', 'NOT_RUN'];
export const TERMINAL_STATES = ['PASS', 'FAIL', 'CRASH'];
export const DEFAULT_RETRY_STATES = ['NOT_RUN', 'TIMEOUT'];

const CASE_STATE_SET = new Set(CASE_STATES);

export function slug(caseId) {
  return Buffer.from(String(caseId)).toString('hex');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function hashManifest(manifest) {
  return createHash('sha256').update(stableStringify(manifest)).digest('hex');
}

function atomicWriteJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, text, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function caseFile(storeDir, caseId) {
  return path.join(storeDir, 'cases', `${slug(caseId)}.json`);
}

function readCaseRecord(storeDir, caseId) {
  const file = caseFile(storeDir, caseId);
  if (!fs.existsSync(file)) return { record: null, warning: null };
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.schema !== CASE_SCHEMA
      || record.caseId !== caseId
      || !CASE_STATE_SET.has(record.state)) {
      return { record: null, warning: { id: caseId, reason: 'case-result-invalid' } };
    }
    return { record, warning: null };
  } catch {
    return { record: null, warning: { id: caseId, reason: 'case-result-unreadable' } };
  }
}

/**
 * Open (or create) a measurement run directory.
 *
 * Throws `measurement-identity-mismatch` when the directory already holds
 * results recorded under a different manifest hash or source HEAD, so results
 * from different code/manifest versions can never be mixed.
 */
export function openRun({ storeDir, manifest, headSha }) {
  if (!storeDir || typeof storeDir !== 'string') throw new Error('measurement-store-dir-required');
  if (!manifest || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error('measurement-manifest-empty');
  }
  if (!/^[0-9a-f]{40,64}$/.test(headSha || '')) throw new Error('measurement-head-sha-invalid');
  const manifestSha256 = hashManifest(manifest);
  fs.mkdirSync(storeDir, { recursive: true });
  const runFile = path.join(storeDir, 'run.json');
  const now = new Date().toISOString();
  if (fs.existsSync(runFile)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    } catch {
      throw new Error('measurement-run-header-unreadable');
    }
    if (!existing || existing.schema !== RUN_SCHEMA) throw new Error('measurement-run-header-invalid');
    if (existing.manifestSha256 !== manifestSha256 || existing.headSha !== headSha) {
      throw new Error('measurement-identity-mismatch');
    }
    existing.updatedAt = now;
    atomicWriteJson(runFile, existing);
    return { ...existing, storeDir };
  }
  const run = {
    schema: RUN_SCHEMA,
    manifestSha256,
    headSha,
    denominator: manifest.cases.length,
    createdAt: now,
    updatedAt: now,
  };
  atomicWriteJson(runFile, run);
  return { ...run, storeDir };
}

function validateRunnerResult(caseId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { state: 'FAIL', reason: 'invalid-runner-verdict', functions: null };
  }
  const reason = value.reason == null ? null : String(value.reason);
  // Runners must report a measured verdict. The only accepted NOT_RUN is an
  // explicit input problem (e.g. missing/hash-mismatched binary), which keeps
  // the case retryable instead of failing the product for harness inputs.
  if (value.state === 'NOT_RUN') {
    if (reason?.startsWith('input-')) return { state: 'NOT_RUN', reason, functions: null };
    return { state: 'FAIL', reason: 'invalid-runner-verdict', functions: null };
  }
  if (!CASE_STATE_SET.has(value.state)) {
    return { state: 'FAIL', reason: 'invalid-runner-verdict', functions: null };
  }
  let functions = null;
  if (value.functions != null) {
    if (typeof value.functions !== 'object' || Array.isArray(value.functions)) {
      return { state: 'FAIL', reason: 'invalid-runner-verdict', functions: null };
    }
    const total = value.functions.total;
    if (!Number.isSafeInteger(total) || total < 0) {
      return { state: 'FAIL', reason: 'invalid-runner-verdict', functions: null };
    }
    functions = { total, states: value.functions.states ?? null, extra: value.functions.extra ?? null };
  }
  return { state: value.state, reason, functions };
}

/**
 * Measure every manifest case, resuming durable per-case records.
 *
 * `runCase` is `async (selectedCase) => ({ state, reason?, functions? })`.
 * The runner receives the caller-supplied selected case object when one was
 * provided (otherwise the manifest entry), so runners can carry resolved
 * input paths or other per-run context without changing the manifest.
 * A runner that throws is recorded as CRASH (completed work is preserved).
 * Cases already recorded with a terminal state outside `retryStates` are not
 * re-executed. Returns the summary object and writes `summary.json`.
 */
export async function measureCases({
  storeDir,
  manifest,
  cases = null,
  runCase,
  headSha,
  retryStates = DEFAULT_RETRY_STATES,
  onProgress = null,
} = {}) {
  if (typeof runCase !== 'function') throw new Error('measurement-runner-required');
  const retrySet = new Set(retryStates);
  for (const state of retrySet) {
    if (!CASE_STATE_SET.has(state)) throw new Error('measurement-retry-state-invalid');
  }
  const run = openRun({ storeDir, manifest, headSha });
  const selected = cases ?? manifest.cases;
  const selectedById = new Map(selected.map(entry => [entry.id, entry]));
  const selectedIds = new Set(selectedById.keys());

  const results = [];
  const warnings = [];
  for (const entry of manifest.cases) {
    const { record: existing, warning } = readCaseRecord(storeDir, entry.id);
    if (warning) warnings.push(warning);
    if (!selectedIds.has(entry.id)) {
      results.push(existing
        ? { id: entry.id, state: existing.state, reason: existing.reason ?? null, skipped: true }
        : { id: entry.id, state: 'NOT_RUN', reason: 'not-selected', skipped: true });
      continue;
    }
    if (existing && !retrySet.has(existing.state)) {
      results.push({ id: entry.id, state: existing.state, reason: existing.reason ?? null, skipped: true });
      if (typeof onProgress === 'function') onProgress({ id: entry.id, state: existing.state, resumed: true });
      continue;
    }
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let outcome;
    try {
      outcome = validateRunnerResult(entry.id, await runCase(selectedById.get(entry.id) ?? entry));
    } catch (error) {
      outcome = {
        state: 'CRASH',
        reason: `runner-throw:${String(error?.message || error).slice(0, 200)}`,
        functions: null,
      };
    }
    const finishedAt = new Date().toISOString();
    const previous = existing?.attempts ?? [];
    const record = {
      schema: CASE_SCHEMA,
      caseId: entry.id,
      state: outcome.state,
      reason: outcome.reason,
      functions: outcome.functions,
      headSha,
      manifestSha256: run.manifestSha256,
      attempts: [...previous, { startedAt, finishedAt, elapsedMs: Date.now() - startedMs }],
    };
    atomicWriteJson(caseFile(storeDir, entry.id), record);
    results.push({ id: entry.id, state: record.state, reason: record.reason, skipped: false });
    if (typeof onProgress === 'function') onProgress({ id: entry.id, state: record.state, resumed: false });
  }

  return writeSummary({ storeDir, manifest, headSha, extraWarnings: warnings });
}

/**
 * Recompute the summary from durable per-case records.
 *
 * The denominator is always the full manifest case count. Cases without a
 * readable record count as NOT_RUN. `complete` is true only when every case
 * holds a terminal state and no warnings exist.
 */
export function writeSummary({ storeDir, manifest, headSha, extraWarnings = [] } = {}) {
  const run = openRun({ storeDir, manifest, headSha });
  const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, CRASH: 0, NOT_RUN: 0 };
  const results = [];
  const warnings = [...extraWarnings];
  for (const entry of manifest.cases) {
    const { record, warning } = readCaseRecord(storeDir, entry.id);
    if (warning) warnings.push(warning);
    if (!record) {
      counts.NOT_RUN += 1;
      results.push({ id: entry.id, state: 'NOT_RUN', reason: 'result-missing' });
      continue;
    }
    counts[record.state] += 1;
    results.push({ id: entry.id, state: record.state, reason: record.reason ?? null });
  }
  const complete = counts.NOT_RUN === 0 && counts.TIMEOUT === 0 && warnings.length === 0;
  const summary = {
    schema: SUMMARY_SCHEMA,
    denominator: manifest.cases.length,
    complete,
    counts,
    warnings,
    headSha,
    manifestSha256: run.manifestSha256,
    finishedAt: new Date().toISOString(),
    results,
  };
  atomicWriteJson(path.join(storeDir, 'summary.json'), summary);
  return summary;
}

export function readSummary(storeDir) {
  const file = path.join(storeDir, 'summary.json');
  if (!fs.existsSync(file)) throw new Error('measurement-summary-missing');
  const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!summary || summary.schema !== SUMMARY_SCHEMA) throw new Error('measurement-summary-invalid');
  return summary;
}

/**
 * Build a retry manifest listing only retry-eligible cases (deduplicated).
 * Cases are eligible when their recorded state is in `retryStates`
 * (default NOT_RUN and TIMEOUT). Records are keyed by case id, so executing
 * a retry manifest twice cannot double-count.
 */
export function buildRetryManifest({ storeDir, manifest, headSha, retryStates = DEFAULT_RETRY_STATES } = {}) {
  const run = openRun({ storeDir, manifest, headSha });
  const retrySet = new Set(retryStates);
  const seen = new Set();
  const cases = [];
  for (const entry of manifest.cases) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const { record } = readCaseRecord(storeDir, entry.id);
    const state = record?.state ?? 'NOT_RUN';
    if (!retrySet.has(state)) continue;
    cases.push({ id: entry.id, lastState: state, reason: record?.reason ?? 'result-missing' });
  }
  const retry = {
    schema: RETRY_SCHEMA,
    fromManifestSha256: run.manifestSha256,
    headSha,
    retryStates: [...retrySet],
    denominator: manifest.cases.length,
    cases,
  };
  atomicWriteJson(path.join(storeDir, 'retry.json'), retry);
  return retry;
}

export function formatSummaryLine(summary) {
  const { PASS, FAIL, TIMEOUT, CRASH, NOT_RUN } = summary.counts;
  const status = summary.complete ? 'COMPLETE' : 'INCOMPLETE';
  return `${status} ${PASS}/${summary.denominator} PASS `
    + `(FAIL:${FAIL} TIMEOUT:${TIMEOUT} CRASH:${CRASH} NOT_RUN:${NOT_RUN})`;
}
