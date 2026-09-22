#!/usr/bin/env node
/*
 * Real-binary confidence calibration measurement (collection phase).
 *
 * Single analysis per query: runs the production pipeline ONCE per query
 * (pinpointField, limit 400, no budget cap, same as #9413 premise runs) and
 * records ranked candidates + fusion. OLD/NEW/counterfactual verdicts are
 * derived OFFLINE from the same recorded fusion (see
 * scripts/pinpoint-confidence-policy.mjs) — production analysis work is never
 * doubled, and no new decompile/scan/API/LLM work is added by instrumentation
 * (only an analyze-call counter wrapper).
 *
 * Labels are independent ground truth: query triples (label, class, ivar) come
 * from tests/fixtures/pinpoint-confidence-queries.json, derived with the same
 * unique-name rule as #9413/accuracy-base. Hex's own top-1 is never used as a
 * label. Truth absent from candidates is recorded, never excluded.
 *
 * Usage:
 *   node --max-old-space-size=8000 scripts/measure-pinpoint-confidence.mjs [--out <dir>] [--only <binary>] [--limit <n>]
 *   HEX_DSDA_HOLDOUT_ARTIFACT=/path/to/dsda-doom node ... # optional DSDA holdout row
 *
 * Output: <out>/rows.jsonl (appended, checkpointed; completed query keys skipped)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBinary } from '../tests/harness.mjs';
import { pinpointField } from '../js/pinpoint.js';
import { parseGoal } from '../js/goals.js';
import {
  oldVerdictForFusion, newVerdictForFusion,
  policyBVerdictForFusion, policyCVerdictForFusion,
} from './pinpoint-confidence-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const OUT = path.resolve(ROOT, opt('--out', 'reports/investigations/pinpoint-confidence-calibration'));
const ONLY = (opt('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(opt('--limit', '0')) || 0;

const round4 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
const fusionOf = (c) => {
  if (!c || !c.fusion) return null;
  const f = c.fusion;
  return {
    logOdds: f.logOdds, probability: f.probability,
    verified: f.verified, identifying: f.identifying,
    independentGroups: f.independentGroups, groups: f.groups,
  };
};
const topEvidenceOf = (c, n = 8) => {
  const items = (c && c.fusion && c.fusion.items) || [];
  return items.slice().sort((a, b) => Math.abs(b.applied) - Math.abs(a.applied)).slice(0, n)
    .map((it) => ({ code: it.code, strength: round4(it.strength), lr: round4(it.lr), applied: round4(it.applied) }));
};
const codesOf = (c) => ((c && c.fusion && c.fusion.items) || []).map((it) => it.code);

const keyOf = (r) => `${r.binary}|${r.mode}|${r.label}`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rowsPath = path.join(OUT, 'rows.jsonl');
  const done = new Set();
  if (fs.existsSync(rowsPath)) {
    for (const line of fs.readFileSync(rowsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { done.add(keyOf(JSON.parse(line))); } catch { /* keep going */ }
    }
  }
  const out = fs.createWriteStream(rowsPath, { flags: 'a' });
  const queries = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests/fixtures/pinpoint-confidence-queries.json'), 'utf8'));
  const list = queries.filter((q) => !ONLY.length || ONLY.includes(q.binary));
  const worlds = new Map();
  const getWorld = async (binary) => {
    if (!worlds.has(binary)) {
      const target = binary === 'battlecats' ? 'tests/battlecats'
        : binary === 'TsumTsum' ? 'tests/TsumTsum' : 'tests/YWP';
      worlds.set(binary, await openBinary(target, { log: () => {} }));
    }
    return worlds.get(binary);
  };
  let ran = 0, skipped = 0;
  for (const q of (LIMIT > 0 ? list.slice(0, LIMIT) : list)) {
    const key = keyOf(q);
    if (done.has(key)) { skipped++; continue; }
    const row = await runFieldQuery(q, getWorld);
    out.write(JSON.stringify(row) + '\n');
    done.add(key);
    ran++;
    if (ran % 25 === 0) process.stdout.write(`  ${ran} ran, ${skipped} resumed-skipped\n`);
  }
  const dsda = await maybeRunDsda();
  if (dsda) { out.write(JSON.stringify(dsda) + '\n'); ran++; }
  out.close();
  await new Promise((r) => out.on('close', r));
  process.stdout.write(`done: ${ran} new rows, ${skipped} resumed-skipped -> ${rowsPath}\n`);
}

