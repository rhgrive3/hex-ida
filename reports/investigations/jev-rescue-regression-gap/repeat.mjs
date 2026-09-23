#!/usr/bin/env node
// Repeated-call stability probe: all REGRESSION candidates, RESCUE sample,
// and gate-boundary rows. Writes one file per (row, arm, attempt) under --out.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const SOURCE = path.resolve(arg('--input', path.join(HERE, 'current-main-baseline-rows.jsonl')));
const OUT = path.resolve(arg('--out', path.join(HERE, 'repeated-checkpoint')));
const LIST = path.resolve(arg('--list', path.join(HERE, 'repeat-targets.json')));
const ATTEMPTS = Math.max(1, Math.min(10, Number(arg('--attempts', '5'))));
const CONCURRENCY = Math.max(1, Math.min(6, Number(arg('--concurrency', '3'))));
const TIMEOUT_MS = Math.max(1000, Math.min(60000, Number(arg('--timeout-ms', '15000'))));
const MODEL = 'openjev';
const ENDPOINT = 'https://api.openjev.sh/v1/systemone';

const rows = fs.readFileSync(SOURCE, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.kind === 'field');
const byId = new Map(rows.map((r) => [`${r.binary}|${r.mode}|${r.label}`, r]));
const targets = JSON.parse(fs.readFileSync(LIST, 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex');

function candidateDescription(c) { return String(c.fieldName || 'unnamed field'); }
function requestBody(r) {
  const criteria = Object.fromEntries(r.candidates.map((c, i) => [`c${i}`, candidateDescription(c)]));
  return {
    model: MODEL,
    state: { userPhrase: r.label, queryKind: r.mode, candidateDescriptionsAreBinaryDerived: true },
    questions: {
      pick: { type: 'choice', instructions: 'Pick the existing field most likely to be the remembered target of the user phrase. This is a forced ranking preference, not proof. Use only listed candidate IDs.', criteria },
      unique: { type: 'noul', instructions: 'Does the user phrase uniquely identify one of these candidates without additional context?', criteria: { true: 'The phrase distinguishes one field', false: 'Several fields plausibly fit' } },
    },
  };
}
function validate(response, n) {
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

async function attempt(rowId, arm, attempt) {
  const r = byId.get(rowId);
  if (!r) throw new Error(`unknown row ${rowId}`);
  const body = requestBody(r);
  const bodyHash = sha(JSON.stringify(body));
  const file = path.join(OUT, `${sha(`${rowId}|${arm}|${attempt}`)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!process.env.OPENJEV_API_KEY) throw new Error('OPENJEV_API_KEY required');
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
    else { error = validate(payload, r.candidates.length); if (!error) response = payload; }
  } catch (e) { error = e?.name === 'TimeoutError' ? 'timeout' : 'network-or-json'; }
  const result = {
    schema: 'hex-jev-repeated-ranking/v1', rowId, arm, attempt, bodyHash, status, error,
    latencyMs: error ? null : Math.round((performance.now() - started) * 100) / 100,
    model: response?.model || null,
    choice: response ? Number(response.answers.pick.choice.slice(1)) : null,
    preference: response?.answers?.pick?.probabilities?.[response.answers.pick.choice] ?? null,
    confidence: response?.answers?.pick?.confidence ?? null,
    unique: response?.answers?.unique?.noul ?? null,
    fallback: error ? 1 : 0,
  };
  safeWrite(file, result);
  return result;
}

async function main() {
  const jobs = [];
  for (const t of targets) {
    for (let a = 1; a <= ATTEMPTS; a++) jobs.push({ rowId: t.id, arm: t.arm || 'label', attempt: a });
  }
  let cursor = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < jobs.length) {
      const j = jobs[cursor++];
      await attempt(j.rowId, j.arm, j.attempt);
      if (++done % 20 === 0) process.stdout.write(`${done}/${jobs.length}\n`);
    }
  }));
  process.stdout.write(`repeated-call jobs done: ${done}\n`);
}
await main();
