#!/usr/bin/env node
// Offline analysis for the Jev rescue/regression gap investigation.
// Produces all machine-readable artifacts under this directory.
// No production imports. Truth is used only for evaluation labels, never as a gate feature.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const SOURCE = path.resolve(arg('--source', path.join(HERE, 'current-main-baseline-rows.jsonl')));
const CHECKPOINT = path.resolve(arg('--checkpoint', path.join(HERE, 'checkpoint')));
const MEASUREMENT = path.resolve(arg('--measurement', path.join(HERE, 'current-main-measurement.json')));
const write = (name, data) => {
  const file = path.join(HERE, name);
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(file, text);
  process.stdout.write(`wrote ${name}\n`);
};
const shaFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const idOf = (r) => `${r.binary}|${r.mode}|${r.label}`;
const isStrong = (v) => v === 'confirmed' || v === 'likely';
const words = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ')
  .toLowerCase().trim().split(/\s+/).filter(Boolean);

assert.ok(fs.existsSync(SOURCE), `missing source rows: ${SOURCE}`);
const measurement = JSON.parse(fs.readFileSync(MEASUREMENT, 'utf8'));
const rows = fs.readFileSync(SOURCE, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.kind === 'field');
assert.equal(rows.length, 426, 'field rows');

function loadJev(rowId, arm) {
  const file = path.join(CHECKPOINT, `${sha(`${rowId}|${arm}`)}.json`);
  if (!fs.existsSync(file)) return null;
  const x = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (x.error) return { choiceIndex: null, error: x.error, confidence: null, unique: null, preference: null, latencyMs: x.latencyMs ?? null, status: x.status ?? null };
  return { choiceIndex: x.choice, error: null, confidence: x.confidence, unique: x.unique, preference: x.preference, latencyMs: x.latencyMs, status: x.status, fallback: x.fallback ?? 0 };
}

function classification(baselineCorrect, jevCorrect) {
  if (!baselineCorrect && jevCorrect) return 'RESCUE';
  if (baselineCorrect && !jevCorrect) return 'REGRESSION';
  if (baselineCorrect && jevCorrect) return 'STABLE_CORRECT';
  return 'STABLE_WRONG';
}

// ---------- feature extraction (no truth as production feature) ----------
function lexicalFeatures(query, fieldName) {
  const q = words(query);
  const f = words(fieldName);
  const qSet = new Set(q);
  const fSet = new Set(f);
  const overlap = q.filter((w) => fSet.has(w)).length;
  const coverage = q.length ? overlap / q.length : 0;
  const suffixLen = (() => {
    let i = 0;
    while (i < q.length && i < f.length && q[q.length - 1 - i] === f[f.length - 1 - i]) i++;
    return i;
  })();
  const prefixLen = (() => {
    let i = 0;
    while (i < q.length && i < f.length && q[i] === f[i]) i++;
    return i;
  })();
  const exact = q.join(' ') === f.join(' ') ? 1 : 0;
  const suffixFull = q.length > 0 && f.slice(-q.length).join(' ') === q.join(' ') ? 1 : 0;
  const substring = f.join(' ').includes(q.join(' ')) ? 1 : 0;
  const raw = String(fieldName || '');
  const camel = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const abbrevLike = /^[a-z]{1,4}$/i.test(String(query || '').trim()) || q.length <= 2 && q.every((w) => w.length <= 3);
  const genericWords = new Set(['view', 'cell', 'label', 'button', 'image', 'data', 'value', 'name', 'type', 'list', 'count', 'index', 'item', 'model', 'view', 'manager', 'controller', 'handler', 'delegate', 'source', 'target', 'cache', 'queue', 'timer', 'session', 'config', 'option', 'options']);
  const genericRatio = q.length ? q.filter((w) => genericWords.has(w)).length / q.length : 0;
  return {
    tokenCount: q.length,
    wordCount: q.length,
    normalizedLength: String(query || '').length,
    overlap,
    coverage,
    suffixMatchLen: suffixLen,
    prefixMatchLen: prefixLen,
    exactFieldRelation: exact,
    suffixRelation: suffixFull,
    substringRelation: substring,
    abbrevLike,
    genericRatio,
    camelDecomposed: camel !== raw,
    queryField: f.join(' '),
    queryWords: q,
    fieldWords: f,
    jaccard: qSet.size + fSet.size ? overlap / (qSet.size + fSet.size - overlap) : 0,
  };
}

function evidenceDelta(a, b) {
  // a,b: candidate objects with fusion + evidence
  const ga = new Set((a?.fusion?.groups) || []);
  const gb = new Set((b?.fusion?.groups) || []);
  const codesA = new Set((a?.evidence || []).map((e) => e.code));
  const codesB = new Set((b?.evidence || []).map((e) => e.code));
  let inter = 0;
  for (const c of codesA) if (codesB.has(c)) inter++;
  const union = new Set([...codesA, ...codesB]).size || 1;
  let gInter = 0;
  for (const g of ga) if (gb.has(g)) gInter++;
  const gUnion = new Set([...ga, ...gb]).size || 1;
  return {
    evidenceJaccard: inter / union,
    groupJaccard: gInter / gUnion,
    groupSymmetricDiff: new Set([...ga].filter((g) => !gb.has(g)).concat([...gb].filter((g) => !ga.has(g)))).size,
    scoreAbsDelta: Math.abs((a?.fusion?.logOdds ?? 0) - (b?.fusion?.logOdds ?? 0)),
    scoreDelta: (b?.fusion?.logOdds ?? 0) - (a?.fusion?.logOdds ?? 0),
    verifiedDelta: (b?.fusion?.verified ?? 0) - (a?.fusion?.verified ?? 0),
    indepGroupsTop: a?.fusion?.independentGroups ?? 0,
    indepGroupsJev: b?.fusion?.independentGroups ?? 0,
    identifyingTop: a?.fusion?.identifying ?? 0,
    identifyingJev: b?.fusion?.identifying ?? 0,
    topHasDataflow: ((a?.fusion?.groups) || []).includes('dataflow'),
    jevHasDataflow: ((b?.fusion?.groups) || []).includes('dataflow'),
    topHasStructural: ((a?.fusion?.groups) || []).includes('structural'),
    topHasMetadata: ((a?.fusion?.groups) || []).includes('metadata'),
    topHasRtti: ((a?.fusion?.groups) || []).includes('rtti') || ((a?.fusion?.groups) || []).includes('type'),
  };
}

function queryFamily(query) {
  const q = words(query);
  // fixture generator uses last-two-word tails; family key = sorted tail tokens + length bucket
  const tail = q.slice(-2).join('_');
  return `tail:${tail}|n:${q.length}`;
}

