#!/usr/bin/env node
// Measurement only. No production import or API dependency is added to Hex.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const SOURCE = path.resolve(arg('--input', path.join(ROOT, 'reports/investigations/pinpoint-confidence-plan-a/current-main-p4/rows.jsonl')));
const CHECKPOINT = path.resolve(arg('--checkpoint', path.join(HERE, 'checkpoint')));
const MODE = arg('--mode', 'live');
const ARMS = (arg('--arms', 'label,class,evidence') || '').split(',').filter(Boolean);
const CONCURRENCY = Math.max(1, Math.min(8, Number(arg('--concurrency', '3'))));
const LIMIT = Math.max(0, Number(arg('--limit', '0')));
const TIMEOUT_MS = Math.max(1000, Math.min(60000, Number(arg('--timeout-ms', '15000'))));
const MODEL = 'openjev';
const ENDPOINT = 'https://api.openjev.sh/v1/systemone';
const rows = fs.readFileSync(SOURCE, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.kind === 'field');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const id = (r) => `${r.binary}|${r.mode}|${r.label}`;

function words(s) {
  return String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ').toLowerCase().trim().split(/\s+/).filter(Boolean);
}

// Frozen, corpus-agnostic offline lexical comparator. Never uses truth labels.
function deterministicChoice(r) {
  const q = words(r.label);
  const scored = r.candidates.map((c, i) => {
    const f = words(c.fieldName); const cls = words(c.className);
    const match = q.filter((w) => f.includes(w)).length;
    const coverage = q.length ? match / q.length : 0;
    const suffix = q.length && f.slice(-q.length).join(' ') === q.join(' ') ? 1 : 0;
    const exact = f.join(' ') === q.join(' ') ? 1 : 0;
    const classMatch = q.filter((w) => cls.includes(w)).length;
    return { i, score: 2 * exact + 0.6 * suffix + coverage + 0.05 * classMatch - 0.015 * Math.max(0, f.length - q.length) };
  }).sort((a, b) => b.score - a.score || a.i - b.i);
  // A conservative rule only overrides when the lexical advantage is large.
  return scored.length > 1 && scored[0].score - scored[1].score >= 0.7 ? scored[0].i : 0;
}

function candidateDescription(c, arm) {
  if (arm === 'label') return String(c.fieldName || 'unnamed field');
  const base = `${c.className || 'unknown class'} :: ${c.fieldName || 'unnamed field'}`;
  if (arm === 'class') return base;
  const evidence = (c.evidence || []).map((x) => `${x.code}:${x.group}`).slice(0, 8).join(', ');
  const f = c.fusion || {};
  return `${base}; binary evidence=${evidence || 'none'}; groups=${(f.groups || []).join('+') || 'none'}; verified=${f.verified || 0}`;
}

function requestBody(r, arm) {
  const criteria = Object.fromEntries(r.candidates.map((c, i) => [`c${i}`, candidateDescription(c, arm)]));
  return {
    model: MODEL,
    state: { userPhrase: r.label, queryKind: r.mode, candidateDescriptionsAreBinaryDerived: true },
    questions: {
      pick: { type: 'choice', instructions: 'Pick the existing field most likely to be the remembered target of the user phrase. This is a forced ranking preference, not proof. Use only listed candidate IDs.', criteria },
      unique: { type: 'noul', instructions: 'Does the user phrase uniquely identify one of these candidates without additional context?', criteria: { true: 'The phrase distinguishes one field', false: 'Several fields plausibly fit' } },
    },
  };
}

function validate(body, response, n) {
  if (response?.model !== MODEL) return 'model-mismatch';
  const pick = response?.answers?.pick;
  const unique = response?.answers?.unique;
  if (pick?.type !== 'choice' || !/^c\d+$/.test(pick.choice || '')) return 'malformed-choice';
  const index = Number(pick.choice.slice(1));
  if (!Number.isInteger(index) || index < 0 || index >= n) return 'invalid-candidate';
  if (!pick.probabilities || !Number.isFinite(pick.probabilities[pick.choice]) || !Number.isFinite(pick.confidence)) return 'missing-probability';
  if (unique?.type !== 'noul' || !Number.isFinite(unique.noul) || unique.noul < 0 || unique.noul > 1) return 'malformed-unique';
  return null;
}

function safeWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.pending`;
  fs.writeFileSync(pending, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(pending, file);
}

async function liveOne(r, arm) {
  const rowId = id(r);
  const body = requestBody(r, arm);
  const bodyHash = sha(JSON.stringify(body));
  const file = path.join(CHECKPOINT, `${sha(`${rowId}|${arm}`)}.json`);
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.bodyHash !== bodyHash || saved.rowId !== rowId || saved.arm !== arm) throw new Error(`checkpoint mismatch: ${file}`);
    return saved;
  }
  if (!process.env.OPENJEV_API_KEY) {
    const result = { schema: 'hex-jev-live-ranking/v1', rowId, arm, bodyHash,
      status: null, error: 'missing-key', latencyMs: 0, model: null,
      choice: 0, preference: null, confidence: null, unique: null,
      usage: null, fallback: 1 };
    safeWrite(file, result);
    return result;
  }
  const started = performance.now();
  let status = null, response = null, error = null;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENJEV_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    const payload = await res.json();
    if (!res.ok) error = `http-${status}`;
    else { error = validate(body, payload, r.candidates.length); if (!error) response = payload; }
  } catch (e) { error = e?.name === 'TimeoutError' ? 'timeout' : 'network-or-json'; }
  const result = {
    schema: 'hex-jev-live-ranking/v1', rowId, arm, bodyHash, status, error,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
    model: response?.model || null,
    choice: response ? Number(response.answers.pick.choice.slice(1)) : 0,
    preference: response?.answers?.pick?.probabilities?.[response.answers.pick.choice] ?? null,
    confidence: response?.answers?.pick?.confidence ?? null,
    unique: response?.answers?.unique?.noul ?? null,
    usage: response?.usage || null,
    fallback: error ? 1 : 0,
  };
  safeWrite(file, result);
  return result;
}

async function main() {
  if (rows.length !== 426) throw new Error(`expected 426 field rows, got ${rows.length}`);
  if (MODE === 'live') {
    const partial = rows.filter((r) => r.mode === 'partial');
    const selected = LIMIT ? partial.slice(0, LIMIT) : partial;
    const jobs = selected.flatMap((r) => ARMS.map((arm) => ({ r, arm })));
    let cursor = 0, completed = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < jobs.length) {
        const { r, arm } = jobs[cursor++];
        await liveOne(r, arm);
        if (++completed % 25 === 0) process.stdout.write(`${completed}/${jobs.length} completed\n`);
      }
    }));
    process.stdout.write(`done: ${completed} requests\n`);
  } else if (MODE === 'selftest') {
    const r = rows.find((x) => x.mode === 'partial');
    const body = requestBody(r, 'label');
    const valid = { model: MODEL, answers: {
      pick: { type: 'choice', choice: 'c0', probabilities: { c0: 1 }, confidence: .5 },
      unique: { type: 'noul', noul: .2 },
    } };
    assert.equal(validate(body, valid, r.candidates.length), null);
    assert.equal(validate(body, { ...valid, model: 'wrong' }, r.candidates.length), 'model-mismatch');
    assert.equal(validate(body, { ...valid, answers: { ...valid.answers,
      pick: { ...valid.answers.pick, choice: 'c99999' } } }, r.candidates.length), 'invalid-candidate');
    assert.equal(validate(body, { ...valid, answers: { ...valid.answers,
      pick: { ...valid.answers.pick, probabilities: {} } } }, r.candidates.length), 'missing-probability');
    assert.equal(validate(body, { ...valid, answers: { ...valid.answers,
      unique: { type: 'noul', noul: 2 } } }, r.candidates.length), 'malformed-unique');
    process.stdout.write('live adapter validation: 5/5 response cases\n');
  } else if (MODE === 'summarize') {
    const outRows = rows.map((r) => {
      const rowId = id(r); const detIndex = deterministicChoice(r);
      const jev = Object.fromEntries(['label', 'class', 'evidence'].map((arm) => {
        const file = path.join(CHECKPOINT, `${sha(`${rowId}|${arm}`)}.json`);
        return [arm, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null];
      }));
      return {
        id: rowId, binary: r.binary, mode: r.mode, query: r.label,
        truthKey: `${r.expectedClass}#${r.expectedField}`, baselineTopKey: r.candidates[0]?.key,
        truthRank: r.truthRank, candidateCount: r.candidateCount, candidatePresent: r.candidatePresent,
        baselineCorrect: r.topCorrect, verdict: r.p4Verdict, probability: r.probability,
        evidenceGroups: r.groups, analyzeCalls: r.analyzeCalls, baselineLatencyMs: r.latencyMs,
        deterministicIndex: detIndex, deterministicCorrect: !!r.candidates[detIndex]?.truth,
        jev: Object.fromEntries(Object.entries(jev).map(([arm, x]) => [arm, x && {
          choiceIndex: x.choice, selectedKey: x.choice == null ? null : r.candidates[x.choice]?.key,
          correct: x.choice == null ? r.topCorrect : !!r.candidates[x.choice]?.truth,
          error: x.error, status: x.status, latencyMs: x.latencyMs,
          confidence: x.confidence, unique: x.unique,
        }])),
        candidates: r.candidates.map((c) => ({ key: c.key, className: c.className, fieldName: c.fieldName, rank: c.rank,
          truth: c.truth, recallLane: c.recallLane, evidenceCodes: (c.evidence || []).map((e) => e.code),
          groups: c.fusion?.groups || [], score: c.fusion?.logOdds || 0 })),
      };
    });
    fs.writeFileSync(path.join(HERE, 'rows.jsonl'), outRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    process.stdout.write(`wrote ${outRows.length} rows\n`);
  } else throw new Error(`unknown mode ${MODE}`);
}

await main();
