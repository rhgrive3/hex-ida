#!/usr/bin/env node
/*
 * Plan-A confidence calibration aggregation.
 *
 * This is deliberately an offline reader of the one-pass current-main rows.
 * It never opens a binary, invokes analysis, or changes ranking.  Its job is
 * to make every denominator, policy counterfactual, failure class, and oracle
 * assumption reviewable from the durable JSONL evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessJevEligibility, JEV_ELIGIBILITY_VERSION } from '../js/pinpoint-jev-eligibility.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const DIR = path.resolve(ROOT, option('--out', 'reports/investigations/pinpoint-confidence-plan-a/current-main-p4'));
const OLD_COMMIT = option('--old-commit', '55a2dfc79a7d4a1028219d565518ff2996037f5b');
const OLD_ROWS_PATH = 'reports/investigations/pinpoint-confidence-calibration/rows.jsonl';

const POLICIES = [
  { id: 'A', column: 'policyAVerdict', name: 'current global 3-group gate' },
  { id: 'B', column: 'policyBPlanAVerdict', name: 'legacy any-group likely' },
  { id: 'C', column: 'policyCPlanAVerdict', name: 'partial-only 3-group gate' },
  { id: 'D', column: 'policyDPlanAVerdict', name: 'metadata + structural 2-group exemption' },
  { id: 'E', column: 'policyEPlanAVerdict', name: 'singleton two-group exemption' },
];
const SELECTED_POLICY = 'D';
const strong = (verdict) => verdict === 'confirmed' || verdict === 'likely';
const keyOf = (row) => `${row.binary}|${row.mode}|${row.label}`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function die(message) { throw new Error(`Plan-A aggregation: ${message}`); }
function jsonLines(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split('\n').filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { die(`invalid JSONL ${file}:${index + 1}: ${error.message}`); }
  });
}
function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
function write(file, value) {
  fs.writeFileSync(path.join(DIR, file), JSON.stringify(value, null, 2) + '\n');
}
function percent(n, d) { return d ? n / d : null; }
function qtile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
function numericSummary(values) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!finite.length) return { count: 0, min: null, max: null, mean: null, median: null, p95: null };
  return {
    count: finite.length,
    min: Math.min(...finite), max: Math.max(...finite),
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    median: qtile(finite, 0.5), p95: qtile(finite, 0.95),
  };
}
function rankBucket(rank) {
  if (!Number.isSafeInteger(rank) || rank <= 0) return 'not-found';
  if (rank === 1) return 'top1';
  if (rank <= 4) return 'rank2-4';
  if (rank <= 8) return 'rank5-8';
  return 'rank9+';
}
function groupsBucket(groups) {
  if (!Number.isSafeInteger(groups) || groups < 0) return 'invalid';
  return groups >= 3 ? '3+' : String(groups);
}
function mapCount(rows, key, make = () => ({ count: 0, correct: 0, incorrect: 0 })) {
  const out = {};
  for (const row of rows) {
    const name = key(row);
    const bucket = out[name] || (out[name] = make());
    bucket.count++;
    if (row.topCorrect === true) bucket.correct++; else bucket.incorrect++;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
function verdictMetrics(rows, column) {
  const verdicts = {
    confirmed: { correct: 0, incorrect: 0 }, likely: { correct: 0, incorrect: 0 },
    ambiguous: { correct: 0, incorrect: 0 }, none: { correct: 0, incorrect: 0 },
  };
  let candidatePresent = 0;
  let top1Correct = 0;
  for (const row of rows) {
    const verdict = typeof row[column] === 'string' ? row[column] : 'none';
    const bucket = verdicts[verdict] || (verdicts[verdict] = { correct: 0, incorrect: 0 });
    if (row.candidatePresent === true || row.truthRank > 0) candidatePresent++;
    if (row.topCorrect === true) { bucket.correct++; top1Correct++; } else bucket.incorrect++;
  }
  const correctConfirmed = verdicts.confirmed.correct;
  const correctLikely = verdicts.likely.correct;
  const falseConfirmed = verdicts.confirmed.incorrect;
  const falseLikely = verdicts.likely.incorrect;
  const correctStrong = correctConfirmed + correctLikely;
  const falseStrong = falseConfirmed + falseLikely;
  const allStrong = correctStrong + falseStrong;
  return {
    denominator: rows.length,
    candidatePresent, candidateNotFound: rows.length - candidatePresent,
    top1Correct, top1Incorrect: rows.length - top1Correct,
    candidateRecall: percent(candidatePresent, rows.length),
    rankingAccuracy: percent(top1Correct, rows.length),
    verdicts,
    correctConfirmed, correctLikely, correctStrong,
    falseConfirmed, falseLikely, falseStrong,
    strong: allStrong,
    strongCoverage: percent(correctStrong, rows.length),
    strongPrecision: percent(correctStrong, allStrong),
  };
}
function subsetsOf(field) {
  return {
    all: field,
    exact: field.filter((row) => row.mode === 'exact'),
    partial: field.filter((row) => row.mode === 'partial'),
    candidatePresent: field.filter((row) => row.candidatePresent === true || row.truthRank > 0),
    candidateNotFound: field.filter((row) => !(row.candidatePresent === true || row.truthRank > 0)),
    independentGroups2: field.filter((row) => row.independentGroups === 2),
    independentGroupsGte3: field.filter((row) => row.independentGroups >= 3),
  };
}
function metricsForPolicies(subsets) {
  return Object.fromEntries(POLICIES.map((policy) => [policy.id, {
    name: policy.name,
    column: policy.column,
    subsets: Object.fromEntries(Object.entries(subsets).map(([name, rows]) => [name, verdictMetrics(rows, policy.column)])),
  }]));
}
function scoreBuckets(rows) {
  const ranges = [
    ['<0.85', (p) => p < 0.85], ['0.85-0.90', (p) => p >= 0.85 && p < 0.90],
    ['0.90-0.95', (p) => p >= 0.90 && p < 0.95], ['0.95-0.99', (p) => p >= 0.95 && p < 0.99],
    ['>=0.99', (p) => p >= 0.99],
  ];
  const output = Object.fromEntries(ranges.map(([name]) => [name, { count: 0, correct: 0, incorrect: 0, groups: {} }]));
  for (const row of rows) {
    if (typeof row.probability !== 'number' || !Number.isFinite(row.probability)) continue;
    const pair = ranges.find(([, predicate]) => predicate(row.probability));
    if (!pair) continue;
    const entry = output[pair[0]];
    entry.count++;
    if (row.topCorrect) entry.correct++; else entry.incorrect++;
    const group = groupsBucket(row.independentGroups);
    entry.groups[group] = (entry.groups[group] || 0) + 1;
  }
  return output;
}
function evidenceSummary(rows) {
  const perGroup = {};
  const codes = {};
  for (const row of rows) {
    for (const group of row.groups || []) {
      const item = perGroup[group] || (perGroup[group] = { queries: 0, correct: 0, incorrect: 0 });
      item.queries++;
      if (row.topCorrect) item.correct++; else item.incorrect++;
    }
    for (const evidence of row.evidence || []) {
      const item = codes[evidence.code] || (codes[evidence.code] = { occurrences: 0, correct: 0, incorrect: 0, group: evidence.group || null });
      item.occurrences++;
      if (row.topCorrect) item.correct++; else item.incorrect++;
    }
  }
  return {
    combinations: mapCount(rows, (row) => (row.groups || []).slice().sort().join('+') || 'none'),
    individualGroups: Object.fromEntries(Object.entries(perGroup).sort(([a], [b]) => a.localeCompare(b))),
    topEvidenceCodes: Object.fromEntries(Object.entries(codes).sort(([, a], [, b]) => b.occurrences - a.occurrences || a.group.localeCompare(b.group))),
  };
}
function rankSummary(rows) {
  const rankBuckets = { 'not-found': 0, top1: 0, 'rank2-4': 0, 'rank5-8': 0, 'rank9+': 0 };
  const exactRanks = {};
  for (const row of rows) {
    rankBuckets[rankBucket(row.truthRank)]++;
    const key = String(row.truthRank || 0);
    exactRanks[key] = (exactRanks[key] || 0) + 1;
  }
  return { buckets: rankBuckets, exact: Object.fromEntries(Object.entries(exactRanks).sort(([a], [b]) => Number(a) - Number(b))) };
}
function compareCurrentAndHistorical(current, historical) {
  const historicByKey = new Map(historical.map((row) => [keyOf(row), row]));
  const currentByKey = new Map(current.map((row) => [keyOf(row), row]));
  if (historicByKey.size !== historical.length || currentByKey.size !== current.length) die('duplicate query identity in a comparison population');
  const transitions = [];
  let presenceChanged = 0, rankChanged = 0, topChanged = 0, verdictChanged = 0;
  for (const [key, before] of historicByKey) {
    const after = currentByKey.get(key);
    if (!after) die(`current measurement omits historical query ${key}`);
    const beforePresent = before.truthRank > 0;
    const afterPresent = after.truthRank > 0;
    const changed = beforePresent !== afterPresent || before.truthRank !== after.truthRank ||
      before.topClass !== after.topClass || before.topField !== after.topField || before.newVerdict !== after.policyAVerdict;
    if (beforePresent !== afterPresent) presenceChanged++;
    if (before.truthRank !== after.truthRank) rankChanged++;
    if (before.topClass !== after.topClass || before.topField !== after.topField) topChanged++;
    if (before.newVerdict !== after.policyAVerdict) verdictChanged++;
    if (changed) transitions.push({
      key, binary: after.binary, mode: after.mode, label: after.label,
      before: { candidatePresent: beforePresent, truthRank: before.truthRank, topClass: before.topClass, topField: before.topField, verdict: before.newVerdict },
      after: { candidatePresent: afterPresent, truthRank: after.truthRank, topClass: after.topClass, topField: after.topField, verdict: after.policyAVerdict },
    });
  }
  const oldSubsets = subsetsOf(historical.map((row) => ({ ...row, candidatePresent: row.truthRank > 0 })));
  const newSubsets = subsetsOf(current);
  const delta = (subset) => {
    const before = verdictMetrics(oldSubsets[subset], 'newVerdict');
    const after = verdictMetrics(newSubsets[subset], 'policyAVerdict');
    return {
      before, after,
      change: {
        candidatePresent: after.candidatePresent - before.candidatePresent,
        top1Correct: after.top1Correct - before.top1Correct,
        correctStrong: after.correctStrong - before.correctStrong,
        falseStrong: after.falseStrong - before.falseStrong,
      },
    };
  };
  return {
    historicRows: historical.length, currentRows: current.length,
    subsets: Object.fromEntries(['all', 'exact', 'partial', 'candidatePresent', 'candidateNotFound'].map((name) => [name, delta(name)])),
    rowTransitions: { presenceChanged, rankChanged, topChanged, verdictChanged, changedRows: transitions.length },
    recoveredPartialRows: transitions.filter((entry) => entry.mode === 'partial' && !entry.before.candidatePresent && entry.after.candidatePresent),
    changedRows: transitions,
  };
}
function candidateAt(row, rank) {
  return (row.candidates || []).find((candidate) => candidate.rank === rank) || null;
}
function positiveEvidenceTokens(candidate) {
  return new Set((candidate?.evidence || []).filter((item) => item && item.applied > 0)
    .map((item) => `${item.code}|${item.group || ''}|${item.kind || ''}|${item.identifying ? 'id' : ''}`));
}
function difference(a, b) { return [...a].filter((value) => !b.has(value)); }
function rankingOracle(field) {
  const rows = [];
  const counts = {
    rankingCorrect: 0, candidateAbsent: 0, snapshotMissing: 0,
    noCapturedDifferential: 0, truthHasRobustDeterministicDifferential: 0,
    metadataOrWeakDifferential: 0,
  };
  for (const row of field) {
    if (!(row.candidatePresent === true || row.truthRank > 0)) {
      counts.candidateAbsent++;
      rows.push({ key: keyOf(row), category: 'candidateAbsent' });
      continue;
    }
    if (row.topCorrect === true) {
      counts.rankingCorrect++;
      rows.push({ key: keyOf(row), category: 'rankingCorrect' });
      continue;
    }
    const top = candidateAt(row, 1);
    const truth = candidateAt(row, row.truthRank);
    if (!top || !truth || !truth.truth) {
      counts.snapshotMissing++;
      rows.push({ key: keyOf(row), category: 'snapshotMissing' });
      continue;
    }
    const topTokens = positiveEvidenceTokens(top);
    const truthTokens = positiveEvidenceTokens(truth);
    const truthOnly = difference(truthTokens, topTokens);
    const topOnly = difference(topTokens, truthTokens);
    const robustTruthOnly = truthOnly.filter((token) => token.includes('|verified|') ||
      (token.endsWith('|id') && !token.includes('|metadata|')));
    let category;
    if (!truthOnly.length && !topOnly.length) category = 'noCapturedDifferential';
    else if (robustTruthOnly.length) category = 'truthHasRobustDeterministicDifferential';
    else category = 'metadataOrWeakDifferential';
    counts[category]++;
    rows.push({
      key: keyOf(row), binary: row.binary, mode: row.mode, label: row.label,
      category, truthRank: row.truthRank, candidateCount: row.candidateCount,
      truthOnly, topOnly, robustTruthOnly,
    });
  }
  const potentiallyDistinguishable = counts.truthHasRobustDeterministicDifferential;
  return {
    definition: {
      noCapturedDifferential: 'top and truth have the same positive evidence-code/group/kind/id signature in the recorded lattice',
      truthHasRobustDeterministicDifferential: 'truth has a positive verified or non-metadata identifying evidence token absent from the wrong top; this is diagnostic potential, not a claim that a safe generic reranker already exists',
      metadataOrWeakDifferential: 'the feature signature differs only by metadata/weak signals, so the recorded lattice does not establish a safe direction for a generic reranker',
    },
    counts,
    observedTop1Correct: counts.rankingCorrect,
    candidateOracleCeiling: field.filter((row) => row.candidatePresent === true || row.truthRank > 0).length,
    diagnosticFeatureCeiling: counts.rankingCorrect + potentiallyDistinguishable,
    rows,
  };
}
function samePositiveEvidenceSignature(left, right) {
  const a = positiveEvidenceTokens(left);
  const b = positiveEvidenceTokens(right);
  return a.size === b.size && [...a].every((token) => b.has(token));
}
function jevEligibilityAnalysis(field, taxonomy) {
  const reasonCounts = {};
  const rows = [];
  for (const row of field) {
    const top = candidateAt(row, 1);
    const runner = candidateAt(row, 2);
    const deterministicEvidence = top && runner && samePositiveEvidenceSignature(top, runner)
      ? 'unresolved' : 'decisive';
    const decision = assessJevEligibility({
      queryMode: row.mode,
      candidateLattice: row.candidatePresent === true || row.truthRank > 0 ? 'complete' : 'truncated',
      candidateCount: row.candidateCount,
      localVerdict: row.policyDPlanAVerdict,
      deterministicEvidence,
      /* The corpus cannot know product impact.  This is an upper bound on the
         eligible shape if a caller independently marks the request high-impact. */
      highImpact: true,
      parserFailure: false, lifterFailure: false, functionExtentFailure: false,
    });
    reasonCounts[decision.reason] = (reasonCounts[decision.reason] || 0) + 1;
    rows.push({
      key: keyOf(row), binary: row.binary, mode: row.mode, label: row.label,
      candidatePresent: row.candidatePresent, candidateCount: row.candidateCount,
      localVerdict: row.policyDPlanAVerdict, topCorrect: row.topCorrect,
      deterministicEvidence, highImpactAssumedForMeasurement: true,
      eligible: decision.eligible, reason: decision.reason,
    });
  }
  const eligible = rows.filter((row) => row.eligible);
  const nonResolved = taxonomy.selectedPolicyD.rows.filter((row) => row.category !== 'resolved');
  const eligibleKeys = new Set(eligible.map((row) => row.key));
  return {
    schema: 'hex-pinpoint-jev-eligibility-analysis/v1',
    predicateVersion: JEV_ELIGIBILITY_VERSION,
    denominator: field.length,
    highImpactAssumption: 'Every measured shape is provisionally marked high-impact only to count the maximum eligible shape. A production caller must independently set highImpact=true.',
    deterministicEvidenceDefinition: 'unresolved means the ranked top and runner have equal positive evidence-code/group/kind/id signatures; any difference is treated as decisive for this conservative admission boundary.',
    reasonCounts,
    eligibleCount: eligible.length,
    eligibleTop1Correct: eligible.filter((row) => row.topCorrect).length,
    eligibleTop1Incorrect: eligible.filter((row) => !row.topCorrect).length,
    selectedPolicyNonResolved: nonResolved.length,
    notImprovedByThisJevBoundary: nonResolved.filter((row) => !eligibleKeys.has(row.key)).length,
    rows,
  };
}
function taxonomyFor(row, column) {
  const candidatePresent = row.candidatePresent === true || row.truthRank > 0;
  const verdict = row[column];
  if (!candidatePresent) return '1-candidate-absent';
  if (!row.topCorrect && strong(verdict)) return '4-wrong-top-strong';
  if (!row.topCorrect) return '2-ranking-wrong-nonstrong';
  if (!strong(verdict) && strong(row.policyDPlanAVerdict)) return '5-independence-policy-too-broad';
  if (!strong(verdict)) return '3-correct-top-confidence-too-weak';
  return 'resolved';
}
function failureTaxonomy(field) {
  const names = {
    '1-candidate-absent': 'truth candidate is absent from the candidate set',
    '2-ranking-wrong-nonstrong': 'truth is present, top-1 ranking is wrong, and verdict is not strong',
    '3-correct-top-confidence-too-weak': 'top-1 is correct but confidence remains weak after the selected policy',
    '4-wrong-top-strong': 'top-1 is wrong and receives a strong verdict',
    '5-independence-policy-too-broad': 'candidate/ranking are correct but the global group gate rejects the strictly independent metadata+structural pair',
    '6-other': 'other', resolved: 'correct top-1 with a strong verdict',
  };
  const make = (column) => {
    const counts = Object.fromEntries(Object.keys(names).map((name) => [name, 0]));
    const rows = [];
    for (const row of field) {
      const category = taxonomyFor(row, column);
      counts[category] = (counts[category] || 0) + 1;
      rows.push({
        key: keyOf(row), binary: row.binary, mode: row.mode, label: row.label,
        category, candidatePresent: row.candidatePresent, truthRank: row.truthRank,
        topCorrect: row.topCorrect, verdict: row[column], selectedVerdict: row.policyDPlanAVerdict,
        independentGroups: row.independentGroups, groups: row.groups,
      });
    }
    return { column, counts, rows };
  };
  return { mutuallyExclusivePriority: [
    '1-candidate-absent', '4-wrong-top-strong', '2-ranking-wrong-nonstrong',
    '5-independence-policy-too-broad', '3-correct-top-confidence-too-weak', 'resolved',
  ], names, currentPolicyA: make('policyAVerdict'), selectedPolicyD: make('policyDPlanAVerdict') };
}
function currentPolicyDelta(policies) {
  const current = policies.A.subsets.all;
  const selected = policies[SELECTED_POLICY].subsets.all;
  return {
    from: 'A', to: SELECTED_POLICY,
    correctStrong: selected.correctStrong - current.correctStrong,
    falseStrong: selected.falseStrong - current.falseStrong,
    falseConfirmed: selected.falseConfirmed - current.falseConfirmed,
    falseLikely: selected.falseLikely - current.falseLikely,
    exactCorrectStrong: policies[SELECTED_POLICY].subsets.exact.correctStrong - policies.A.subsets.exact.correctStrong,
    partialCorrectStrong: policies[SELECTED_POLICY].subsets.partial.correctStrong - policies.A.subsets.partial.correctStrong,
  };
}