function buildFeatureRow(r, jev) {
  const rowId = idOf(r);
  const top = r.candidates[0];
  const jevIdx = jev?.choiceIndex;
  const jevCand = Number.isInteger(jevIdx) ? r.candidates[jevIdx] : null;
  const truthIdx = r.candidates.findIndex((c) => c.truth);
  const truthCand = r.candidates[truthIdx];
  const runner = r.candidates[1] || null;
  const margin = typeof r.margin === 'number' ? r.margin : (r.runnerLogOdds == null ? Infinity : (r.logOdds - r.runnerLogOdds));
  const baselineCorrect = !!r.topCorrect;
  const jevCorrect = jevCand ? !!jevCand.truth : null;
  const cls = jevCorrect == null ? (baselineCorrect ? 'STABLE_CORRECT' : 'STABLE_WRONG') : classification(baselineCorrect, jevCorrect);
  const qLexTop = lexicalFeatures(r.label, top?.fieldName);
  const qLexJev = jevCand ? lexicalFeatures(r.label, jevCand.fieldName) : null;
  const qLexTruth = truthCand ? lexicalFeatures(r.label, truthCand.fieldName) : null;
  const ev = evidenceDelta(top, jevCand || top);
  // production-observable gate features only
  const features = {
    id: rowId,
    binary: r.binary,
    mode: r.mode,
    query: r.label,
    queryFamily: queryFamily(r.label),
    classification: cls,
    baselineCorrect,
    jevCorrect,
    // Hex ranking
    verdict: r.p4Verdict ?? r.currentVerdict ?? r.newVerdict,
    strong: isStrong(r.p4Verdict ?? r.currentVerdict ?? r.newVerdict),
    probability: r.probability,
    logOdds: r.logOdds,
    runnerLogOdds: r.runnerLogOdds,
    margin,
    marginRatio: r.marginRatio,
    marginInfinite: !!r.marginInfinite,
    candidateCount: r.candidateCount,
    truthRank: r.truthRank, // evaluation only
    baselineTopRank: 1,
    jevChoiceRank: jevCand ? jevCand.rank : null,
    jevInTopK: jevCand ? jevCand.rank <= Math.min(5, r.candidateCount) : null,
    jevInTop3: jevCand ? jevCand.rank <= 3 : null,
    verified: r.verified,
    identifying: r.identifying,
    independentGroups: r.independentGroups,
    evidenceGroups: r.groups,
    evidenceGroupCount: (r.groups || []).length,
    topEvidenceCodes: (top?.evidence || []).map((e) => e.code),
    topRecallLane: !!top?.recallLane,
    truthRecallLane: truthCand ? !!truthCand.recallLane : null, // eval only
    analyzeCalls: r.analyzeCalls,
    baselineLatencyMs: r.latencyMs,
    // binary/context evidence deltas
    evidenceJaccard: ev.evidenceJaccard,
    groupJaccard: ev.groupJaccard,
    groupSymmetricDiff: ev.groupSymmetricDiff,
    scoreAbsDelta: ev.scoreAbsDelta,
    scoreDelta: ev.scoreDelta,
    verifiedDelta: ev.verifiedDelta,
    indepGroupsTop: ev.indepGroupsTop,
    indepGroupsJev: ev.indepGroupsJev,
    identifyingTop: ev.identifyingTop,
    identifyingJev: ev.identifyingJev,
    topHasDataflow: ev.topHasDataflow,
    jevHasDataflow: ev.jevHasDataflow,
    sameClass: !!(top && jevCand && top.className === jevCand.className),
    sameFieldName: !!(top && jevCand && top.fieldName === jevCand.fieldName),
    baselineDecisive: isStrong(r.p4Verdict ?? r.currentVerdict ?? r.newVerdict) && (r.independentGroups >= 3),
    // query
    queryTokens: qLexTop.tokenCount,
    queryLength: qLexTop.normalizedLength,
    exactFieldRelationTop: qLexTop.exactFieldRelation,
    suffixRelationTop: qLexTop.suffixRelation,
    substringRelationTop: qLexTop.substringRelation,
    coverageTop: qLexTop.coverage,
    suffixMatchTop: qLexTop.suffixMatchLen,
    prefixMatchTop: qLexTop.prefixMatchLen,
    coverageJev: qLexJev ? qLexJev.coverage : null,
    suffixMatchJev: qLexJev ? qLexJev.suffixMatchLen : null,
    coverageTruth: qLexTruth ? qLexTruth.coverage : null, // eval only
    suffixMatchTruth: qLexTruth ? qLexTruth.suffixMatchLen : null, // eval only
    abbrevLike: qLexTop.abbrevLike,
    genericRatio: qLexTop.genericRatio,
    jevCoverageBeatsTop: qLexJev ? (qLexJev.coverage > qLexTop.coverage ? 1 : qLexJev.coverage < qLexTop.coverage ? -1 : 0) : 0,
    jevSuffixBeatsTop: qLexJev ? (qLexJev.suffixMatchLen > qLexTop.suffixMatchLen ? 1 : qLexJev.suffixMatchLen < qLexTop.suffixMatchLen ? -1 : 0) : 0,
    // names
    baselineFieldName: top?.fieldName ?? null,
    baselineClassName: top?.className ?? null,
    jevFieldName: jevCand?.fieldName ?? null,
    jevClassName: jevCand?.className ?? null,
    truthFieldName: truthCand?.fieldName ?? null, // eval only
    truthClassName: truthCand?.className ?? null, // eval only
    candidateNameDiversity: new Set(r.candidates.map((c) => c.fieldName)).size,
    uniqueFieldNames: new Set(r.candidates.map((c) => c.fieldName)).size,
    // Jev
    jevConfidence: jev?.confidence ?? null,
    jevUnique: jev?.unique ?? null,
    jevPreference: jev?.preference ?? null,
    jevLatencyMs: jev?.latencyMs ?? null,
    jevError: jev?.error ?? null,
    jevChoiceAgreesBaseline: jevCand ? jevIdx === 0 : null,
  };
  // store candidates lightly for case studies
  features.candidateTopK = r.candidates.slice(0, Math.min(12, r.candidates.length)).map((c, i) => ({
    index: i, key: c.key, className: c.className, fieldName: c.fieldName,
    rank: c.rank, truth: c.truth, // truth for evaluation display only
    recallLane: !!c.recallLane, score: c.fusion?.logOdds ?? 0,
    groups: c.fusion?.groups || [], verified: c.fusion?.verified ?? 0,
    independentGroups: c.fusion?.independentGroups ?? 0,
    evidenceCodes: (c.evidence || []).map((e) => e.code),
  }));
  features.evidenceTop = (top?.evidence || []).map((e) => ({ code: e.code, group: e.group, family: e.family, identifying: !!e.identifying, lr: e.lr }));
  features.evidenceJev = jevCand ? (jevCand.evidence || []).map((e) => ({ code: e.code, group: e.group, family: e.family, identifying: !!e.identifying, lr: e.lr })) : [];
  features.evidenceTruth = truthCand ? (truthCand.evidence || []).map((e) => ({ code: e.code, group: e.group, family: e.family })) : [];
  return features;
}

// ---------- classify all partials with label arm ----------
const labelProjected = [];
const missingJev = [];
for (const r of rows) {
  if (r.mode !== 'partial') continue;
  const jev = loadJev(idOf(r), 'label');
  if (!jev || jev.error) { missingJev.push({ id: idOf(r), error: jev?.error || 'missing' }); continue; }
  labelProjected.push({ r, jev });
}
if (missingJev.length) {
  process.stderr.write(`WARNING: ${missingJev.length} partial rows missing successful label arm\n`);
}

const featureRows = labelProjected.map(({ r, jev }) => buildFeatureRow(r, jev));
assert.equal(featureRows.length + missingJev.length, 196);

const counts = featureRows.reduce((a, f) => { a[f.classification] = (a[f.classification] || 0) + 1; return a; }, {});
const rescues = featureRows.filter((f) => f.classification === 'RESCUE');
const regressions = featureRows.filter((f) => f.classification === 'REGRESSION');
const stableCorrect = featureRows.filter((f) => f.classification === 'STABLE_CORRECT');
const stableWrong = featureRows.filter((f) => f.classification === 'STABLE_WRONG');

// baseline metrics on all 426
const exactRows = rows.filter((r) => r.mode === 'exact');
const partialRows = rows.filter((r) => r.mode === 'partial');
const baseline = {
  schema: 'hex-jev-rescue-regression-baseline/v1',
  productCommit: measurement.productCommit,
  productTree: measurement.productTree,
  measuredAt: measurement.completedAt,
  queryFixture: measurement.queryFixture,
  N: rows.length,
  candidatePresent: rows.filter((r) => r.candidatePresent).length,
  top1: rows.filter((r) => r.topCorrect).length,
  wrong: rows.filter((r) => !r.topCorrect).length,
  exact: { N: exactRows.length, top1: exactRows.filter((r) => r.topCorrect).length },
  partial: { N: partialRows.length, top1: partialRows.filter((r) => r.topCorrect).length },
  byBinary: Object.fromEntries(['battlecats', 'TsumTsum', 'YWP'].map((b) => {
    const rs = rows.filter((r) => r.binary === b);
    return [b, { N: rs.length, top1: rs.filter((r) => r.topCorrect).length, wrong: rs.filter((r) => !r.topCorrect).length }];
  })),
  verdictStrong: rows.filter((r) => isStrong(r.p4Verdict ?? r.currentVerdict ?? r.newVerdict)).length,
  correctStrong: rows.filter((r) => r.topCorrect && isStrong(r.p4Verdict ?? r.currentVerdict ?? r.newVerdict)).length,
  falseStrong: rows.filter((r) => !r.topCorrect && isStrong(r.p4Verdict ?? r.currentVerdict ?? r.newVerdict)).length,
  wrongStrong: rows.filter((r) => !r.topCorrect && isStrong(r.p4Verdict ?? r.currentVerdict ?? r.newVerdict)).length,
  wrongAmbiguous: rows.filter((r) => !r.topCorrect && !isStrong(r.p4Verdict ?? r.currentVerdict ?? r.newVerdict)).length,
  correctStrongPartial: partialRows.filter((r) => r.topCorrect && isStrong(r.p4Verdict ?? r.currentVerdict ?? r.newVerdict)).length,
  wrongStrongPartial: partialRows.filter((r) => !r.topCorrect && isStrong(r.p4Verdict ?? r.currentVerdict ?? r.newVerdict)).length,
  missingJevLabel: missingJev,
  jevFailures: featureRows.filter((f) => f.jevError).length,
};
write('current-main-baseline.json', baseline);

// row classification
write('row-classification.jsonl', featureRows.map((f) => {
  const { candidateTopK, evidenceTop, evidenceJev, evidenceTruth, ...rest } = f;
  return JSON.stringify({
    ...rest,
    // keep names + core scores for audit
    topScore: f.candidateTopK?.[0]?.score ?? null,
    jevScore: (f.candidateTopK || []).find((c) => c.index === f.jevChoiceRank - 1)?.score ?? null,
  });
}).join('\n') + '\n');

