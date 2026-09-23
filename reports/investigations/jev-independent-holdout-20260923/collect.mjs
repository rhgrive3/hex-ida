#!/usr/bin/env node
// One-shot, blind holdout collector. This file never reads gold labels.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const EVIDENCE = '/mnt/workspace/.dev-state/agent-work/evidence/jev-holdout-20260923';
const FIXTURES = '/mnt/workspace/.dev-state/agent-work/cache/pinpoint-jev-probe-audit-20260923/tests';
const ENDPOINT = 'https://api.openjev.sh/v1/systemone';
const MODEL = 'openjev';
const TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 2; // initial attempt + one identical-body technical retry
const sha256 = (x) => createHash('sha256').update(x).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.pending`;
  fs.writeFileSync(pending, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(pending, file);
}

function assertPersistent() {
  const resolved = fs.realpathSync(EVIDENCE);
  if (!resolved.startsWith('/mnt/workspace/.dev-state/agent-work/evidence/')) throw new Error('evidence destination is not persistent');
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    const value = process.env[key];
    if (value !== '/mnt/workspace/.dev-state/agent-work/scratch') throw new Error(`${key} must be persistent agent scratch`);
  }
}

function words(s) {
  return String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ').toLowerCase().trim().split(/\s+/).filter(Boolean);
}

function g28Eligible(mode, verdict, candidateCount, deterministicIndex) {
  return mode === "partial" && ["confirmed", "likely"].includes(verdict)
    && candidateCount > 0 && deterministicIndex === 0;
}

function deterministicChoice(row) {
  const q = words(row.query);
  const ranked = row.candidates.map((c, i) => {
    const f = words(c.fieldName);
    const match = q.filter((w) => f.includes(w)).length;
    const suffix = q.length && f.slice(-q.length).join(' ') === q.join(' ') ? 1 : 0;
    const extra = Math.max(0, f.length - match);
    return { i, score: match * 10 + 0.5 * extra + 2 * suffix - i * 1e-5 };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.i ?? null;
}

function requestBody(row) {
  const criteria = Object.fromEntries(row.candidates.map((c, i) => [`c${i}`, String(c.fieldName || 'unnamed field')]));
  return {
    model: MODEL,
    state: { userPhrase: row.query, queryKind: row.mode, candidateDescriptionsAreBinaryDerived: true },
    questions: {
      pick: { type: 'choice', instructions: 'Pick the existing field most likely to be the remembered target of the user phrase. This is a forced ranking preference, not proof. Use only listed candidate IDs.', criteria },
      unique: { type: 'noul', instructions: 'Does the user phrase uniquely identify one of these candidates without additional context?', criteria: { true: 'The phrase distinguishes one field', false: 'Several fields plausibly fit' } },
    },
  };
}

function validateResponse(response, count) {
  if (response?.model !== MODEL) return 'model-mismatch';
  const pick = response?.answers?.pick;
  const unique = response?.answers?.unique;
  if (pick?.type !== 'choice' || !/^c\d+$/.test(pick.choice || '')) return 'malformed-choice';
  const index = Number(pick.choice.slice(1));
  if (!Number.isInteger(index) || index < 0 || index >= count) return 'invalid-candidate';
  if (!pick.probabilities || !Number.isFinite(pick.probabilities[pick.choice]) || !Number.isFinite(pick.confidence)) return 'missing-probability';
  if (unique?.type !== 'noul' || !Number.isFinite(unique.noul) || unique.noul < 0 || unique.noul > 1) return 'malformed-unique';
  return null;
}

async function callJev(row) {
  const body = requestBody(row);
  const bodyHash = sha256(JSON.stringify(body));
  const attempts = [];
  for (let number = 1; number <= MAX_ATTEMPTS; number++) {
    const started = performance.now();
    let status = null, payload = null, error = null;
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.OPENJEV_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
      if (!response.ok) error = `http-${status}`;
      else {
        try { payload = await response.json(); }
        catch { error = 'invalid-json'; }
        if (!error) error = validateResponse(payload, row.candidates.length);
      }
    } catch (e) { error = e?.name === 'TimeoutError' ? 'timeout' : 'network'; }
    const latencyMs = Math.round((performance.now() - started) * 100) / 100;
    attempts.push({ number, status, error, latencyMs });
    if (!error) {
      const choice = Number(payload.answers.pick.choice.slice(1));
      return { bodyHash, attempts, error: null, choiceIndex: choice,
        selectedKey: row.candidates[choice].key, confidence: payload.answers.pick.confidence,
        preference: payload.answers.pick.probabilities[payload.answers.pick.choice],
        unique: payload.answers.unique.noul, usage: payload.usage ?? null, model: payload.model };
    }
    const retryable = error === 'timeout' || error === 'network' || status === 429 || (status >= 500 && status <= 599);
    if (!retryable) break;
  }
  return { bodyHash, attempts, error: attempts.at(-1).error, choiceIndex: null,
    selectedKey: null, confidence: null, preference: null, unique: null, usage: null, model: null };
}

async function main() {
  assertPersistent();
  const mode = process.argv[2];
  const freeze = readJson(path.join(HERE, 'freeze-manifest.json'));
  const holdout = readJson(path.join(HERE, 'holdout-manifest.json'));
  const casesFile = path.join(HERE, 'holdout-cases.json');
  const blindFile = path.join(HERE, 'blind-input.json');
  if (mode === '--prepare') {
    const bytes = fs.readFileSync(casesFile);
    if (sha256(bytes) !== holdout.caseSha256) throw new Error('locked holdout cases hash mismatch');
    const cases = JSON.parse(bytes);
    if (cases.length !== holdout.totalCases) throw new Error('locked case count mismatch');
    const blind = { schema: 'hex-jev-blind-input/v1', caseSha256: holdout.caseSha256,
      productCommit: freeze.productCommit,
      cases: cases.map(({ id, binary, mode: queryMode, query }) => ({ id, binary, mode: queryMode, query })) };
    atomicJson(blindFile, blind);
    console.log(`prepared ${blind.cases.length} blind cases`);
    return;
  }
  if (mode !== '--collect') throw new Error('usage: collect.mjs --prepare|--collect');
  if (!process.env.OPENJEV_API_KEY) throw new Error('OPENJEV_API_KEY missing; no evaluation started');
  const blind = readJson(blindFile);
  if (blind.caseSha256 !== holdout.caseSha256 || blind.productCommit !== freeze.productCommit) throw new Error('blind input lock mismatch');
  if (fs.existsSync(path.join(EVIDENCE, 'run-complete.json'))) throw new Error('holdout already completed; rerun forbidden');
  const checkout = freeze.executionCheckout;
  if (path.resolve(checkout) !== '/mnt/workspace/.dev-state/agent-work/checkouts/jev-holdout-20260923/product') throw new Error('unexpected product checkout');
  const { execFileSync } = await import('node:child_process');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
  if (commit !== freeze.productCommit) throw new Error('product commit moved');
  for (const [relative, expected] of Object.entries(freeze.sourceSha256)) {
    const actual = sha256(fs.readFileSync(path.join(checkout, relative)));
    if (actual !== expected) throw new Error(`frozen source changed: ${relative}`);
  }
  const { openBinary } = await import(pathToFileURL(path.join(checkout, 'tests/harness.mjs')).href);
  const { pinpointField } = await import(pathToFileURL(path.join(checkout, 'js/pinpoint.js')).href);
  const { parseGoal } = await import(pathToFileURL(path.join(checkout, 'js/goals.js')).href);
  const startFile = path.join(EVIDENCE, 'run-start.json');
  const runIdentity = { schema: 'hex-jev-run-start/v1', productCommit: commit,
    caseSha256: blind.caseSha256, freezeSha256: sha256(fs.readFileSync(path.join(HERE, 'freeze-manifest.json'))),
    collectorSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))) };
  if (fs.existsSync(startFile)) {
    const saved = readJson(startFile);
    for (const key of Object.keys(runIdentity)) if (saved[key] !== runIdentity[key]) throw new Error(`resume identity mismatch: ${key}`);
  } else atomicJson(startFile, { ...runIdentity, startedAtUtc: new Date().toISOString() });
  const worlds = new Map();
  const worldFor = async (binary) => {
    if (!['battlecats', 'TsumTsum', 'YWP'].includes(binary)) throw new Error(`unknown binary ${binary}`);
    if (!worlds.has(binary)) worlds.set(binary, await openBinary(path.join(FIXTURES, binary), { log: () => {} }));
    return worlds.get(binary);
  };
  const rows = [];
  for (const c of blind.cases) {
    const checkpoint = path.join(EVIDENCE, 'blind-checkpoints', `${c.id}.json`);
    if (fs.existsSync(checkpoint)) {
      const saved = readJson(checkpoint);
      if (saved.id !== c.id || saved.query !== c.query || saved.mode !== c.mode || saved.binary !== c.binary) throw new Error(`checkpoint mismatch: ${c.id}`);
      rows.push(saved);
      continue;
    }
    const started = performance.now();
    const row = { schema: 'hex-jev-blind-result/v1', id: c.id, binary: c.binary, mode: c.mode, query: c.query,
      baseline: null, deterministic: null, routing: null, jev: null, collectionError: null };
    try {
      const goal = parseGoal(c.query);
      if (!goal) row.collectionError = 'unparseable-goal';
      else {
        const w = await worldFor(c.binary);
        const res = await pinpointField({ goal, fields: w.fields, program: w.program, symbols: w.symbols,
          strings: w.strings, analyze: w.analyze, scanAccess: w.scanAccess, limit: 400 });
        row.baseline = { verdict: res?.verdict ?? 'none', candidateCount: res?.candidates?.length ?? 0,
          candidates: (res?.candidates || []).map((x, index) => ({ index, key: x.key ?? null,
            className: x.className ?? null, fieldName: x.field?.name ?? null })),
          latencyMs: Math.round((performance.now() - started) * 100) / 100 };
        row.deterministic = { choiceIndex: c.mode === 'partial' ? deterministicChoice({ query: c.query, candidates: row.baseline.candidates })
          : (row.baseline.candidates.length ? 0 : null) };
        row.routing = { eligible: g28Eligible(c.mode, row.baseline.verdict, row.baseline.candidates.length, row.deterministic.choiceIndex),
          reason: null };
        row.routing.reason = row.routing.eligible ? 'G28-strong-and-det-retains-baseline' :
          c.mode !== 'partial' ? 'exact-query' : !['confirmed', 'likely'].includes(row.baseline.verdict) ? 'not-strong' :
            !row.baseline.candidates.length ? 'no-candidate' : 'deterministic-changed-top1';
        if (c.mode === 'partial' && row.baseline.candidates.length) row.jev = await callJev({ ...c, candidates: row.baseline.candidates });
      }
    } catch (e) { row.collectionError = String(e?.message || e).slice(0, 300); }
    if (!row.baseline) row.baseline = { verdict: 'none', candidateCount: 0, candidates: [],
      latencyMs: Math.round((performance.now() - started) * 100) / 100 };
    if (!row.deterministic) row.deterministic = { choiceIndex: null };
    if (!row.routing) row.routing = { eligible: false, reason: 'collection-error' };
    atomicJson(checkpoint, row);
    rows.push(row);
    console.log(`${rows.length}/${blind.cases.length} ${c.id} collected`);
  }
  if (rows.length !== blind.cases.length) throw new Error('incomplete blind collection');
  const raw = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const pending = path.join(EVIDENCE, 'blind-results.jsonl.pending');
  fs.writeFileSync(pending, raw, { mode: 0o600 });
  fs.renameSync(pending, path.join(EVIDENCE, 'blind-results.jsonl'));
  atomicJson(path.join(EVIDENCE, 'run-complete.json'), { ...runIdentity,
    completedAtUtc: new Date().toISOString(), rows: rows.length,
    blindResultsSha256: sha256(Buffer.from(raw)) });
  console.log(`blind collection complete: ${rows.length} rows`);
}

export { deterministicChoice, g28Eligible, requestBody, validateResponse };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