const rows = jsonLines(path.join(DIR, 'rows.jsonl'));
const field = rows.filter((row) => row.kind === 'field');
const dsda = rows.filter((row) => row.kind === 'location');
const queries = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/pinpoint-confidence-queries.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'measurement.json'), 'utf8'));
if (!manifest.complete) die('measurement manifest is not complete');
if (field.length !== queries.length) die(`field denominator ${field.length} differs from fixture ${queries.length}`);
if (field.some((row) => row.error)) die('field measurement has errors');
if (field.some((row) => row.replayFidelity !== 'match')) die('current production/P1 replay fidelity mismatch');
for (const row of field) {
  if (!Array.isArray(row.candidates) || !row.candidates.length) die(`candidate snapshot missing for ${keyOf(row)}`);
  for (const policy of POLICIES) if (typeof row[policy.column] !== 'string') die(`policy ${policy.id} missing for ${keyOf(row)}`);
}

const subsets = subsetsOf(field);
const policies = metricsForPolicies(subsets);
const rankOracle = rankingOracle(field);
const taxonomy = failureTaxonomy(field);
const jev = jevEligibilityAnalysis(field, taxonomy);
const selected = policies[SELECTED_POLICY].subsets.all;
const candidateOracle = subsets.candidatePresent.length;
const confidenceOracle = selected.top1Correct;
const oracle = {
  schema: 'hex-pinpoint-confidence-oracle-ceiling/v1',
  denominator: field.length,
  candidateOracle: {
    definition: 'If the truth candidate is present, choose it.',
    correctTop1: candidateOracle, coverage: percent(candidateOracle, field.length),
    candidateRecallLoss: field.length - candidateOracle,
  },
  rankingOracle: {
    definition: 'A finite evidence-signature diagnostic over the candidates already generated; it does not create an ML model or new binary evidence.',
    observedTop1Correct: rankOracle.observedTop1Correct,
    observedTop1Accuracy: percent(rankOracle.observedTop1Correct, field.length),
    diagnosticFeatureCeiling: rankOracle.diagnosticFeatureCeiling,
    diagnosticFeatureCeilingAccuracy: percent(rankOracle.diagnosticFeatureCeiling, field.length),
    classification: {
      definition: rankOracle.definition, counts: rankOracle.counts,
      rowsPath: 'ranking-oracle-classification.json',
    },
  },
  confidenceOracle: {
    definition: 'Know whether the existing top-1 is correct and mark only correct top-1 rows strong.',
    correctStrongCeiling: confidenceOracle,
    strongCoverageCeiling: percent(confidenceOracle, field.length),
    falseStrongCeiling: 0,
    selectedPolicyCorrectStrong: selected.correctStrong,
    calibrationAbstentionGap: confidenceOracle - selected.correctStrong,
    selectedPolicyFalseStrong: selected.falseStrong,
  },
  lossDecomposition: {
    denominator: field.length,
    candidateRecallLoss: field.length - candidateOracle,
    rankingLossAfterCandidateRecall: candidateOracle - rankOracle.observedTop1Correct,
    confidenceCalibrationLossAfterCorrectTop1: rankOracle.observedTop1Correct - selected.correctStrong,
    residualFalseStrong: selected.falseStrong,
  },
};