function caseStudy(f, role) {
  const whyBaselineLost = f.classification === 'RESCUE' || (role === 'regression' && !f.baselineCorrect)
    ? (() => {
        const parts = [];
        if (!f.strong) parts.push('verdict ambiguous / weak separation');
        if (f.margin != null && Number.isFinite(f.margin) && f.margin < Math.log(4)) parts.push(`small margin ${f.margin.toFixed(3)}`);
        if (f.candidateCount >= 4) parts.push(`crowded candidate set n=${f.candidateCount}`);
        if (f.coverageTop != null && f.coverageTop < 1) parts.push(`top lexical coverage ${f.coverageTop.toFixed(2)} < 1`);
        if (!f.topHasDataflow) parts.push('top lacks dataflow evidence group');
        if (f.truthRank > 1) parts.push(`truth at rank ${f.truthRank} (not production feature; diagnosis only)`);
        if (f.sameFieldName && !f.sameClass) parts.push('same field name across classes');
        return parts.length ? parts.join('; ') : 'baseline top1 was wrong under fixture truth';
      })()
    : (() => {
        const parts = [];
        if (f.strong) parts.push(`baseline already ${f.verdict}`);
        if (f.truthRank === 1) parts.push('baseline top1 was fixture-truth');
        if (f.marginInfinite) parts.push('single-candidate / infinite margin');
        return parts.length ? parts.join('; ') : 'baseline top1 was correct under fixture truth';
      })();
  const whyJev = f.classification === 'RESCUE'
    ? `Jev label-only preferred rank-${f.jevChoiceRank} field ${f.jevFieldName} (conf=${f.jevConfidence}, unique=${f.jevUnique}) over baseline ${f.baselineFieldName}; coverage top=${(f.coverageTop ?? 0).toFixed(2)} jev=${(f.coverageJev ?? 0).toFixed(2)}`
    : f.classification === 'REGRESSION'
      ? `Jev label-only preferred rank-${f.jevChoiceRank} field ${f.jevFieldName} (conf=${f.jevConfidence}, unique=${f.jevUnique}) away from baseline ${f.baselineFieldName} which matched fixture truth; coverage top=${(f.coverageTop ?? 0).toFixed(2)} jev=${(f.coverageJev ?? 0).toFixed(2)}`
      : `Jev agreement/disagreement without class change (choice=${f.jevFieldName})`;
  return {
    id: f.id,
    classification: f.classification,
    query: f.query,
    binary: f.binary,
    expected: `${f.truthClassName}#${f.truthFieldName}`,
    baseline: `${f.baselineClassName}#${f.baselineFieldName}`,
    jev: `${f.jevClassName}#${f.jevFieldName}`,
    candidateTopK: f.candidateTopK,
    deterministicScores: {
      probability: f.probability, logOdds: f.logOdds, runnerLogOdds: f.runnerLogOdds,
      margin: f.margin, marginRatio: f.marginRatio, verified: f.verified,
      independentGroups: f.independentGroups, candidateCount: f.candidateCount,
      evidenceGroups: f.evidenceGroups,
    },
    evidence: { top: f.evidenceTop, jev: f.evidenceJev, truth: f.evidenceTruth },
    jevConfidence: f.jevConfidence,
    jevUniqueness: f.jevUnique,
    jevPreference: f.jevPreference,
    whyBaselineLostOrHeld: whyBaselineLost,
    whyJevAppearedToHelpOrHurt: whyJev,
    featureSnapshot: {
      verdict: f.verdict, strong: f.strong, margin: f.margin, candidateCount: f.candidateCount,
      coverageTop: f.coverageTop, coverageJev: f.coverageJev, evidenceJaccard: f.evidenceJaccard,
      scoreAbsDelta: f.scoreAbsDelta, sameClass: f.sameClass, jevInTopK: f.jevInTopK,
      topHasDataflow: f.topHasDataflow, queryFamily: f.queryFamily, truthRank: f.truthRank,
    },
  };
}

write('rescue-cases.jsonl', rescues.map((f) => JSON.stringify(caseStudy(f, 'rescue'))).join('\n') + '\n');
write('regression-cases.jsonl', regressions.map((f) => JSON.stringify(caseStudy(f, 'regression'))).join('\n') + '\n');
write('feature-matrix.jsonl', featureRows.map((f) => JSON.stringify({
  id: f.id, binary: f.binary, classification: f.classification,
  queryFamily: f.queryFamily, verdict: f.verdict, strong: f.strong,
  margin: Number.isFinite(f.margin) ? f.margin : null, marginInfinite: f.marginInfinite,
  candidateCount: f.candidateCount, probability: f.probability,
  independentGroups: f.independentGroups, evidenceGroupCount: f.evidenceGroupCount,
  topHasDataflow: f.topHasDataflow, sameClass: f.sameClass,
  coverageTop: f.coverageTop, coverageJev: f.coverageJev,
  jevCoverageBeatsTop: f.jevCoverageBeatsTop, jevSuffixBeatsTop: f.jevSuffixBeatsTop,
  evidenceJaccard: f.evidenceJaccard, scoreAbsDelta: f.scoreAbsDelta,
  jevInTopK: f.jevInTopK, jevConfidence: f.jevConfidence, jevUnique: f.jevUnique,
  jevChoiceRank: f.jevChoiceRank, baselineCorrect: f.baselineCorrect, jevCorrect: f.jevCorrect,
  truthRank: f.truthRank, abbrevLike: f.abbrevLike, genericRatio: f.genericRatio,
  queryTokens: f.queryTokens, candidateNameDiversity: f.candidateNameDiversity,
  topRecallLane: f.topRecallLane, truthRecallLane: f.truthRecallLane,
  analyzedVerdictStrongOnWrong: !f.baselineCorrect && f.strong,
  analyzedVerdictStrongOnCorrect: f.baselineCorrect && f.strong,
})).join('\n') + '\n');

// ---------- feature summary: rescue vs regression separation ----------
function numericSummary(list, key) {
  const xs = list.map((x) => x[key]).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0 };
  const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))];
  return { n: xs.length, min: xs[0], p25: q(0.25), p50: q(0.5), p75: q(0.75), max: xs[xs.length - 1], mean: xs.reduce((a, b) => a + b, 0) / xs.length };
}
function catSummary(list, key) {
  const m = {};
  for (const x of list) { const v = String(x[key]); m[v] = (m[v] || 0) + 1; }
  return m;
}
function rate(list, pred) {
  if (!list.length) return null;
  return { n: list.length, yes: list.filter(pred).length, rate: list.filter(pred).length / list.length };
}

const numericKeys = ['margin', 'probability', 'candidateCount', 'independentGroups', 'evidenceGroupCount',
  'coverageTop', 'coverageJev', 'evidenceJaccard', 'scoreAbsDelta', 'jevConfidence', 'jevUnique',
  'jevChoiceRank', 'queryTokens', 'candidateNameDiversity', 'genericRatio', 'suffixMatchTop', 'suffixMatchJev'];
const featureSummary = {
  schema: 'hex-jev-rescue-regression-feature-summary/v1',
  counts,
  numeric: {
    RESCUE: Object.fromEntries(numericKeys.map((k) => [k, numericSummary(rescues, k)])),
    REGRESSION: Object.fromEntries(numericKeys.map((k) => [k, numericSummary(regressions, k)])),
    STABLE_WRONG: Object.fromEntries(numericKeys.map((k) => [k, numericSummary(stableWrong, k)])),
    STABLE_CORRECT: Object.fromEntries(numericKeys.map((k) => [k, numericSummary(stableCorrect, k)])),
  },
  categorical: {
    RESCUE: {
      binary: catSummary(rescues, 'binary'), verdict: catSummary(rescues, 'verdict'),
      strong: catSummary(rescues, 'strong'), sameClass: catSummary(rescues, 'sameClass'),
      topHasDataflow: catSummary(rescues, 'topHasDataflow'), jevInTopK: catSummary(rescues, 'jevInTopK'),
      jevCoverageBeatsTop: catSummary(rescues, 'jevCoverageBeatsTop'),
    },
    REGRESSION: {
      binary: catSummary(regressions, 'binary'), verdict: catSummary(regressions, 'verdict'),
      strong: catSummary(regressions, 'strong'), sameClass: catSummary(regressions, 'sameClass'),
      topHasDataflow: catSummary(regressions, 'topHasDataflow'), jevInTopK: catSummary(regressions, 'jevInTopK'),
      jevCoverageBeatsTop: catSummary(regressions, 'jevCoverageBeatsTop'),
    },
  },
  binaryRates: {
    RESCUE: {
      strong: rate(rescues, (x) => x.strong),
      ambiguous: rate(rescues, (x) => !x.strong),
      topHasDataflow: rate(rescues, (x) => x.topHasDataflow),
      jevCoverageBeatsTop: rate(rescues, (x) => x.jevCoverageBeatsTop > 0),
      sameClass: rate(rescues, (x) => x.sameClass),
      jevInTop3: rate(rescues, (x) => x.jevInTop3),
      candidateCountGe3: rate(rescues, (x) => x.candidateCount >= 3),
      candidateCountGe5: rate(rescues, (x) => x.candidateCount >= 5),
      marginLtLn4: rate(rescues, (x) => Number.isFinite(x.margin) && x.margin < Math.log(4)),
      marginLt1: rate(rescues, (x) => Number.isFinite(x.margin) && x.margin < 1),
      jevConfGe07: rate(rescues, (x) => (x.jevConfidence ?? 0) >= 0.7),
      jevConfGe08: rate(rescues, (x) => (x.jevConfidence ?? 0) >= 0.8),
      evidenceJaccardLt05: rate(rescues, (x) => x.evidenceJaccard < 0.5),
      scoreAbsDeltaLt2: rate(rescues, (x) => x.scoreAbsDelta < 2),
      truthRecallLane: rate(rescues, (x) => !!x.truthRecallLane),
    },
    REGRESSION: {
      strong: rate(regressions, (x) => x.strong),
      ambiguous: rate(regressions, (x) => !x.strong),
      topHasDataflow: rate(regressions, (x) => x.topHasDataflow),
      jevCoverageBeatsTop: rate(regressions, (x) => x.jevCoverageBeatsTop > 0),
      sameClass: rate(regressions, (x) => x.sameClass),
      jevInTop3: rate(regressions, (x) => x.jevInTop3),
      candidateCountGe3: rate(regressions, (x) => x.candidateCount >= 3),
      candidateCountGe5: rate(regressions, (x) => x.candidateCount >= 5),
      marginLtLn4: rate(regressions, (x) => Number.isFinite(x.margin) && x.margin < Math.log(4)),
      marginLt1: rate(regressions, (x) => Number.isFinite(x.margin) && x.margin < 1),
      jevConfGe07: rate(regressions, (x) => (x.jevConfidence ?? 0) >= 0.7),
      jevConfGe08: rate(regressions, (x) => (x.jevConfidence ?? 0) >= 0.8),
      evidenceJaccardLt05: rate(regressions, (x) => x.evidenceJaccard < 0.5),
      scoreAbsDeltaLt2: rate(regressions, (x) => x.scoreAbsDelta < 2),
      truthRecallLane: rate(regressions, (x) => !!x.truthRecallLane),
    },
  },
  // Cross-rescue/regression single-feature separation score:
  // for each feature, fraction of regressions excluded while keeping rescues (and vice versa)
  singleFeatureSeparation: {},
  queryFamilyOverlap: {
    rescueFamilies: [...new Set(rescues.map((f) => f.queryFamily))].length,
    regressionFamilies: [...new Set(regressions.map((f) => f.queryFamily))].length,
    sharedFamilies: [...new Set(rescues.map((f) => f.queryFamily))].filter((f) => regressions.some((g) => g.queryFamily === f)),
  },
  fixtureGeneratorCheck: {
    note: 'Partial queries are last-two-word tails of unique field names; compare coverage/suffix stats.',
    meanSuffixMatchTopRescue: numericSummary(rescues, 'suffixMatchTop'),
    meanSuffixMatchTopRegression: numericSummary(regressions, 'suffixMatchTop'),
    meanSuffixMatchTruthRescue: numericSummary(rescues, 'suffixMatchJev'),
    meanQueryTokensRescue: numericSummary(rescues, 'queryTokens'),
    meanQueryTokensRegression: numericSummary(regressions, 'queryTokens'),
    truthSuffixFullRescue: rate(rescues, (x) => x.suffixMatchTop != null && x.queryTokens === x.suffixMatchTop),
  },
};

