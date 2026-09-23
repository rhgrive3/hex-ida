#!/usr/bin/env node
// Small compiler-binary screening experiment; never a production gate.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(HERE, 'field-role-cases.json'), 'utf8')).cases;
const OUTPUT = path.resolve(process.argv[2] || path.join(HERE, 'field-role-results.json'));
const endpoint = 'https://api.openjev.sh/v1/systemone';
const roles = {
  health: 'hit points or health resource', counter: 'incrementing count', state: 'general object state',
  object_reference: 'pointer or reference to another object', speed: 'movement rate or speed',
  boolean_flag: 'true/false state flag', ammo: 'ammunition count', text: 'character or text storage',
  unknown: 'binary facts do not distinguish a semantic role',
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const percentile = (a, p) => a.length ? a[Math.ceil(p * a.length) - 1] : null;
const deterministic = (c, arm) => {
  const s = (arm === 'crossFunction' ? c.crossFunction : c.facts).join(' ').toLowerCase();
  if (/readhealth|takedamage/.test(s)) return 'health';
  if (/readtarget/.test(s)) return 'object_reference';
  if (/readspeed/.test(s)) return 'speed';
  if (/readnamechar/.test(s)) return 'text';
  if (/isalive/.test(s)) return 'boolean_flag';
  if (/incremented by one/.test(s)) return 'counter';
  if (/floating-point/.test(s)) return 'speed';
  if (/masked by one/.test(s)) return 'boolean_flag';
  if (/ascii p.*zero/.test(s)) return 'text';
  return 'unknown';
};

async function evaluate(c, arm) {
  const state = { objectAndOffset: c.id, binaryFacts: c.facts,
    ...(arm === 'crossFunction' ? { crossFunctionFacts: c.crossFunction } : {}) };
  const body = { model: 'openjev', state, questions: {
    role: { type: 'choice', instructions: 'Classify the semantic role only from the binary facts. Choose unknown when facts do not distinguish a role. No option is a confirmed source-level name.', criteria: roles },
  } };
  const started = performance.now();
  let result = { choice: null, confidence: null, error: null, status: null };
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: {
      authorization: `Bearer ${process.env.OPENJEV_API_KEY}`, 'content-type': 'application/json',
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    result.status = response.status;
    const data = await response.json();
    if (!response.ok) result.error = `http-${response.status}`;
    else if (data?.model !== 'openjev' || data?.answers?.role?.type !== 'choice'
      || !(data.answers.role.choice in roles) || !Number.isFinite(data.answers.role.confidence)) result.error = 'malformed';
    else { result.choice = data.answers.role.choice; result.confidence = data.answers.role.confidence; }
  } catch (e) { result.error = e?.name === 'TimeoutError' ? 'timeout' : 'network-or-json'; }
  return { id: c.id, arm, expected: c.expected, supported: c.supported,
    deterministic: deterministic(c, arm), ...result,
    latencyMs: Math.round((performance.now() - started) * 100) / 100 };
}

if (!process.env.OPENJEV_API_KEY) throw new Error('OPENJEV_API_KEY absent');
const results = [];
for (const c of cases) for (const arm of ['local', 'crossFunction']) results.push(await evaluate(c, arm));
const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const output = { schema: 'hex-jev-field-role-results/v1', model: 'openjev', endpoint,
  fixtureSourceSha256: sha(fs.readFileSync(path.resolve(HERE, '../../../tests/phase7/cxx/fixtures/game.cpp'))),
  cases: cases.length, calls: results.length,
  supportedCases: cases.filter((c) => c.supported).length,
  latencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95), p99: percentile(latencies, .99) },
  results };
const pending = `${OUTPUT}.${process.pid}.pending`;
fs.writeFileSync(pending, JSON.stringify(output, null, 2) + '\n');
fs.renameSync(pending, OUTPUT);
console.log(JSON.stringify({ calls: output.calls, latencyMs: output.latencyMs,
  local: results.filter((r) => r.arm === 'local').map((r) => [r.id, r.expected, r.deterministic, r.choice]),
  crossFunction: results.filter((r) => r.arm === 'crossFunction').map((r) => [r.id, r.expected, r.deterministic, r.choice]) }));
