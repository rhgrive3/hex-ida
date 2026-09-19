/** Resumable measurement harness for G direct recompilability. */
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
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export function slug(caseId) { return Buffer.from(String(caseId)).toString('hex'); }
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
export function hashManifest(manifest) { return createHash('sha256').update(stableStringify(manifest)).digest('hex'); }

function atomicWriteJson(file, value) {
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temp, file);
}
function caseFile(storeDir, id) { return path.join(storeDir, 'cases', `${slug(id)}.json`); }
function lockFile(storeDir) { return path.join(storeDir, '.writer.lock'); }
function acquireWriterLock(storeDir) {
  fs.mkdirSync(storeDir, { recursive: true });
  const file = lockFile(storeDir);
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: process.env.HOSTNAME || null, createdAt: new Date().toISOString() }));
    fs.closeSync(fd);
    return file;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let stale = false;
    try { stale = Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS; } catch {}
    // Never steal a stale-looking lock automatically. A stat→unlink→create
    // recovery has an unavoidable TOCTOU window where one contender can delete
    // another contender's freshly-created lock and admit two writers.
    // Preserve the lock and fail closed; operators can remove a known-orphaned
    // lock explicitly before resuming the durable run.
    if (stale) throw new Error('measurement-writer-stale-lock');
    throw new Error('measurement-writer-busy');
  }
}
function releaseWriterLock(file) { try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
function withWriterLock(storeDir, fn) {
  const lock = acquireWriterLock(storeDir);
  return Promise.resolve().then(fn).finally(() => releaseWriterLock(lock));
}
function readCaseRecord(storeDir, id) {
  const file = caseFile(storeDir, id);
  if (!fs.existsSync(file)) return { record: null, warning: null };
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.schema !== CASE_SCHEMA || record.caseId !== id || !CASE_STATE_SET.has(record.state)) return { record: null, warning: { id, reason: 'case-result-invalid' } };
    return { record, warning: null };
  } catch { return { record: null, warning: { id, reason: 'case-result-unreadable' } }; }
}
function validateManifestCaseIds(manifest) {
  const seen = new Set();
  for (const entry of manifest.cases) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) throw new Error('measurement-manifest-case-id-invalid');
    if (seen.has(entry.id)) throw new Error(`measurement-manifest-duplicate-case-id:${entry.id}`);
    seen.add(entry.id);
  }
}
export function openRun({ storeDir, manifest, headSha }) {
  if (!storeDir || typeof storeDir !== 'string') throw new Error('measurement-store-dir-required');
  if (!manifest || !Array.isArray(manifest.cases) || manifest.cases.length === 0) throw new Error('measurement-manifest-empty');
  validateManifestCaseIds(manifest);
  if (!/^[0-9a-f]{40,64}$/.test(headSha || '')) throw new Error('measurement-head-sha-invalid');
  const manifestSha256 = hashManifest(manifest);
  fs.mkdirSync(storeDir, { recursive: true });
  const runFile = path.join(storeDir, 'run.json');
  const now = new Date().toISOString();
  if (fs.existsSync(runFile)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch { throw new Error('measurement-run-header-unreadable'); }
    if (!existing || existing.schema !== RUN_SCHEMA) throw new Error('measurement-run-header-invalid');
    if (existing.manifestSha256 !== manifestSha256 || existing.headSha !== headSha) throw new Error('measurement-identity-mismatch');
    existing.updatedAt = now;
    atomicWriteJson(runFile, existing);
    return { ...existing, storeDir };
  }
  const run = { schema: RUN_SCHEMA, manifestSha256, headSha, denominator: manifest.cases.length, createdAt: now, updatedAt: now };
  atomicWriteJson(runFile, run);
  return { ...run, storeDir };
}
function validateRunnerResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'FAIL', reason: 'invalid-runner-verdict', functions: null };
  const reason = value.reason == null ? null : String(value.reason);
  if (value.state === 'NOT_RUN' && !reason?.startsWith('input-')) return { state: 'FAIL', reason: 'invalid-runner-verdict', functions: null };
  if (!CASE_STATE_SET.has(value.state)) return { state: 'FAIL', reason: 'invalid-runner-verdict', functions: null };
  let functions = null;
  if (value.functions != null) {
    if (typeof value.functions !== 'object' || Array.isArray(value.functions) || !Number.isSafeInteger(value.functions.total) || value.functions.total < 0) return { state: 'FAIL', reason: 'invalid-runner-verdict', functions: null };
    functions = { total: value.functions.total, states: value.functions.states ?? null, extra: value.functions.extra ?? null };
  }
  return { state: value.state, reason, functions };
}
export async function measureCases({ storeDir, manifest, cases = null, runCase, headSha, retryStates = DEFAULT_RETRY_STATES, onProgress = null } = {}) {
  if (typeof runCase !== 'function') throw new Error('measurement-runner-required');
  const retrySet = new Set(retryStates);
  for (const state of retrySet) if (!CASE_STATE_SET.has(state)) throw new Error('measurement-retry-state-invalid');
  return withWriterLock(storeDir, async () => {
    const run = openRun({ storeDir, manifest, headSha });
    const selected = cases ?? manifest.cases;
    const selectedById = new Map(selected.map(entry => [entry.id, entry]));
    const selectedIds = new Set(selectedById.keys());
    const warnings = [];
    for (const entry of manifest.cases) {
      const { record: existing, warning } = readCaseRecord(storeDir, entry.id);
      if (warning) warnings.push(warning);
      if (!selectedIds.has(entry.id) || (existing && !retrySet.has(existing.state))) { if (existing && typeof onProgress === 'function') onProgress({ id: entry.id, state: existing.state, resumed: true }); continue; }
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      let outcome;
      try { outcome = validateRunnerResult(await runCase(selectedById.get(entry.id) ?? entry)); } catch (error) { outcome = { state: 'CRASH', reason: `runner-throw:${String(error?.message || error).slice(0, 200)}`, functions: null }; }
      const record = { schema: CASE_SCHEMA, caseId: entry.id, state: outcome.state, reason: outcome.reason, functions: outcome.functions, headSha, manifestSha256: run.manifestSha256, attempts: [...(existing?.attempts ?? []), { startedAt, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedMs }] };
      atomicWriteJson(caseFile(storeDir, entry.id), record);
      if (typeof onProgress === 'function') onProgress({ id: entry.id, state: record.state, resumed: false });
    }
    return writeSummaryUnlocked({ storeDir, manifest, headSha, extraWarnings: warnings });
  });
}
function writeSummaryUnlocked({ storeDir, manifest, headSha, extraWarnings = [] }) {
  const run = openRun({ storeDir, manifest, headSha });
  const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, CRASH: 0, NOT_RUN: 0 };
  const results = []; const warnings = [...extraWarnings];
  for (const entry of manifest.cases) {
    const { record, warning } = readCaseRecord(storeDir, entry.id);
    if (warning) warnings.push(warning);
    if (!record) { counts.NOT_RUN += 1; results.push({ id: entry.id, state: 'NOT_RUN', reason: 'result-missing' }); continue; }
    counts[record.state] += 1; results.push({ id: entry.id, state: record.state, reason: record.reason ?? null });
  }
  const summary = { schema: SUMMARY_SCHEMA, denominator: manifest.cases.length, complete: counts.NOT_RUN === 0 && counts.TIMEOUT === 0 && warnings.length === 0, counts, warnings, headSha, manifestSha256: run.manifestSha256, finishedAt: new Date().toISOString(), results };
  atomicWriteJson(path.join(storeDir, 'summary.json'), summary);
  return summary;
}
export function writeSummary(args = {}) { return withWriterLock(args.storeDir, () => writeSummaryUnlocked(args)); }
export function readSummary(storeDir) { const file = path.join(storeDir, 'summary.json'); if (!fs.existsSync(file)) throw new Error('measurement-summary-missing'); const summary = JSON.parse(fs.readFileSync(file, 'utf8')); if (!summary || summary.schema !== SUMMARY_SCHEMA) throw new Error('measurement-summary-invalid'); return summary; }
export function buildRetryManifest({ storeDir, manifest, headSha, retryStates = DEFAULT_RETRY_STATES } = {}) {
  const run = openRun({ storeDir, manifest, headSha }); const retrySet = new Set(retryStates); const cases = [];
  for (const entry of manifest.cases) { const { record } = readCaseRecord(storeDir, entry.id); const state = record?.state ?? 'NOT_RUN'; if (retrySet.has(state)) cases.push({ id: entry.id, lastState: state, reason: record?.reason ?? 'result-missing' }); }
  const retry = { schema: RETRY_SCHEMA, fromManifestSha256: run.manifestSha256, headSha, retryStates: [...retrySet], denominator: manifest.cases.length, cases };
  atomicWriteJson(path.join(storeDir, 'retry.json'), retry); return retry;
}
export function formatSummaryLine(summary) { const { PASS, FAIL, TIMEOUT, CRASH, NOT_RUN } = summary.counts; return `${summary.complete ? 'COMPLETE' : 'INCOMPLETE'} ${PASS}/${summary.denominator} PASS (FAIL:${FAIL} TIMEOUT:${TIMEOUT} CRASH:${CRASH} NOT_RUN:${NOT_RUN})`; }