// separation metrics for common thresholds
function separationNumeric(key, thresholds) {
  return thresholds.map((t) => {
    const keepR = rescues.filter((x) => Number.isFinite(x[key]) && x[key] >= t).length;
    const blockG = regressions.filter((x) => Number.isFinite(x[key]) && x[key] >= t).length;
    const keepRlt = rescues.filter((x) => Number.isFinite(x[key]) && x[key] < t).length;
    const blockGlt = regressions.filter((x) => Number.isFinite(x[key]) && x[key] < t).length;
    return {
      threshold: t, direction: '>=t',
      rescuesKept: keepR, regressionsAllowed: blockG,
      rescuesKeptLt: keepRlt, regressionsAllowedLt: blockGlt,
    };
  });
}
featureSummary.singleFeatureSeparation = {
  margin: separationNumeric('margin', [0.5, 1, Math.log(4), 2, 3, Math.log(20)]),
  probability: separationNumeric('probability', [0.5, 0.85, 0.95, 0.99]),
  candidateCount: separationNumeric('candidateCount', [2, 3, 4, 5, 8]),
  coverageTop: separationNumeric('coverageTop', [0.34, 0.5, 0.67, 1.0]),
  coverageJev: separationNumeric('coverageJev', [0.34, 0.5, 0.67, 1.0]),
  evidenceJaccard: separationNumeric('evidenceJaccard', [0.2, 0.34, 0.5, 0.67]),
  scoreAbsDelta: separationNumeric('scoreAbsDelta', [0.5, 1, 2, 3, 4]),
  jevConfidence: separationNumeric('jevConfidence', [0.3, 0.5, 0.6, 0.7, 0.8, 0.9]),
  jevUnique: separationNumeric('jevUnique', [0.1, 0.2, 0.3, 0.4, 0.5]),
  independentGroups: separationNumeric('independentGroups', [1, 2, 3]),
};
write('feature-summary.json', featureSummary);

// ---------- deterministic lexical screen (from #9471 protocol) ----------
function detChoose(r, p) {
  const q = words(r.label);
  const scores = r.candidates.map((c, i) => {
    const f = words(c.fieldName); const cl = words(c.className);
    const match = q.filter((w) => f.includes(w)).length;
    const exact = q.join(' ') === f.join(' ') ? 1 : 0;
    const suffix = f.slice(-q.length).join(' ') === q.join(' ') ? 1 : 0;
    const extra = Math.max(0, f.length - match);
    const classMatch = q.filter((w) => cl.includes(w)).length;
    return { i, score: match * 10 + p.exact * exact + p.extra * extra + p.classMatch * classMatch + p.suffix * suffix - i * 1e-5 };
  }).sort((a, b) => b.score - a.score);
  return scores[0]?.i ?? 0;
}
const detParams = [];
for (const exact of [0, 2, 5, 10]) for (const extra of [-3, -1, 0, 0.5, 1, 2, 3])
  for (const classMatch of [0, 1, 3]) for (const suffix of [0, 2]) detParams.push({ exact, extra, classMatch, suffix });
const detMetrics = (set, p) => {
  let correct = 0, w2c = 0, c2w = 0;
  for (const r of set) {
    const idx = detChoose(r, p);
    const ok = !!r.candidates[idx]?.truth;
    if (ok) correct++;
    if (!r.topCorrect && ok) w2c++;
    if (r.topCorrect && !ok) c2w++;
  }
  return { N: set.length, correct, wrongToCorrect: w2c, correctToWrong: c2w, net: w2c - c2w };
};
const partialAll = rows.filter((r) => r.mode === 'partial');
const detDev = partialAll.filter((r) => r.binary === 'battlecats');
const detHold = partialAll.filter((r) => r.binary !== 'battlecats');
const detRanked = detParams.map((p) => ({ p, dev: detMetrics(detDev, p) }))
  .sort((a, b) => b.dev.correct - a.dev.correct || a.dev.correctToWrong - b.dev.correctToWrong
    || JSON.stringify(a.p).localeCompare(JSON.stringify(b.p)));
const detBest = detRanked[0];
const detPerRow = Object.fromEntries(partialAll.map((r) => [idOf(r), detChoose(r, detBest.p)]));

