#!/usr/bin/env node
/*
 * Offline aggregation for the confidence calibration measurement.
 *
 * Pure offline computation over reports/investigations/pinpoint-confidence-calibration/rows.jsonl.
 * Adds zero analysis work. Writes summary.json and prints the tables that
 * feed README.md (kept in sync by tests/investigate-pinpoint-confidence-calibration.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const DIR = path.resolve(ROOT, opt('--out', 'reports/investigations/pinpoint-confidence-calibration'));

const rows = fs.readFileSync(path.join(DIR, 'rows.jsonl'), 'utf8').split('\n')
  .filter((l) => l.trim()).map((l) => JSON.parse(l));
const field = rows.filter((r) => r.kind === 'field' && !r.error);
const errored = rows.filter((r) => r.error);
const dsdaRows = rows.filter((r) => r.kind === 'location');

const isNone = (r) => !r.topClass && !r.topField && r.topCorrect !== true && r.truthRank !== 1
  && (r.newVerdict === 'none' || r.candidateCount === 0);
const statusOf = (r) => {
  if (r.error) return 'error';
  if (r.topCorrect === true) return 'correct';
  if (r.candidateCount === 0 || (r.topClass == null && r.topField == null)) return 'none';
  return 'wrong';
};
const strongOf = (v) => v === 'confirmed' || v === 'likely';

function contingency(list, policy) {
  const c = {
    correctConfirmed: 0, correctLikely: 0, correctAmbiguous: 0,
    wrongConfirmed: 0, wrongLikely: 0, wrongAmbiguous: 0, none: 0, error: 0,
  };
  for (const r of list) {
    if (r.error) { c.error++; continue; }
    const s = statusOf(r);
    if (s === 'none' || s === 'error') { c.none++; continue; }
    const v = r[policy];
    if (s === 'correct') {
      if (v === 'confirmed') c.correctConfirmed++;
      else if (v === 'likely') c.correctLikely++;
      else if (v === 'ambiguous') c.correctAmbiguous++;
      else c.none++;
    } else {
      if (v === 'confirmed') c.wrongConfirmed++;
      else if (v === 'likely') c.wrongLikely++;
      else if (v === 'ambiguous') c.wrongAmbiguous++;
      else c.none++;
    }
  }
  c.falseStrong = c.wrongConfirmed + c.wrongLikely;
  c.strong = c.correctConfirmed + c.correctLikely + c.falseStrong;
  return c;
}

const OLD = contingency(field, 'oldVerdict');
const NEW = contingency(field, 'newVerdict');
const POLB = contingency(field, 'policyBVerdict');
const POLC = contingency(field, 'policyCVerdict');

// Abstention cost: OLD likely -> NEW ambiguous, split by correctness.
let costCorrect = 0, costWrong = 0;
for (const r of field) {
  if (r.oldVerdict === 'likely' && r.newVerdict === 'ambiguous') {
    if (r.topCorrect === true) costCorrect++;
    else costWrong++;
  }
}
const prevented = OLD.falseStrong - NEW.falseStrong;

// Groups breakdown (field, by top independentGroups).
function groupsBreakdown() {
  const out = {};
  for (const g of ['1', '2', '3+']) out[g] = { queries: 0, correct: 0, wrong: 0, none: 0, oldStrong: 0, oldFalseStrong: 0, newStrong: 0, newFalseStrong: 0 };
  for (const r of field) {
    const g = (r.independentGroups ?? 0) >= 3 ? '3+' : String(r.independentGroups ?? 0);
    const b = out[g] || (out[g] = { queries: 0, correct: 0, wrong: 0, none: 0, oldStrong: 0, oldFalseStrong: 0, newStrong: 0, newFalseStrong: 0 });
    b.queries++;
    const s = statusOf(r);
    if (s === 'correct') {
      b.correct++;
      if (strongOf(r.oldVerdict)) b.oldStrong++;
      if (strongOf(r.newVerdict)) b.newStrong++;
    } else if (s === 'wrong') {
      b.wrong++;
      if (strongOf(r.oldVerdict)) { b.oldStrong++; b.oldFalseStrong++; }
      if (strongOf(r.newVerdict)) { b.newStrong++; b.newFalseStrong++; }
    } else b.none++;
  }
  for (const g of Object.keys(out)) {
    const b = out[g];
    const denom = b.correct + b.wrong;
    b.accuracy = denom ? b.correct / denom : null;
  }
  return out;
}
const groups = groupsBreakdown();

// P(correct | OLD likely AND groups=2) with n.
const g2likely = field.filter((r) => r.oldVerdict === 'likely' && (r.independentGroups ?? 0) === 2);
const g2likelyCorrect = g2likely.filter((r) => r.topCorrect === true).length;

// 2-group OLD-likely combination breakdown.
function comboBreakdown() {
  const out = {};
  for (const r of g2likely) {
    const combo = ((r.groups || []).slice().sort().join('+')) || 'none';
    const b = out[combo] || (out[combo] = { count: 0, correct: 0, wrong: 0, falseLikely: 0 });
    b.count++;
    if (r.topCorrect === true) b.correct++;
    else { b.wrong++; b.falseLikely++; }
  }
  for (const k of Object.keys(out)) {
    const b = out[k];
    b.accuracy = b.count ? b.correct / b.count : null;
    b.likelyCount = b.count;
  }
  return out;
}

// Evidence composition among OLD false-likely tops.
function evidenceBreakdown() {
  const n = field.filter((r) => !r.error && statusOf(r) === 'wrong' && r.oldVerdict === 'likely');
  const counts = {};
  for (const r of n) for (const e of (r.evidence || [])) counts[e.code] = (counts[e.code] || 0) + 1;
  return { n: n.length, codes: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])) };
}

// Margin buckets by marginRatio (Infinity -> '>50x').
function marginBuckets() {
  const bounds = [[4, '<4x'], [10, '4-10x'], [20, '10-20x'], [50, '20-50x']];
  const out = { '<4x': fresh(), '4-10x': fresh(), '10-20x': fresh(), '20-50x': fresh(), '>50x': fresh() };
  function fresh() { return { count: 0, correct: 0, wrong: 0, g2: 0, g3plus: 0 }; }
  for (const r of field) {
    if (r.error || statusOf(r) === 'none') continue;
    const ratio = r.marginInfinite ? Infinity : (r.marginRatio ?? 0);
    let key = '>50x';
    for (const [b, k] of bounds) if (ratio < b) { key = k; break; }
    const b = out[key];
    b.count++;
    if (r.topCorrect === true) b.correct++; else b.wrong++;
    if ((r.independentGroups ?? 0) === 2) b.g2++;
    if ((r.independentGroups ?? 0) >= 3) b.g3plus++;
  }
  return out;
}

// Score buckets by confidence score (explicitly NOT frequency probability).
function scoreBuckets() {
  const out = {
    '<0.85': fresh(), '0.85-0.90': fresh(), '0.90-0.95': fresh(), '0.95-0.99': fresh(), '>=0.99': fresh(),
  };
  function fresh() { return { count: 0, correct: 0, g1: 0, g2: 0, g3plus: 0 }; }
  for (const r of field) {
    if (r.error || statusOf(r) === 'none' || typeof r.probability !== 'number') continue;
    const p = r.probability;
    const key = p < 0.85 ? '<0.85' : p < 0.90 ? '0.85-0.90' : p < 0.95 ? '0.90-0.95' : p < 0.99 ? '0.95-0.99' : '>=0.99';
    const b = out[key];
    b.count++;
    if (r.topCorrect === true) b.correct++;
    const g = r.independentGroups ?? 0;
    if (g <= 1) b.g1++;
    else if (g === 2) b.g2++;
    else b.g3plus++;
  }
  for (const k of Object.keys(out)) {
    const b = out[k];
    b.accuracy = b.count ? b.correct / b.count : null;
  }
  return out;
}

const byId = (id) => field.filter((r) => r.binary === id);
const byMode = (mode) => field.filter((r) => r.mode === mode);
const coverage = (list) => {
  const o = { correctConfirmed: 0, correctLikely: 0, correctAmbiguous: 0 };
  const n = { correctConfirmed: 0, correctLikely: 0, correctAmbiguous: 0 };
  for (const r of list) {
    if (r.topCorrect !== true) continue;
    if (r.oldVerdict === 'confirmed') o.correctConfirmed++;
    else if (r.oldVerdict === 'likely') o.correctLikely++;
    else if (r.oldVerdict === 'ambiguous') o.correctAmbiguous++;
    if (r.newVerdict === 'confirmed') n.correctConfirmed++;
    else if (r.newVerdict === 'likely') n.correctLikely++;
    else if (r.newVerdict === 'ambiguous') n.correctAmbiguous++;
  }
  return { old: o, new: n };
};
const regimeG2 = (mode) => {
  const L = field.filter((r) => r.mode === mode && r.oldVerdict === 'likely' && (r.independentGroups ?? 0) === 2);
  const c = L.filter((r) => r.topCorrect === true).length;
  return { n: L.length, correct: c, observed: L.length ? c / L.length : null };
};
const highMarginWrongG2 = field
  .filter((r) => !r.error && r.topCorrect !== true && statusOf(r) === 'wrong'
    && (r.independentGroups ?? 0) === 2
    && (r.marginInfinite || (r.marginRatio ?? 0) >= 20))
  .map((r) => ({ binary: r.binary, mode: r.mode, label: r.label, marginRatio: r.marginInfinite ? 'Infinity' : r.marginRatio, oldVerdict: r.oldVerdict, newVerdict: r.newVerdict }));
const newLikelyPool = (() => {
  const L = field.filter((r) => r.newVerdict === 'likely');
  const combos = {};
  for (const r of L) {
    const k = ((r.groups || []).slice().sort().join('+')) || 'none';
    combos[k] = (combos[k] || 0) + 1;
  }
  return { n: L.length, correct: L.filter((r) => r.topCorrect === true).length, combos };
})();
const preventedDetail = field
  .filter((r) => (r.oldVerdict === 'confirmed' || r.oldVerdict === 'likely') && r.topCorrect !== true && r.newVerdict === 'ambiguous')
  .map((r) => ({ binary: r.binary, mode: r.mode, label: r.label, truthRank: r.truthRank, candidateCount: r.candidateCount, probability: r.probability, groups: r.groups, oldVerdict: r.oldVerdict }));
const subset = (list) => ({
  queries: list.length,
  accuracy: (() => { const c = list.filter((r) => r.topCorrect === true).length; const w = list.filter((r) => !r.error && r.topCorrect !== true && statusOf(r) === 'wrong').length; return (c + w) ? c / (c + w) : null; })(),
  oldFalseStrong: contingency(list, 'oldVerdict').falseStrong,
  newFalseStrong: contingency(list, 'newVerdict').falseStrong,
});
const present = field.filter((r) => (r.truthRank ?? 0) >= 1);
const notfound = field.filter((r) => (r.truthRank ?? 0) === 0);

const summary = {
  schema: 'hex-pinpoint-confidence-calibration/v1',
  dataset: {
    binaries: ['battlecats', 'TsumTsum', 'YWP'],
    queryFixture: 'tests/fixtures/pinpoint-confidence-queries.json',
    fieldRows: field.length,
    dsdaHoldoutRows: dsdaRows.length,
    totalRows: rows.length,
    fieldQueries: field.length,
    byBinaryMode: {
      battlecats: { exact: byId('battlecats').filter((r) => r.mode === 'exact').length, partial: byId('battlecats').filter((r) => r.mode === 'partial').length },
      TsumTsum: { exact: byId('TsumTsum').filter((r) => r.mode === 'exact').length, partial: byId('TsumTsum').filter((r) => r.mode === 'partial').length },
      YWP: { exact: byId('YWP').filter((r) => r.mode === 'exact').length, partial: byId('YWP').filter((r) => r.mode === 'partial').length },
    },
    errored: errored.length,
    dsdaHoldout: dsdaRows.length ? 'included-separately' : 'skipped-artifact-absent',
  },
  policies: {
    OLD: 'likely: p>=0.85 AND margin>=ln4, no group requirement; confirmed unchanged',
    NEW: 'likely: p>=0.85 AND margin>=ln4 AND independentGroups>=3 (#9418); confirmed unchanged',
    B: 'OLD + likely requires verified evidence (measurement-only)',
    C: 'OLD + groups==2 likely requires getter/setter-verified (measurement-only)',
  },
  contingency: { OLD, NEW, policyB: POLB, policyC: POLC },
  abstentionCost: {
    preventedFalseStrong: prevented,
    oldCorrectLikelyToNewAmbiguous: costCorrect,
    oldWrongLikelyToNewAmbiguous: costWrong,
  },
  groups,
  pCorrectGivenOldLikelyG2: { n: g2likely.length, correct: g2likelyCorrect, observed: g2likely.length ? g2likelyCorrect / g2likely.length : null },
  groupCombinationG2OldLikely: comboBreakdown(),
  evidenceInOldFalseLikely: evidenceBreakdown(),
  marginBuckets: marginBuckets(),
  scoreBuckets: scoreBuckets(),
  exact: subset(byMode('exact')),
  exactCoverage: coverage(byMode('exact')),
  partialCoverage: coverage(byMode('partial')),
  regimeG2OldLikely: { exact: regimeG2('exact'), partial: regimeG2('partial') },
  highMarginWrongG2: highMarginWrongG2,
  newLikelyPool: newLikelyPool,
  preventedDetail: preventedDetail,
  partialOverall: subset(byMode('partial')),
  partialPresent: subset(byMode('partial').filter((r) => (r.truthRank ?? 0) >= 1)),
  partialNotFound: byMode('partial').filter((r) => (r.truthRank ?? 0) === 0).length,
  presentVsNotFound: { present: present.length, notFound: notfound.length },
  performance: {
    totalAnalyzeCalls: field.reduce((a, r) => a + (r.analyzeCalls || 0), 0) + dsdaRows.reduce((a, r) => a + (r.analyzeCalls || 0), 0),
    singleAnalysisPerQuery: true,
    replayOfflineAddsZeroAnalysis: true,
  },
  dsda: dsdaRows[0] ? {
    topOffset: dsdaRows[0].topOffset, topCorrect: dsdaRows[0].topCorrect,
    truthRank: dsdaRows[0].truthRank, candidateCount: dsdaRows[0].candidateCount,
    probability: dsdaRows[0].probability, margin: dsdaRows[0].margin,
    marginRatio: dsdaRows[0].marginRatio, independentGroups: dsdaRows[0].independentGroups,
    groups: dsdaRows[0].groups, oldVerdict: dsdaRows[0].oldVerdict, newVerdict: dsdaRows[0].newVerdict,
    analyzeCalls: dsdaRows[0].analyzeCalls, missing: dsdaRows[0].missing,
  } : null,
};

fs.writeFileSync(path.join(DIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const s = summary;
const pct = (v) => (v == null ? 'n/a' : (v * 100).toFixed(1) + '%');
process.stdout.write([
  `field queries=${s.dataset.fieldQueries} errors=${s.dataset.errored}`,
  `OLD falseStrong=${s.contingency.OLD.falseStrong} NEW falseStrong=${s.contingency.NEW.falseStrong} prevented=${s.abstentionCost.preventedFalseStrong}`,
  `abstention: correct likely->ambiguous=${s.abstentionCost.oldCorrectLikelyToNewAmbiguous}, wrong likely->ambiguous=${s.abstentionCost.oldWrongLikelyToNewAmbiguous}`,
  `P(correct|OLD likely,g2): ${pct(s.pCorrectGivenOldLikelyG2.observed)} n=${s.pCorrectGivenOldLikelyG2.n}`,
  `groups: ${Object.entries(s.groups).map(([g, b]) => `${g}:{q=${b.queries},acc=${pct(b.accuracy)},oldStrong=${b.oldStrong},oldFalse=${b.oldFalseStrong},newStrong=${b.newStrong},newFalse=${b.newFalseStrong}}`).join(' ')}`,
  `B falseStrong=${s.contingency.policyB.falseStrong} C falseStrong=${s.contingency.policyC.falseStrong}`,
].join('\n') + '\n');