async function runFieldQuery(q, getWorld) {
  const base = {
    kind: 'field', binary: q.binary, mode: q.mode, label: q.label,
    expectedClass: q.class, expectedField: q.ivar,
  };
  let goal = null;
  try { goal = parseGoal(q.label); } catch (err) {
    return { ...base, error: 'goal-parse-threw:' + String(err && err.message || err) };
  }
  if (!goal) return { ...base, error: 'unparseable-goal' };
  const w = await getWorld(q.binary);
  let analyzeCalls = 0;
  const analyze = async (...a) => { analyzeCalls++; return w.analyze(...a); };
  let res = null;
  try {
    res = await pinpointField({
      goal, fields: w.fields, program: w.program, symbols: w.symbols,
      strings: w.strings, analyze, scanAccess: w.scanAccess, limit: 400,
    });
  } catch (err) {
    return { ...base, goal: goal.id, error: String((err && err.message) || err).slice(0, 300) };
  }
  const cands = (res && res.candidates) || [];
  const truthRank0 = cands.findIndex((c) => c.className === q.class && c.field && c.field.name === q.ivar);
  const top = cands[0] || null;
  const runner = cands[1] || null;
  const topF = fusionOf(top);
  const runF = fusionOf(runner);
  const codes = codesOf(top);
  const oldV = topF ? oldVerdictForFusion(topF, runF) : { verdict: 'none', margin: 0, marginRatio: 1, missing: ['no-candidate'] };
  const newV = topF ? newVerdictForFusion(topF, runF) : oldV;
  const bV = topF ? policyBVerdictForFusion(topF, runF, codes) : oldV;
  const cV = topF ? policyCVerdictForFusion(topF, runF, codes) : oldV;
  const fidelity = topF ? (newV.verdict === res.verdict ? 'match' : `MISMATCH:recomputed=${newV.verdict},production=${res.verdict}`) : 'no-fusion';
  return {
    ...base, goal: goal.id,
    topClass: top?.className || null, topField: top?.field?.name || null,
    topCorrect: truthRank0 === 0,
    truthRank: truthRank0 + 1, candidateCount: cands.length,
    universe: res.universe, checked: res.checked, analyzeCalls,
    probability: topF?.probability ?? null, logOdds: topF?.logOdds ?? null,
    runnerLogOdds: runF?.logOdds ?? null,
    margin: Number.isFinite(newV.margin) ? newV.margin : null,
    marginInfinite: !Number.isFinite(newV.margin),
    marginRatio: Number.isFinite(newV.marginRatio) ? newV.marginRatio : null,
    verified: topF?.verified ?? null, identifying: topF?.identifying ?? null,
    independentGroups: topF?.independentGroups ?? null,
    groups: topF?.groups ?? null,
    evidence: topEvidenceOf(top),
    oldVerdict: oldV.verdict, newVerdict: newV.verdict,
    policyBVerdict: bV.verdict, policyCVerdict: cV.verdict,
    missing: newV.missing, replayFidelity: fidelity,
  };
}

async function maybeRunDsda() {
  const artifact = process.env.HEX_DSDA_HOLDOUT_ARTIFACT;
  if (!artifact || !fs.existsSync(artifact)) return null;
  const { foldShapes } = await import('../js/shapes.js');
  const { goalFromPreset } = await import('../js/goals.js');
  const { pinpointLocation } = await import('../js/pinpoint-legacy.js');
  const w = await openBinary(artifact, { objc: false, strings: false, texts: false });
  const shapes = foldShapes(await w.backend.valueShapes(w.region.id));
  const program = {
    functionRange(addr) {
      const s = w.symbols.functionStartAt(BigInt(addr));
      return s == null ? null : { start: s, end: w.symbols.functionWindowBound(s) };
    },
  };
  let analyzeCalls = 0;
  const res = await pinpointLocation({
    goal: goalFromPreset('hp'), ranked: [], shapes, program,
    analyze: async (...a) => { analyzeCalls++; return w.analyze(...a); },
    scanAccess: w.scanAccess, budget: { left: 48 }, limit: 12,
  });
  const cands = res.candidates || [];
  const truthRank0 = cands.findIndex((c) => { try { return BigInt(c.offset).toString() === '196'; } catch { return false; } });
  const top = cands[0] || null;
  const runner = cands[1] || null;
  const topF = fusionOf(top);
  const runF = fusionOf(runner);
  const codes = codesOf(top);
  const oldV = oldVerdictForFusion(topF, runF);
  const newV = newVerdictForFusion(topF, runF);
  return {
    kind: 'location', binary: 'dsda-doom', mode: 'holdout', label: 'hp (mobj_t.health)',
    goal: 'hp', expectedOffset: '196',
    topOffset: top?.offset == null ? null : BigInt(top.offset).toString(),
    topCorrect: truthRank0 === 0, truthRank: truthRank0 + 1, candidateCount: cands.length,
    universe: res.universe, checked: res.checked, analyzeCalls,
    probability: topF?.probability ?? null, logOdds: topF?.logOdds ?? null,
    runnerLogOdds: runF?.logOdds ?? null,
    margin: Number.isFinite(newV.margin) ? newV.margin : null,
    marginInfinite: !Number.isFinite(newV.margin),
    marginRatio: Number.isFinite(newV.marginRatio) ? newV.marginRatio : null,
    verified: topF?.verified ?? null, identifying: topF?.identifying ?? null,
    independentGroups: topF?.independentGroups ?? null,
    groups: topF?.groups ?? null,
    evidence: topEvidenceOf(top),
    oldVerdict: oldV.verdict, newVerdict: newV.verdict,
    policyBVerdict: policyBVerdictForFusion(topF, runF, codes).verdict,
    policyCVerdict: policyCVerdictForFusion(topF, runF, codes).verdict,
    missing: newV.missing,
    replayFidelity: newV.verdict === res.verdict ? 'match' : `MISMATCH:recomputed=${newV.verdict},production=${res.verdict}`,
  };
}

await main();