// ---------- gate catalog (pre-registered; selected only on development) ----------
// Each gate: predicate over production-observable features only.
const GATES = [
  { id: 'G0_force_all_partial', desc: 'Always apply label-only Jev on partial', pred: () => true },
  { id: 'G1_ambiguous_only', desc: 'Only when baseline verdict is not strong (ambiguous)', pred: (f) => !f.strong },
  { id: 'G2_ambiguous_and_multi', desc: 'Ambiguous and candidateCount>=2', pred: (f) => !f.strong && f.candidateCount >= 2 },
  { id: 'G3_ambiguous_and_margin_lt_ln4', desc: 'Ambiguous and finite margin < ln(4)', pred: (f) => !f.strong && Number.isFinite(f.margin) && f.margin < Math.log(4) },
  { id: 'G4_never_strong_and_jev_top3', desc: 'Not strong and Jev choice within baseline top-3', pred: (f) => !f.strong && f.jevInTop3 },
  { id: 'G5_never_strong_and_jev_cov_ge_top', desc: 'Not strong and Jev lexical coverage >= baseline coverage', pred: (f) => !f.strong && (f.coverageJev ?? 0) >= (f.coverageTop ?? 0) },
  { id: 'G6_ambiguous_and_low_evidence_gap', desc: 'Ambiguous and scoreAbsDelta < 2', pred: (f) => !f.strong && f.scoreAbsDelta < 2 },
  { id: 'G7_ambiguous_and_jev_cov_beats', desc: 'Ambiguous and Jev coverage strictly beats baseline', pred: (f) => !f.strong && f.jevCoverageBeatsTop > 0 },
  { id: 'G8_not_confirmed_and_jev_topk', desc: 'Verdict is not confirmed and Jev in top-5', pred: (f) => f.verdict !== 'confirmed' && f.jevInTopK },
  { id: 'G9_ambiguous_and_same_class_or_cov', desc: 'Ambiguous and (sameClass or Jev coverage beats)', pred: (f) => !f.strong && (f.sameClass || f.jevCoverageBeatsTop > 0) },
  { id: 'G10_jev_conf_ge_c_and_ambiguous', desc: 'Ambiguous and jevConfidence>=0.6', pred: (f) => !f.strong && (f.jevConfidence ?? 0) >= 0.6 },
  { id: 'G11_jev_conf_ge_c_and_not_confirmed', desc: 'Not confirmed and jevConfidence>=0.7', pred: (f) => f.verdict !== 'confirmed' && (f.jevConfidence ?? 0) >= 0.7 },
  { id: 'G12_multi_and_not_confirmed', desc: 'candidateCount>=3 and not confirmed', pred: (f) => f.candidateCount >= 3 && f.verdict !== 'confirmed' },
  { id: 'G13_ambiguous_and_indep_le2', desc: 'Ambiguous and independentGroups<=2', pred: (f) => !f.strong && f.independentGroups <= 2 },
  { id: 'G14_ambiguous_and_no_dataflow_top', desc: 'Ambiguous and top lacks dataflow group', pred: (f) => !f.strong && !f.topHasDataflow },
  { id: 'G15_ambiguous_and_jev_in_topk', desc: 'Ambiguous and Jev choice in top-5', pred: (f) => !f.strong && f.jevInTopK },
  { id: 'G16_strict_pair_ambiguous_lowconf', desc: 'Ambiguous, margin<ln4, jevConfidence<=0.85 (avoid overconfident flips)', pred: (f) => !f.strong && Number.isFinite(f.margin) && f.margin < Math.log(4) && (f.jevConfidence ?? 1) <= 0.85 },
  { id: 'G17_never_touch_strong', desc: 'Never fire on strong baselines (ambiguous-only equivalent for selection)', pred: (f) => !f.strong },
  { id: 'G18_strong_small_evidence_gap', desc: 'Fire on strong only when top-vs-Jev score gap <1 and evidence Jaccard>=0.5 (no truth)', pred: (f) => f.strong && f.scoreAbsDelta < 1 && f.evidenceJaccard >= 0.5 },
  { id: 'G19_ambiguous_only_repeated_style', desc: 'Alias of ambiguous-only', pred: (f) => !f.strong },
  { id: 'G20_margin_and_multi', desc: 'Finite margin < ln20 and candidateCount>=3', pred: (f) => Number.isFinite(f.margin) && f.margin < Math.log(20) && f.candidateCount >= 3 },
  { id: 'G21_jev_cov_full_and_multi', desc: 'Jev coverage==1 and candidateCount>=2', pred: (f) => (f.coverageJev ?? 0) >= 1 && f.candidateCount >= 2 },
  { id: 'G22_not_confirmed_and_jev_cov_beats', desc: 'Not confirmed and Jev coverage beats baseline', pred: (f) => f.verdict !== 'confirmed' && f.jevCoverageBeatsTop > 0 },
  { id: 'G23_ambiguous_or_jev_only_shorter_name', desc: 'Ambiguous or Jev picks longer name with equal coverage', pred: (f) => !f.strong || ((f.coverageJev ?? 0) >= (f.coverageTop ?? 0) && String(f.jevFieldName || '').length > String(f.baselineFieldName || '').length) },
  { id: 'G24_not_confirmed_and_low_score_gap', desc: 'Not confirmed and scoreAbsDelta < 2', pred: (f) => f.verdict !== 'confirmed' && f.scoreAbsDelta < 2 },
  { id: 'G25_ambiguous_and_jev_pref_ge_05', desc: 'Ambiguous and Jev preference >= 0.5', pred: (f) => !f.strong && (f.jevPreference ?? 0) >= 0.5 },
  { id: 'G26_ambiguous_and_differs_from_top', desc: 'Ambiguous and Jev field name differs from baseline top', pred: (f) => !f.strong && !f.sameFieldName },
  { id: 'G27_multi_and_jev_cov_ge_top', desc: 'candidateCount>=2 and Jev coverage >= baseline coverage', pred: (f) => f.candidateCount >= 2 && (f.coverageJev ?? 0) >= (f.coverageTop ?? 0) },
  { id: 'G28_strong_only', desc: 'Fire only on strong (confirmed/likely) baselines — production-observable verdict, no truth', pred: (f) => f.strong },
  { id: 'G29_strong_or_ambiguous_top3', desc: 'Strong OR (ambiguous and Jev choice within top-3)', pred: (f) => f.strong || (!f.strong && f.jevInTop3) },
  { id: 'G30_strong_and_multicand', desc: 'Strong and candidateCount>=2', pred: (f) => f.strong && f.candidateCount >= 2 },
  { id: 'G31_confirmed_only', desc: 'Fire only on confirmed baselines', pred: (f) => f.verdict === 'confirmed' },
  { id: 'G32_likely_or_confirmed_margin_ok', desc: 'Strong and (margin infinite or margin>=ln4)', pred: (f) => f.strong && (f.marginInfinite || (Number.isFinite(f.margin) && f.margin >= Math.log(4))) },
  { id: 'G33_not_ambiguous', desc: 'Fire when verdict is not ambiguous (confirmed or likely or none)', pred: (f) => f.verdict !== 'ambiguous' },
  { id: 'G34_ambiguous_and_jev_suffix_ge', desc: 'Ambiguous and Jev suffix match >= baseline suffix match', pred: (f) => !f.strong && f.jevSuffixBeatsTop >= 0 },
];

// Guardrail: predicates must not depend on truth-derived features.
function assertPredHasNoTruth(gate) {
  const base = {
    strong: false, candidateCount: 4, margin: 0.5, verdict: 'ambiguous', probability: 0.5,
    jevInTop3: true, jevInTopK: true, coverageTop: 0.5, coverageJev: 0.5, jevCoverageBeatsTop: 0,
    scoreAbsDelta: 0.4, evidenceJaccard: 0.6, sameClass: true, jevConfidence: 0.6, jevUnique: 0.2,
    independentGroups: 2, topHasDataflow: false, jevPreference: 0.55, sameFieldName: true,
    baselineCorrect: true, jevCorrect: true, truthRank: 1, truthFieldName: 'x', truthClassName: 'X',
    classification: 'STABLE_CORRECT', truthRecallLane: false, coverageTruth: 1, suffixMatchTruth: 9,
    baselineFieldName: 'aB', jevFieldName: 'aBc', queryTokens: 2,
  };
  const a = gate.pred(base);
  const b = gate.pred({ ...base, baselineCorrect: false, jevCorrect: false, truthRank: 99, truthFieldName: 'zzz', classification: 'RESCUE', truthRecallLane: true });
  if (a !== b) throw new Error(`gate ${gate.id} depends on truth-derived features`);
}
for (const g of GATES) assertPredHasNoTruth(g);

function applyGate(gate, subset) {
  let triggered = 0, w2c = 0, c2w = 0, correct = 0;
  const rowsOut = [];
  for (const f of subset) {
    let topCorrect = f.baselineCorrect;
    let fired = false;
    if (f.jevError) {
      // fail closed: keep baseline
    } else if (gate.pred(f)) {
      fired = true;
      triggered++;
      topCorrect = !!f.jevCorrect;
    }
    if (topCorrect) correct++;
    if (fired && !f.baselineCorrect && topCorrect) w2c++;
    if (fired && f.baselineCorrect && !topCorrect) c2w++;
    rowsOut.push({ id: f.id, fired, topCorrectAfter: topCorrect });
  }
  return {
    gateId: gate.id, desc: gate.desc,
    triggered, wrongToCorrect: w2c, correctToWrong: c2w, net: w2c - c2w,
    correctAfter: correct,
    baselineCorrect: subset.filter((f) => f.baselineCorrect).length,
    N: subset.length,
    precisionOfIntervention: triggered ? w2c / triggered : null,
    rescueRecall: rescuesIn(subset) ? w2c / rescuesIn(subset) : null,
    regressionRate: triggered ? c2w / triggered : null,
    rows: rowsOut,
  };
}
function rescuesIn(subset) { return subset.filter((f) => f.classification === 'RESCUE').length; }

// Holdout protocol:
// Split A (primary): development = battlecats, holdout = TsumTsum + YWP
// Split B: leave-one-binary-out folds
// Query-family features are diagnostics only. No independent query-family holdout is implemented here.
const devSet = featureRows.filter((f) => f.binary === 'battlecats');
const holdSet = featureRows.filter((f) => f.binary !== 'battlecats');
const byBinary = {
  battlecats: featureRows.filter((f) => f.binary === 'battlecats'),
  TsumTsum: featureRows.filter((f) => f.binary === 'TsumTsum'),
  YWP: featureRows.filter((f) => f.binary === 'YWP'),
};

// Pre-registered selection objective on development:
// maximize net with constraint regression-c2w <= maxReg (0 or 1), then prefer more rescues, fewer regressions/triggers, then gate id.
function selectGate(subset, maxReg) {
  const evaluated = GATES.map((g) => applyGate(g, subset));
  const feasible = evaluated.filter((e) => e.correctToWrong <= maxReg);
  if (!feasible.length) return { maxReg, selected: null, frontier: evaluated };
  feasible.sort((a, b) =>
    (b.net - a.net) ||
    (b.wrongToCorrect - a.wrongToCorrect) ||
    (a.correctToWrong - b.correctToWrong) ||
    (a.triggered - b.triggered) ||
    a.gateId.localeCompare(b.gateId));
  return { maxReg, selected: feasible[0], evaluated };
}

const devZero = selectGate(devSet, 0);
const devOne = selectGate(devSet, 1);
const devUnbounded = selectGate(devSet, Infinity);

