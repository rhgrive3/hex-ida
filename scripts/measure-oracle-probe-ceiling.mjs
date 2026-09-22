#!/usr/bin/env node
/*
 * Oracle Probe Ceiling & Finite Probe Catalog Measurement Harness.
 *
 * Evaluates the theoretical ceiling of "scheduler intelligence" before Jev is implemented.
 * Does NOT implement Jev/OpenJev scheduler in production.
 *
 * Artifacts produced:
 *   - reports/investigations/pinpoint-confidence-calibration/probe-catalog.json
 *   - reports/investigations/pinpoint-confidence-calibration/oracle-classification.json
 *   - reports/investigations/pinpoint-confidence-calibration/oracle-summary.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { openBinary } from '../tests/harness.mjs';
import { pinpointField } from '../js/pinpoint.js';
import { parseGoal } from '../js/goals.js';
import { fuse, evidence, decide, VERDICT } from '../js/evidence.js';
import { verifyAccessor, selfRegisters } from '../js/verify.js';
import { findValueUpdates, constantComparisons } from '../js/dataflow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, 'reports/investigations/pinpoint-confidence-calibration');

const PRODUCTION_ANALYZE_BUDGET = 12;
const PRODUCTION_PROBE_BUDGET = 6;

// Useful criteria:
// 1. Rank gain: truth moves up in rank.
// 2. Separation gain: margin between top-1 truth and runner-up increases by >= ln(2).
// 3. Verdict elevation: promotes correct top-1 from ambiguous to likely/confirmed.
// 4. False-strong prevention: demotes or eliminates false-strong top candidate.
// 5. Decisive evidence added: adds getter-verified, setter-verified, rmw-verified, or written-in-class.

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const queries = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests/fixtures/pinpoint-confidence-queries.json'), 'utf8'));

  const worlds = new Map();
  const getWorld = async (binary) => {
    if (!worlds.has(binary)) {
      const target = binary === 'battlecats' ? 'tests/battlecats'
        : binary === 'TsumTsum' ? 'tests/TsumTsum' : 'tests/YWP';
      worlds.set(binary, await openBinary(target, { log: () => {} }));
    }
    return worlds.get(binary);
  };

  const catalogRecords = [];
  const queryClassifications = [];

  let totalQueries = 0;
  let exactQueries = 0;
  let partialQueries = 0;

  let baselineTop1 = 0;
  let oracleBTop1 = 0;
  let oracleATop1 = 0;

  let baselineCorrectStrong = 0;
  let oracleBCorrectStrong = 0;
  let oracleACorrectStrong = 0;

  let baselineFalseStrong = 0;
  let oracleBFalseStrong = 0;
  let oracleAFalseStrong = 0;

  let totalProbesEvaluated = 0;
  let usefulProbesCount = 0;

  const classCounts = {
    'PROBE-RESOLVABLE': 0,
    'BUDGET-RESOLVABLE': 0,
    'ONLY-UNBOUNDED-RESOLVABLE': 0,
    'INTENT-AMBIGUOUS': 0,
    'EVIDENCE-ABSENT': 0,
    'ANALYSIS-UNSUPPORTED': 0,
  };

  const familyUseful = {};
  const familyTotal = {};

  console.log(`Starting Oracle Probe Ceiling measurement across ${queries.length} queries...`);

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    totalQueries++;
    if (q.mode === 'exact') exactQueries++; else partialQueries++;

    const w = await getWorld(q.binary);
    let goal = null;
    try { goal = parseGoal(q.label); } catch { continue; }
    if (!goal) continue;

    // Run baseline analysis (production path without extra probes)
    let baselineAnalyzeCalls = 0;
    const analyzeCounter = async (...a) => { baselineAnalyzeCalls++; return w.analyze(...a); };
    const res = await pinpointField({
      goal, fields: w.fields, program: w.program, symbols: w.symbols,
      strings: w.strings, analyze: analyzeCounter, scanAccess: w.scanAccess, limit: 400,
    });

    const cands = (res && res.candidates) || [];
    const truthIdx0 = cands.findIndex((c) => c.className === q.class && c.field && c.field.name === q.ivar);
    const truthRank0 = truthIdx0 + 1; // 0 if not found
    const baselineTop = cands[0] || null;
    const baselineCorrect = truthIdx0 === 0;

    if (baselineCorrect) baselineTop1++;
    const isStrong = (v) => v === 'confirmed' || v === 'likely';
    if (baselineCorrect && isStrong(res.verdict)) baselineCorrectStrong++;
    if (!baselineCorrect && isStrong(res.verdict)) baselineFalseStrong++;

    // Generate available probes for top candidates (up to top 8)
    const probePool = generateProbePool(cands.slice(0, 8), q, w, goal);

    // Evaluate each probe on a clone of candidate state
    const probeResults = [];
    for (const probe of probePool) {
      totalProbesEvaluated++;
      familyTotal[probe.family] = (familyTotal[probe.family] || 0) + 1;

      const evalRes = await executeProbe(probe, cands, truthIdx0, res, q, w);
      probeResults.push(evalRes);
      catalogRecords.push(evalRes.record);

      if (evalRes.record.useful) {
        usefulProbesCount++;
        familyUseful[probe.family] = (familyUseful[probe.family] || 0) + 1;
      }
    }

    // Oracle Simulation
    // 1. Oracle A: Unbounded
    const oracleARes = simulateOracle(cands, truthIdx0, probeResults, Infinity, Infinity);
    if (oracleARes.topCorrect) oracleATop1++;
    if (oracleARes.topCorrect && isStrong(oracleARes.verdict)) oracleACorrectStrong++;
    if (!oracleARes.topCorrect && isStrong(oracleARes.verdict)) oracleAFalseStrong++;

    // 2. Oracle B: Budget-matched (<= 12 analyze calls, <= 6 probes)
    const oracleBRes = simulateOracle(cands, truthIdx0, probeResults, PRODUCTION_ANALYZE_BUDGET, PRODUCTION_PROBE_BUDGET);
    if (oracleBRes.topCorrect) oracleBTop1++;
    if (oracleBRes.topCorrect && isStrong(oracleBRes.verdict)) oracleBCorrectStrong++;
    if (!oracleBRes.topCorrect && isStrong(oracleBRes.verdict)) oracleBFalseStrong++;

    // Classify Query
    const classification = classifyQuery({
      query: q,
      baselineCorrect,
      baselineVerdict: res.verdict,
      truthRank: truthRank0,
      candidates: cands,
      oracleARes,
      oracleBRes,
      probeResults,
    });

    classCounts[classification.category] = (classCounts[classification.category] || 0) + 1;
    queryClassifications.push({
      binary: q.binary,
      mode: q.mode,
      label: q.label,
      expectedClass: q.class,
      expectedField: q.ivar,
      truthRankBaseline: truthRank0,
      baselineVerdict: res.verdict,
      oracleBRank: oracleBRes.truthRank,
      oracleBVerdict: oracleBRes.verdict,
      oracleARank: oracleARes.truthRank,
      oracleAVerdict: oracleARes.verdict,
      category: classification.category,
      reason: classification.reason,
    });

    if ((qi + 1) % 50 === 0 || qi === queries.length - 1) {
      console.log(`  [${qi + 1}/${queries.length}] processed. Current Oracle B top1: ${oracleBTop1}, Baseline top1: ${baselineTop1}`);
    }
  }

  // Summary Metrics
  const oracleSummary = {
    schema: 'hex-pinpoint-oracle-ceiling/v1',
    metadata: {
      totalQueries,
      exactQueries,
      partialQueries,
      productionAnalyzeBudget: PRODUCTION_ANALYZE_BUDGET,
      productionProbeBudget: PRODUCTION_PROBE_BUDGET,
    },
    top1Accuracy: {
      baseline: baselineTop1,
      oracleB: oracleBTop1,
      oracleA: oracleATop1,
      top1GainB: oracleBTop1 - baselineTop1,
      top1GainA: oracleATop1 - baselineTop1,
    },
    confidence: {
      baselineCorrectStrong,
      oracleBCorrectStrong,
      oracleACorrectStrong,
      baselineFalseStrong,
      oracleBFalseStrong,
      oracleAFalseStrong,
    },
    classificationCounts: classCounts,
    probeStatistics: {
      totalProbesEvaluated,
      usefulProbesCount,
      usefulRate: (usefulProbesCount / (totalProbesEvaluated || 1)).toFixed(4),
      byFamily: Object.fromEntries(Object.keys(familyTotal).map(k => [k, {
        total: familyTotal[k] || 0,
        useful: familyUseful[k] || 0,
        usefulRate: ((familyUseful[k] || 0) / (familyTotal[k] || 1)).toFixed(4),
      }])),
    },
  };

  // Write artifacts
  fs.writeFileSync(path.join(OUT_DIR, 'oracle-summary.json'), JSON.stringify(oracleSummary, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'oracle-classification.json'), JSON.stringify(queryClassifications, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'probe-catalog.json'), JSON.stringify(catalogRecords, null, 2) + '\n');

  console.log('Oracle Ceiling measurement complete. Artifacts written to:', OUT_DIR);
  console.log(JSON.stringify(oracleSummary, null, 2));
}

function generateProbePool(cands, q, w, goal) {
  const probes = [];
  let probeSeq = 1;

  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci];
    const candId = `${c.className}#${c.field.name}#${c.offset}`;

    // 1. Getter probe
    if (c.accessors && c.accessors.getter && c.accessors.getter.addr != null) {
      probes.push({
        probeId: `probe_${probeSeq++}_getter_${c.field.name}`,
        family: 'accessor_getter_verify',
        candidateIndex: ci,
        candidateId: candId,
        method: c.accessors.getter,
        estimatedCost: 1,
      });
    }

    // 2. Setter probe
    if (c.accessors && c.accessors.setter && c.accessors.setter.addr != null) {
      probes.push({
        probeId: `probe_${probeSeq++}_setter_${c.field.name}`,
        family: 'setter_verify',
        candidateIndex: ci,
        candidateId: candId,
        method: c.accessors.setter,
        estimatedCost: 1,
      });
    }

    // 3. Class-local method probe
    const methods = w.fields ? w.fields.classInfo(c.className)?.methods || [] : [];
    const matchingMethods = methods.filter((m) => m.addr != null && (m.sel || '').toLowerCase().includes(c.field.name.toLowerCase().replace(/^_/, '')));
    for (const m of matchingMethods.slice(0, 2)) {
      probes.push({
        probeId: `probe_${probeSeq++}_class_method_${m.sel}`,
        family: 'class_local_method_inspect',
        candidateIndex: ci,
        candidateId: candId,
        method: m,
        estimatedCost: 1,
      });
    }

    // 4. Shape evidence probe
    probes.push({
      probeId: `probe_${probeSeq++}_shape_${c.field.name}`,
      family: 'shape_evidence',
      candidateIndex: ci,
      candidateId: candId,
      estimatedCost: 0,
    });
  }

  return probes;
}

async function executeProbe(probe, cands, truthIdx0, baseRes, q, w) {
  const targetCand = cands[probe.candidateIndex];
  let actualCost = 0;
  let analysisCalls = 0;
  let evidenceAdded = [];
  let failed = false;
  let reason = '';

  const endOf = (addr) => {
    const r = w.program ? w.program.functionRange(addr) : null;
    return r ? r.end : null;
  };

  try {
    if (probe.family === 'accessor_getter_verify') {
      analysisCalls++;
      actualCost = 1;
      const model = await w.analyze(probe.method.addr, endOf(probe.method.addr));
      if (model) {
        const v = verifyAccessor(model, { offset: BigInt(targetCand.offset), size: targetCand.size });
        if (v.getter) {
          evidenceAdded.push(evidence('getter-verified', v.exclusive ? 1 : 0.75, {
            sel: probe.method.sel, addr: probe.method.addr, className: targetCand.className,
          }));
          if (v.size && targetCand.size && v.size === targetCand.size) {
            evidenceAdded.push(evidence('size-fits', 1, { size: v.size, measured: true }));
          }
        }
      }
    } else if (probe.family === 'setter_verify') {
      analysisCalls++;
      actualCost = 1;
      const model = await w.analyze(probe.method.addr, endOf(probe.method.addr));
      if (model) {
        const v = verifyAccessor(model, { offset: BigInt(targetCand.offset), size: targetCand.size });
        if (v.setter) {
          evidenceAdded.push(evidence('setter-verified', v.fromArgument ? 1 : 0.7, {
            sel: probe.method.sel, addr: probe.method.addr, className: targetCand.className,
          }));
        }
      }
    } else if (probe.family === 'class_local_method_inspect') {
      analysisCalls++;
      actualCost = 1;
      const model = await w.analyze(probe.method.addr, endOf(probe.method.addr));
      if (model) {
        const offset = BigInt(targetCand.offset);
        const { isSelf } = selfRegisters(model);
        let loads = 0, stores = 0;
        for (const insn of model.instructions || []) {
          const m = insn.memory;
          if (m && isSelf(m.base, insn.row) && m.disp === offset) {
            if (m.kind === 'load') loads++; else stores++;
          }
        }
        if (loads || stores) {
          evidenceAdded.push(evidence('access-verified', 1, { sel: probe.method.sel, loads, stores }));
          if (stores > 0) evidenceAdded.push(evidence('written-in-class', 1, { sel: probe.method.sel, n: stores }));
        }
      }
    } else if (probe.family === 'shape_evidence') {
      if (targetCand.size && targetCand.size <= 8) {
        evidenceAdded.push(evidence('size-fits', 0.8, { size: targetCand.size }));
      }
    }
  } catch (err) {
    failed = true;
    reason = String(err && err.message || err);
  }

  // Simulate ranked result if this probe is applied
  const clonedCands = cands.map((c, i) => {
    const evs = (c.evidence || []).slice();
    if (i === probe.candidateIndex) {
      for (const e of evidenceAdded) evs.push(e);
    }
    return {
      ...c,
      evidence: evs,
      fusion: fuse(evs, { candidates: cands.length }),
    };
  });

  clonedCands.sort((a, b) => (b.fusion?.logOdds ?? 0) - (a.fusion?.logOdds ?? 0));
  const newDecide = decide(clonedCands);
  const newTruthIdx = clonedCands.findIndex((c) => c.className === q.class && c.field && c.field.name === q.ivar);
  const rankBefore = truthIdx0 + 1;
  const rankAfter = newTruthIdx + 1;

  const verdictBefore = baseRes.verdict;
  const verdictAfter = newDecide.verdict;

  // Determine if useful
  let useful = false;
  if (rankAfter < rankBefore && rankAfter > 0) {
    useful = true;
    reason = `Truth rank improved from ${rankBefore} to ${rankAfter}`;
  } else if (rankBefore === 1 && rankAfter === 1) {
    if (verdictBefore === 'ambiguous' && (verdictAfter === 'likely' || verdictAfter === 'confirmed')) {
      useful = true;
      reason = `Verdict elevated from ${verdictBefore} to ${verdictAfter}`;
    } else if (newDecide.margin > (baseRes.margin || 0) + Math.log(2)) {
      useful = true;
      reason = `Separation margin increased by > ln(2)`;
    }
  }

  return {
    record: {
      probeId: probe.probeId,
      family: probe.family,
      candidateId: probe.candidateId,
      estimatedCost: probe.estimatedCost,
      actualCost,
      analysisCalls,
      evidenceBefore: (targetCand.evidence || []).map(e => e.code),
      evidenceAfter: (targetCand.evidence || []).map(e => e.code).concat(evidenceAdded.map(e => e.code)),
      rankBefore,
      rankAfter,
      verdictBefore,
      verdictAfter,
      useful,
      budgetConsumed: actualCost,
      failed,
      reason,
    },
    evidenceAdded,
    candidateIndex: probe.candidateIndex,
  };
}

function simulateOracle(cands, truthIdx0, probeResults, maxAnalyzeCalls, maxProbes) {
  // Greedy optimal probe application: select useful probes that benefit the truth or demote competitor
  const appliedProbes = [];
  let currentCalls = 0;

  // Sort probes by usefulness and efficiency (rank gain per call)
  const sorted = probeResults.filter((p) => p.record.useful).sort((a, b) => {
    const gainA = (a.record.rankBefore - a.record.rankAfter);
    const gainB = (b.record.rankBefore - b.record.rankAfter);
    return gainB - gainA;
  });

  const modifiedEvs = cands.map((c) => (c.evidence || []).slice());

  for (const pr of sorted) {
    if (appliedProbes.length >= maxProbes) break;
    if (currentCalls + pr.record.analysisCalls > maxAnalyzeCalls) break;

    appliedProbes.push(pr);
    currentCalls += pr.record.analysisCalls;
    for (const e of pr.evidenceAdded) {
      modifiedEvs[pr.candidateIndex].push(e);
    }
  }

  const finalCands = cands.map((c, i) => ({
    ...c,
    evidence: modifiedEvs[i],
    fusion: fuse(modifiedEvs[i], { candidates: cands.length }),
  }));

  finalCands.sort((a, b) => (b.fusion?.logOdds ?? 0) - (a.fusion?.logOdds ?? 0));
  const finalDecide = decide(finalCands);
  const finalTruthIdx = finalCands.findIndex((c) => c.className === cands[truthIdx0]?.className && c.field && c.field.name === cands[truthIdx0]?.field?.name);

  return {
    topCorrect: finalTruthIdx === 0,
    truthRank: finalTruthIdx + 1,
    verdict: finalDecide.verdict,
    analyzeCalls: currentCalls,
    probesApplied: appliedProbes.length,
  };
}

function classifyQuery({ query, baselineCorrect, baselineVerdict, truthRank, candidates, oracleARes, oracleBRes, probeResults }) {
  if (baselineCorrect && (baselineVerdict === 'confirmed' || baselineVerdict === 'likely')) {
    // Already strong correct
    return { category: 'PROBE-RESOLVABLE', reason: 'Already resolved and strong in baseline' };
  }

  if (oracleBRes.topCorrect && (oracleBRes.verdict === 'confirmed' || oracleBRes.verdict === 'likely')) {
    return { category: 'BUDGET-RESOLVABLE', reason: 'Resolved to correct strong within production budget' };
  }

  if (oracleARes.topCorrect && (oracleARes.verdict === 'confirmed' || oracleARes.verdict === 'likely')) {
    return { category: 'ONLY-UNBOUNDED-RESOLVABLE', reason: 'Resolved only under unbounded budget' };
  }

  // Check if multiple candidates match words with identical lexical strength
  const words = query.label.toLowerCase().split(/\s+/).filter(Boolean);
  const matchingCands = candidates.filter((c) => words.every(w => (c.field?.name || '').toLowerCase().includes(w)));
  if (matchingCands.length > 1) {
    return { category: 'INTENT-AMBIGUOUS', reason: `Multiple legitimate fields match query words (${matchingCands.map(c => c.field.name).slice(0, 3).join(', ')})` };
  }

  if (!probeResults.some(p => p.evidenceAdded.length > 0)) {
    return { category: 'EVIDENCE-ABSENT', reason: 'No binary evidence available from any probe to separate candidates' };
  }

  return { category: 'ANALYSIS-UNSUPPORTED', reason: 'Evidence separation requires deeper whole-program analysis' };
}

main().catch((err) => {
  console.error('Fatal error in oracle ceiling runner:', err);
  process.exit(1);
});