const oldRaw = execFileSync('git', ['show', `${OLD_COMMIT}:${OLD_ROWS_PATH}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const oldRows = oldRaw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
const oldField = oldRows.filter((row) => row.kind === 'field' && !row.error);
if (oldField.length !== field.length) die(`historical field denominator ${oldField.length} differs from current ${field.length}`);
const oldVsCurrent = {
  schema: 'hex-pinpoint-confidence-old-vs-current/v1',
  historical: {
    commit: OLD_COMMIT,
    subject: git('show', '-s', '--format=%s', OLD_COMMIT),
    artifactPath: OLD_ROWS_PATH,
    rowsSha256: sha256(oldRaw),
    policyColumn: 'newVerdict',
  },
  current: {
    manifestPath: path.relative(ROOT, path.join(DIR, 'measurement.json')),
    productCommit: manifest.productCommit,
    productTree: manifest.productTree,
    policyColumn: 'policyAVerdict',
  },
  comparison: compareCurrentAndHistorical(field, oldField),
};

const summary = {
  schema: 'hex-pinpoint-confidence-plan-a-summary/v1',
  selectedPolicy: { id: SELECTED_POLICY, name: POLICIES.find((policy) => policy.id === SELECTED_POLICY).name },
  measurement: manifest,
  denominatorContract: {
    totalRows: rows.length, fieldRows: field.length, dsdaHoldoutRows: dsda.length,
    exactRows: subsets.exact.length, partialRows: subsets.partial.length,
    fieldOnly: true,
  },
  candidateRecall: {
    all: { present: subsets.candidatePresent.length, notFound: subsets.candidateNotFound.length, rate: percent(subsets.candidatePresent.length, field.length) },
    exact: { present: subsets.exact.filter((row) => row.candidatePresent).length, denominator: subsets.exact.length },
    partial: { present: subsets.partial.filter((row) => row.candidatePresent).length, denominator: subsets.partial.length },
  },
  ranking: {
    all: rankSummary(field), exact: rankSummary(subsets.exact), partial: rankSummary(subsets.partial),
    score: numericSummary(field.map((row) => row.probability)),
    margin: { finite: numericSummary(field.map((row) => row.margin)), infinity: field.filter((row) => row.marginInfinite).length },
    marginRatio: numericSummary(field.map((row) => row.marginRatio)),
    scoreBuckets: scoreBuckets(field),
  },
  independentGroups: {
    distribution: Object.fromEntries(['0', '1', '2', '3+'].map((bucket) => [bucket, field.filter((row) => groupsBucket(row.independentGroups) === bucket).length])),
    evidence: evidenceSummary(field),
  },
  policyComparison: policies,
  selectedPolicyDeltaFromA: currentPolicyDelta(policies),
  failureTaxonomy: {
    currentPolicyA: taxonomy.currentPolicyA.counts,
    selectedPolicyD: taxonomy.selectedPolicyD.counts,
    mutuallyExclusivePriority: taxonomy.mutuallyExclusivePriority,
  },
  oracle,
  oldVsCurrent: {
    path: 'old-vs-current.json',
    recoveredPartialRows: oldVsCurrent.comparison.recoveredPartialRows.length,
  },
  jevEligibility: {
    path: 'jev-eligibility-analysis.json', eligibleCount: jev.eligibleCount,
    notImprovedByThisJevBoundary: jev.notImprovedByThisJevBoundary,
  },
  performance: {
    collection: { singleAnalysisPerQuery: manifest.singleAnalysisPerQuery, replayAddsNoAnalysis: manifest.replayAddsNoAnalysis },
    runtimeHotPathChange: 'no candidate generation/ranking/analysis change; selected production rule inspects only the already-fused top evidence list after existing likely score/margin gates',
    selectedPolicyComplexity: 'O(top fusion evidence items), never O(candidate set) or global analysis',
  },
};

write('summary.json', summary);
write('policy-comparison.json', { schema: 'hex-pinpoint-confidence-policy-comparison/v1', denominator: field.length, policies, selectedPolicy: SELECTED_POLICY, deltaFromA: currentPolicyDelta(policies) });
write('failure-taxonomy.json', { schema: 'hex-pinpoint-confidence-failure-taxonomy/v1', denominator: field.length, ...taxonomy });
write('oracle-ceiling.json', oracle);
write('old-vs-current.json', oldVsCurrent);
write('ranking-oracle-classification.json', { schema: 'hex-pinpoint-ranking-oracle-classification/v1', denominator: field.length, ...rankOracle });
write('jev-eligibility-analysis.json', jev);
fs.writeFileSync(path.join(DIR, 'failure-rows.jsonl'), taxonomy.currentPolicyA.rows.map((row, index) => JSON.stringify({ ...row, selectedCategory: taxonomy.selectedPolicyD.rows[index].category })).join('\n') + '\n');

process.stdout.write(JSON.stringify({
  fieldRows: field.length,
  candidateRecall: summary.candidateRecall.all,
  rankingTop1: policies.A.subsets.all.rankingAccuracy,
  selected: policies.D.subsets.all,
  delta: summary.selectedPolicyDeltaFromA,
  historicRecoveredPartial: oldVsCurrent.comparison.recoveredPartialRows.length,
}, null, 2) + '\n');