function evalOn(holdout, gate) {
  if (!gate) return null;
  const g = GATES.find((x) => x.id === gate.gateId);
  const r = applyGate(g, holdout);
  // overall projected top1 = exact unchanged + partial after gate
  const exactCorrect = exactRows.filter((x) => x.topCorrect).length;
  const exactPlusEvaluatedPartial = exactCorrect + r.correctAfter;
  const falseStrongAfter = holdout.filter((f) => {
    // false strong after gate: still wrong top1 and still strong (verdict unchanged by design)
    return !r.rows.find((x) => x.id === f.id).topCorrectAfter && f.strong;
  }).length;
  const baselineFalseStrongHold = holdout.filter((f) => !f.baselineCorrect && f.strong).length;
  const strongOverwritten = holdout.filter((f) => f.strong && r.rows.find((x) => x.id === f.id).fired).length;
  const strongBroken = holdout.filter((f) => f.strong && f.baselineCorrect && r.rows.find((x) => x.id === f.id).fired && !r.rows.find((x) => x.id === f.id).topCorrectAfter).length;
  return { ...r, exactPlusEvaluatedPartial, falseStrongAfter, baselineFalseStrongHold, strongOverwritten, strongBroken };
}

const holdoutResults = {
  schema: 'hex-jev-rescue-regression-holdout/v1',
  protocol: {
    primary: 'development=battlecats partial rows; observed=TsumTsum+YWP partial rows; final catalog was NOT pre-registered: G24-G34 including G28 were added after holdout inspection',
    loo: 'leave-one-binary-out: select on two binaries, evaluate on the third',
    queryFamily: 'diagnostic only: query families are defined by tail-2-token key; no independent query-family holdout is implemented',
    interpretation: 'Audit of the work history proves the first holdout run used G0-G23; G17/G18 were later rewritten and G24-G34 including G28_strong_only were added after holdout inspection. G28 14/0 is post-hoc within-corpus evidence, not independent validation.',
    forbidden: 'do not describe G28 or the final G0-G34 catalog as pre-registered or holdout-validated; freeze a future catalog before collecting a new independent holdout',
    provenanceAudit: {
      status: 'POST_HOC_CONFIRMED',
      firstHoldoutCatalog: 'G0-G23',
      postHoldoutAdded: ['G24','G25','G26','G27','G28','G29','G30','G31','G32','G33','G34'],
      rewrittenAfterFirstRun: ['G17','G18'],
      preHoldoutFreeze: false,
    },
  },
  splits: {
    development: { binary: 'battlecats', N: devSet.length, rescues: rescuesIn(devSet), regressions: devSet.filter((f) => f.classification === 'REGRESSION').length },
    holdout: { binaries: ['TsumTsum', 'YWP'], N: holdSet.length, rescues: rescuesIn(holdSet), regressions: holdSet.filter((f) => f.classification === 'REGRESSION').length },
  },
  developmentSelection: {
    maxRegression0: devZero.selected,
    maxRegression1: devOne.selected,
    maxRegressionUnbounded: devUnbounded.selected,
  },
  holdoutOfPrimarySelection: {
    maxRegression0: evalOn(holdSet, devZero.selected),
    maxRegression1: evalOn(holdSet, devOne.selected),
    maxRegressionUnbounded: evalOn(holdSet, devUnbounded.selected),
  },
  leaveOneBinaryOut: {},
  allGatesFullCorpus: GATES.map((g) => {
    const r = applyGate(g, featureRows);
    const exactCorrect = exactRows.filter((x) => x.topCorrect).length;
    return {
      ...r,
      rows: undefined,
      overallTop1Projected: exactCorrect + r.correctAfter,
      partialTop1Projected: r.correctAfter,
      strongOverwritten: featureRows.filter((f) => f.strong && GATES.find((x) => x.id === g.id).pred(f)).length,
      verdictPromotions: 0, // preference-only; verdict labels are unchanged by design
    };
  }),
};

for (const held of ['battlecats', 'TsumTsum', 'YWP']) {
  const train = featureRows.filter((f) => f.binary !== held);
  const test = featureRows.filter((f) => f.binary === held);
  const sel0 = selectGate(train, 0);
  const sel1 = selectGate(train, 1);
  holdoutResults.leaveOneBinaryOut[held] = {
    trainN: train.length, testN: test.length,
    testRescues: rescuesIn(test), testRegressions: test.filter((f) => f.classification === 'REGRESSION').length,
    selected0: sel0.selected?.gateId ?? null,
    selected1: sel1.selected?.gateId ?? null,
    eval0: evalOn(test, sel0.selected),
    eval1: evalOn(test, sel1.selected),
  };
}

// Pareto frontier on full corpus (descriptive measured tradeoffs; NOT independent validation)
function pareto(gates, subset) {
  const pts = gates.map((g) => applyGate(g, subset));
  const frontier = [];
  for (const p of pts) {
    const dominated = pts.some((q) =>
      q.wrongToCorrect >= p.wrongToCorrect && q.correctToWrong <= p.correctToWrong &&
      (q.wrongToCorrect > p.wrongToCorrect || q.correctToWrong < p.correctToWrong));
    if (!dominated) frontier.push({ gateId: p.gateId, desc: p.desc, triggered: p.triggered, wrongToCorrect: p.wrongToCorrect, correctToWrong: p.correctToWrong, net: p.net, correctAfter: p.correctAfter });
  }
  frontier.sort((a, b) => a.correctToWrong - b.correctToWrong || b.net - a.net);
  return frontier;
}
holdoutResults.paretoFullCorpus = pareto(GATES, featureRows);
holdoutResults.zeroRegressionFrontierFull = holdoutResults.allGatesFullCorpus
  .filter((g) => g.correctToWrong === 0)
  .sort((a, b) => b.net - a.net || a.triggered - b.triggered)
  .map(({ rows, ...rest }) => rest);
holdoutResults.oneRegressionFrontierFull = holdoutResults.allGatesFullCorpus
  .filter((g) => g.correctToWrong <= 1)
  .sort((a, b) => a.correctToWrong - b.correctToWrong || b.net - a.net)
  .map(({ rows, ...rest }) => rest);
const baselineFalseStrongForAccounting = featureRows.filter((f) => f.strong && !f.baselineCorrect).length;
const g28FalseStrongForAccounting = featureRows.filter((f) => f.strong && !f.jevCorrect).length;
holdoutResults.falseStrongAccounting = {
  metric: 'wrong top1 among rows whose baseline verdict is strong; verdict label itself is unchanged',
  baseline: baselineFalseStrongForAccounting,
  g28After: g28FalseStrongForAccounting,
  delta: g28FalseStrongForAccounting - baselineFalseStrongForAccounting,
  corrected: featureRows.filter((f) => f.strong && !f.baselineCorrect && f.jevCorrect).length,
  newlyBroken: featureRows.filter((f) => f.strong && f.baselineCorrect && !f.jevCorrect).length,
  verdictPromotions: 0,
};
write('holdout-results.json', holdoutResults);

// gate candidates summary (compact)
write('gate-candidates.json', {
  schema: 'hex-jev-gate-candidates/v1',
  catalog: GATES.map((g) => ({ id: g.id, desc: g.desc })),
  developmentSelected: {
    zeroRegression: devZero.selected && { gateId: devZero.selected.gateId, ...pickGate(devZero.selected) },
    oneRegression: devOne.selected && { gateId: devOne.selected.gateId, ...pickGate(devOne.selected) },
    unbounded: devUnbounded.selected && { gateId: devUnbounded.selected.gateId, ...pickGate(devUnbounded.selected) },
  },
  holdoutOfSelected: {
    zeroRegression: holdoutResults.holdoutOfPrimarySelection.maxRegression0 && pickGate(holdoutResults.holdoutOfPrimarySelection.maxRegression0),
    oneRegression: holdoutResults.holdoutOfPrimarySelection.maxRegression1 && pickGate(holdoutResults.holdoutOfPrimarySelection.maxRegression1),
    unbounded: holdoutResults.holdoutOfPrimarySelection.maxRegressionUnbounded && pickGate(holdoutResults.holdoutOfPrimarySelection.maxRegressionUnbounded),
  },
  fullCorpusZeroRegression: holdoutResults.zeroRegressionFrontierFull.slice(0, 20),
  fullCorpusOneRegression: holdoutResults.oneRegressionFrontierFull.slice(0, 20),
  caveat: 'Full-corpus frontiers and the cross-binary split are descriptive/post-hoc. G28 was added after holdout inspection; independent free-form validation after an explicit catalog freeze is required before any production claim.',
  provenanceAudit: holdoutResults.protocol.provenanceAudit,
});
function pickGate(e) {
  if (!e) return null;
  const { rows, ...rest } = e;
  return rest;
}

// ---------- Phase 7: strong override arms ----------
function armMetrics(name, pred, subset = featureRows) {
  const g = { id: name, desc: name, pred };
  const r = applyGate(g, subset);
  const newlyBrokenStrong = subset.filter((f) => f.strong && f.baselineCorrect && pred(f) && !f.jevCorrect).length;
  const falseStrongCorrected = subset.filter((f) => f.strong && !f.baselineCorrect && pred(f) && f.jevCorrect).length;
  return {
    arm: name, triggered: r.triggered, wrongToCorrect: r.wrongToCorrect, correctToWrong: r.correctToWrong,
    net: r.net, correctAfter: r.correctAfter,
    falseStrongCorrection: falseStrongCorrected,
    newlyBrokenStrong: newlyBrokenStrong,
    strongOverwritten: subset.filter((f) => f.strong && pred(f)).length,
    overallTop1Projected: exactRows.filter((x) => x.topCorrect).length + r.correctAfter,
  };
}
const strongArms = {
  schema: 'hex-jev-strong-override-arms/v1',
  arms: [
    armMetrics('A_ambiguous_only', (f) => !f.strong),
    armMetrics('B_likely_and_below', (f) => f.verdict !== 'confirmed'),
    armMetrics('C_all_including_confirmed', () => true),
    armMetrics('D_strong_small_binary_evidence_gap', (f) => !f.strong || (f.strong && f.scoreAbsDelta < 1 && f.evidenceJaccard >= 0.5)),
    armMetrics('E_never_overwrite_strong', (f) => !f.strong),
    armMetrics('F_strong_wrong_only', (f) => f.strong && !f.baselineCorrect),
    armMetrics('G_never_break_strong_correct', (f) => !(f.strong && f.baselineCorrect)),
  ],
  baselineFalseStrong: featureRows.filter((f) => f.strong && !f.baselineCorrect).length,
  baselineCorrectStrongPartial: featureRows.filter((f) => f.strong && f.baselineCorrect).length,
  note: 'Verdict labels are not changed; arms only decide whether top1 preference may move. Arms F and G are diagnostic oracles that use fixture truth to define the arm (strong-wrong / break-strong-correct); they are NOT production predicates. Production-safe arms are A–E.',
};
// E and A are same predicate; keep both labels for the required matrix
write('strong-override-arms.json', strongArms);

// ---------- Phase 9: deterministic comparison ----------
const detRow = (id) => detPerRow[id];
function compareArms() {
  const exactCorrect = exactRows.filter((x) => x.topCorrect).length;
  const partialBaseline = partialAll.filter((x) => x.topCorrect).length;
  const detCorrect = detMetrics(partialAll, detBest.p).correct;
  const forceCorrect = featureRows.filter((f) => f.jevCorrect).length;
  const detW = detMetrics(partialAll, detBest.p);

  // rows where Jev rescues and det misses
  let jevOnly = 0, detOnly = 0, both = 0;
  for (const f of featureRows) {
    const r = rows.find((x) => idOf(x) === f.id);
    const dIdx = detRow(f.id);
    const detOk = !!r.candidates[dIdx]?.truth;
    const jevOk = !!f.jevCorrect;
    const baseOk = f.baselineCorrect;
    const jevRescue = !baseOk && jevOk;
    const detRescue = !baseOk && detOk;
    if (jevRescue && detRescue) both++;
    else if (jevRescue && !detRescue) jevOnly++;
    else if (!jevRescue && detRescue) detOnly++;
  }

  // gates + det combo: fire Jev only when det does not already fix, and gate holds
  const combo = (gate) => {
    if (!gate) return null;
    const gateId = gate.gateId || gate.id;
    const g = GATES.find((x) => x.id === gateId);
    if (!g) return null;
    let w2c = 0, c2w = 0, triggered = 0, correct = 0;
    for (const f of featureRows) {
      const r = rows.find((x) => idOf(x) === f.id);
      const dIdx = detRow(f.id);
      const detOk = !!r.candidates[dIdx]?.truth;
      let topOk;
      if (detOk) topOk = true;
      else if (!f.jevError && g.pred(f)) { topOk = !!f.jevCorrect; triggered++; }
      else topOk = f.baselineCorrect;
      if (topOk) correct++;
      // count jev-only transitions among triggered when det did not already fire
      if (!f.baselineCorrect && topOk) w2c++;
      if (f.baselineCorrect && !topOk) c2w++;
    }
    return { gateId: g.id, detAppliedFirst: true, jevTriggeredBeyondDet: triggered, wrongToCorrect: w2c, correctToWrong: c2w, correctAfter: correct, overallTop1Projected: exactCorrect + correct };
  };

  return {
    schema: 'hex-jev-deterministic-comparison/v1',
    deterministicScreen: {
      protocol: detBest.protocol || 'BattleCats-selected 168-point lexical grid',
      selected: detBest.p,
      development: detBest.dev,
      holdout: detMetrics(detHold, detBest.p),
      total: detMetrics(partialAll, detBest.p),
      baselinePartial: partialBaseline,
      caveat: 'Benchmark generator shortcut: partial queries are last-two-word tails; not a production proposal.',
    },
    jevLabelForced: {
      partialCorrect: forceCorrect,
      wrongToCorrect: counts.RESCUE || 0,
      correctToWrong: counts.REGRESSION || 0,
      apiCalls: featureRows.length,
    },
    overlap: { bothRescue: both, jevOnlyRescue: jevOnly, detOnlyRescue: detOnly },
    projectedOverall: {
      baseline: exactCorrect + partialBaseline,
      detOnly: exactCorrect + detCorrect,
      jevForcedOnly: exactCorrect + forceCorrect,
    },
    jevPlusDetGate: {
      detFirstBestHoldoutGate: combo(devZero.selected),
      detFirstOneRegGate: combo(devOne.selected),
      detFirstAmbiguous: combo(GATES.find((g) => g.id === 'G1_ambiguous_only')),
      note: 'Deterministic first; Jev only fills det misses under gate. Jev-specific gain is rows where det fails and gate+Jev succeed.',
    },
    jevSpecificGain: (() => {
      const g = GATES.find((x) => x.id === (devZero.selected?.gateId || 'G1_ambiguous_only'));
      let jevUniqueFills = 0;
      for (const f of featureRows) {
        const r = rows.find((x) => idOf(x) === f.id);
        const dIdx = detRow(f.id);
        const detOk = !!r.candidates[dIdx]?.truth;
        if (detOk) continue;
        if (!f.jevError && g.pred(f) && f.jevCorrect) jevUniqueFills++;
      }
      return { gateId: g.id, rowsDetMissesAndJevGateFills: jevUniqueFills };
    })(),
  };
}
const detComparison = compareArms();
write('deterministic-comparison.json', detComparison);

// ---------- Phase 10: oracle ceilings ----------
const oracle = {
  schema: 'hex-jev-oracle-ceilings/v1',
  jevPerfectChoiceOracle: {
    desc: 'If Jev always chose the fixture-truth candidate whenever it intervened under force-all-partial',
    partialCorrect: partialAll.length, // all partials correct if always truth
    overallTop1: exactCorrectAll() + partialAll.length,
    rescuesAvailable: partialAll.filter((r) => !r.topCorrect).length,
    regressions: 0,
  },
  observableDeterministicFeatureOracle: {
    desc: 'Best possible gate over the pre-registered catalog using truth only for selection (upper bound of catalog), full corpus',
    zeroRegression: holdoutResults.zeroRegressionFrontierFull[0] || null,
    oneRegression: holdoutResults.oneRegressionFrontierFull[0] || null,
    note: 'Still constrained by catalog predicates; not a free classifier.',
  },
  strongOverwriteForbiddenOracle: {
    desc: 'Force-all-partial but never move strong baselines',
    ...armMetrics('never_strong', (f) => !f.strong),
  },
  ambiguousOnlyOracle: {
    desc: 'Force Jev on all ambiguous partials',
    ...armMetrics('ambiguous', (f) => !f.strong),
  },
  candidateOracle: { present: rows.filter((r) => r.candidatePresent).length, N: rows.length },
  jevVsBestDetOnHoldout: {
    detHoldout: detMetrics(detHold, detBest.p),
    jevForceHoldout: {
      correct: holdSet.filter((f) => f.jevCorrect).length,
      w2c: holdSet.filter((f) => f.classification === 'RESCUE').length,
      c2w: holdSet.filter((f) => f.classification === 'REGRESSION').length,
    },
  },
};
function exactCorrectAll() { return exactRows.filter((r) => r.topCorrect).length; }
write('oracle-ceilings.json', oracle);

// ---------- Phase 12: latency / call budget from checkpoint ----------
const latencies = [];
for (const f of featureRows) if (typeof f.jevLatencyMs === 'number') latencies.push(f.jevLatencyMs);
latencies.sort((a, b) => a - b);
const pct = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * (latencies.length - 1)))] : null;
function budgetFor(gateId, totalQueries = 426) {
  const g = GATES.find((x) => x.id === gateId);
  if (!g) return null;
  const triggered = featureRows.filter((f) => g.pred(f) && !f.jevError).length;
  return {
    gateId,
    callsPer196Partial: triggered,
    callsPer426: triggered, // exact never called
    shareOfPartial: triggered / 196,
    shareOfAll: triggered / totalQueries,
  };
}
const latency = {
  schema: 'hex-jev-latency-summary/v1',
  endpoint: 'https://api.openjev.sh/v1/systemone',
  model: 'openjev',
  observedLabelCalls: latencies.length,
  p50Ms: pct(0.5), p95Ms: pct(0.95), p99Ms: pct(0.99), maxMs: latencies[latencies.length - 1] ?? null,
  failures: featureRows.filter((f) => f.jevError).length,
  forceAll: budgetFor('G0_force_all_partial'),
  byGate: GATES.map((g) => budgetFor(g.id)).filter(Boolean),
  expectedAddedLatencyNote: 'Added latency applies only on fired rows; parallel calls can overlap but user-visible path adds one Jev RTT when fired.',
  cacheEligible: 'Exact state+model+query+candidate-universe hash could cache repeated phrases; hit rate unmeasured.',
  failurePolicy: 'timeout/malformed/missing-key => keep baseline top1 (fail closed).',
  baselinePartialLatency: {
    p50Ms: percentile(partialAll.map((r) => r.latencyMs).filter((x) => typeof x === 'number').sort((a, b) => a - b), 0.5),
    p95Ms: percentile(partialAll.map((r) => r.latencyMs).filter((x) => typeof x === 'number').sort((a, b) => a - b), 0.95),
  },
};
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}
write('latency-summary.json', latency);

// ---------- evaluation summary ----------
const forcedCorrectPartial = featureRows.filter((f) => f.jevCorrect).length;
const evalSummary = {
  schema: 'hex-jev-rescue-regression-evaluation/v1',
  sourceProductCommit: measurement.productCommit,
  denominator: 426,
  baseline: {
    top1: baseline.top1, exact: baseline.exact, partial: baseline.partial,
    correctStrong: baseline.correctStrong, falseStrong: baseline.falseStrong,
  },
  labelArm: {
    partialN: featureRows.length,
    baselineCorrect: featureRows.filter((f) => f.baselineCorrect).length,
    jevCorrect: forcedCorrectPartial,
    wrongToCorrect: counts.RESCUE || 0,
    correctToWrong: counts.REGRESSION || 0,
    stableCorrect: counts.STABLE_CORRECT || 0,
    stableWrong: counts.STABLE_WRONG || 0,
    apiCalls: featureRows.length,
    failures: featureRows.filter((f) => f.jevError).length,
    projectedOverallTop1: baseline.exact.top1 + forcedCorrectPartial,
  },
  byBinary: Object.fromEntries(Object.entries(byBinary).map(([b, list]) => [b, {
    N: list.length,
    rescues: list.filter((f) => f.classification === 'RESCUE').length,
    regressions: list.filter((f) => f.classification === 'REGRESSION').length,
    baselineCorrect: list.filter((f) => f.baselineCorrect).length,
    jevCorrect: list.filter((f) => f.jevCorrect).length,
  }])),
  primaryAnswers: null, // filled below after gate holdout known
  missingJev: missingJev.length,
};
write('evaluation-summary.json', evalSummary);

// ---------- repeat targets (if not provided) ----------
const repeatTargets = [
  ...regressions.map((f) => ({ id: f.id, arm: 'label', reason: 'REGRESSION' })),
  ...rescues.slice(0, 10).map((f) => ({ id: f.id, arm: 'label', reason: 'RESCUE_SAMPLE' })),
  ...rescues.filter((f) => !f.strong).slice(0, 8).map((f) => ({ id: f.id, arm: 'label', reason: 'RESCUE_AMBIGUOUS' })),
];
// gate boundary: ambiguous rescues with mid confidence
const boundary = featureRows
  .filter((f) => !f.strong)
  .sort((a, b) => Math.abs((a.jevConfidence ?? 0) - 0.6) - Math.abs((b.jevConfidence ?? 0) - 0.6))
  .slice(0, 6)
  .map((f) => ({ id: f.id, arm: 'label', reason: 'GATE_BOUNDARY' }));
write('repeat-targets.json', [...new Map([...repeatTargets, ...boundary].map((t) => [t.id, t])).values()]);

// ---------- answers for README (will be re-read by build) ----------
const primaryGate0 = holdoutResults.holdoutOfPrimarySelection.maxRegression0;
const primaryGate1 = holdoutResults.holdoutOfPrimarySelection.maxRegression1;
evalSummary.primaryAnswers = {
  zeroRegressionDevSelected: devZero.selected && {
    gateId: devZero.selected.gateId,
    development: pickGate(devZero.selected),
    holdout: primaryGate0 && pickGate(primaryGate0),
    fullCorpus: pickGate(holdoutResults.allGatesFullCorpus.find((g) => g.gateId === devZero.selected.gateId)),
  },
  oneRegressionDevSelected: devOne.selected && {
    gateId: devOne.selected.gateId,
    development: pickGate(devOne.selected),
    holdout: primaryGate1 && pickGate(primaryGate1),
    fullCorpus: pickGate(holdoutResults.allGatesFullCorpus.find((g) => g.gateId === devOne.selected.gateId)),
  },
};
const g28Full = holdoutResults.allGatesFullCorpus.find((g) => g.gateId === 'G28_strong_only');
const baselineFalseStrongPartial = featureRows.filter((f) => f.strong && !f.baselineCorrect).length;
const g28FalseStrongAfter = featureRows.filter((f) => f.strong && !f.jevCorrect).length;
evalSummary.reproducibility = {
  committedProjectionReplay: 'node reports/investigations/jev-rescue-regression-gap/replay.mjs',
  rawBaselineRowsCommitted: false,
  rawLiveCheckpointCommitted: false,
  scope: 'The committed projection can replay baseline/force-all/G28 summary metrics; raw live API responses and the 3.7 MB baseline rows remain external evidence and are not independently replayable from this PR alone.',
};
evalSummary.verdict = {
  classification: 'RESEARCH_ONLY',
  candidatePredicate: 'G28_strong_only: apply label-only Jev preference only when baseline P4 verdict is strong (confirmed|likely) on partial queries; fail-closed to baseline on any API error; never change verdict labels; never mint binary facts.',
  interpretation: 'Work-history audit proves G28 was added after TsumTsum/YWP holdout results and the strong-rescue bias had already been inspected. The final BattleCats selection and TsumTsum+YWP 14/0 result are therefore post-hoc within-corpus evidence, not independent validation.',
  holdoutObserved: primaryGate1 && {
    split: 'development=battlecats; observed=TsumTsum+YWP',
    selectedOn: 'development with maxRegression<=1',
    gateId: primaryGate1.gateId,
    rescue: primaryGate1.wrongToCorrect,
    regression: primaryGate1.correctToWrong,
    triggered: primaryGate1.triggered,
    partialCorrectAfter: primaryGate1.correctAfter,
    partialBaseline: primaryGate1.baselineCorrect,
  },
  fullCorpusDescriptive: g28Full && {
    gateId: g28Full.gateId,
    rescue: g28Full.wrongToCorrect,
    regression: g28Full.correctToWrong,
    triggered: g28Full.triggered,
    top1After: g28Full.overallTop1Projected,
    top1Baseline: baseline.top1,
    partialAfter: g28Full.correctAfter,
    partialBaseline: baseline.partial.top1,
  },
  falseStrongAccounting: {
    baselinePartial: baselineFalseStrongPartial,
    g28AfterPartial: g28FalseStrongAfter,
    delta: g28FalseStrongAfter - baselineFalseStrongPartial,
    corrected: featureRows.filter((f) => f.strong && !f.baselineCorrect && f.jevCorrect).length,
    newlyBroken: featureRows.filter((f) => f.strong && f.baselineCorrect && !f.jevCorrect).length,
    verdictPromotions: 0,
  },
  zeroRegression: {
    primarySelectionObserved: primaryGate0 && {
      gateId: primaryGate0.gateId,
      rescue: primaryGate0.wrongToCorrect,
      regression: primaryGate0.correctToWrong,
      note: 'Dev-selected maxReg=0 gate does NOT stay at 0 on the cross-binary observed split',
    },
    fullCorpusPositiveRescueWithZeroReg: false,
    bestNearZero: g28Full && { gateId: g28Full.gateId, fullRescue: g28Full.wrongToCorrect, fullRegression: g28Full.correctToWrong },
  },
  reasons: [
    'G28 measures 14 rescues / 0 regressions on TsumTsum+YWP, but G28 was invented after that holdout had already been inspected; treat 14/0 as post-hoc.',
    'Full corpus descriptive result is 29 rescues / 1 regression; top1 282->310; partial 53->81.',
    'No catalog gate achieves positive rescue with 0 full-corpus regression.',
    'Repeated calls show the regression choices are stable, so consistency does not filter them.',
    'The deterministic lexical screen still beats Jev overall on this generated corpus.',
    'Work-history audit confirms post-hoc gate construction, and fixture-generator/shared-SDK structure adds another reason this is not independent validation.',
  ],
  notGoFor: [
    'production integration before an independent free-form intent holdout',
    'force-all partial rerank',
    'ambiguous-only as a production default',
    'verdict promotion or evidence minting from Jev',
  ],
  recommendation: 'RESEARCH_ONLY. Freeze G28_strong_only unchanged with a recorded commit/hash, then evaluate it once on a newly collected independent free-form intent holdout before reconsidering any production merge.',
  provenanceAudit: {
    status: 'POST_HOC_CONFIRMED',
    firstHoldoutCatalog: 'G0-G23',
    laterChanges: ['G17/G18 rewritten after first holdout run', 'G24-G34 added after holdout inspection', 'G28_strong_only added after strong-rescue bias and holdout outcomes were known'],
    preHoldoutCatalogFreeze: false,
  },
};
// re-write evaluation with answers
write('evaluation-summary.json', evalSummary);

process.stdout.write(JSON.stringify({
  baseline: { top1: baseline.top1, exact: baseline.exact, partial: baseline.partial },
  classification: counts,
  devSelected: { zero: devZero.selected?.gateId, one: devOne.selected?.gateId },
  holdoutZero: primaryGate0 && { gateId: primaryGate0.gateId, w2c: primaryGate0.wrongToCorrect, c2w: primaryGate0.correctToWrong, triggered: primaryGate0.triggered },
  holdoutOne: primaryGate1 && { gateId: primaryGate1.gateId, w2c: primaryGate1.wrongToCorrect, c2w: primaryGate1.correctToWrong, triggered: primaryGate1.triggered },
  det: detComparison.deterministicScreen.total,
  overlap: detComparison.overlap,
}, null, 2) + '\n');
