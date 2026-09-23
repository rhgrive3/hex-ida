/* Offline Pinpoint probe replay. Never used by the production scheduler. */
import { byRecallLane, narrowedPriorCount } from '../js/pinpoint.js';
import { decide, evidence, evidenceInfo, fuse } from '../js/evidence.js';

export const BUDGET = Object.freeze({ maxProbeCount: 6, maxAnalyzeCalls: 6, maxElapsedMs: 1000 });
export const STOP = Object.freeze({
  NEXT_PROBE: 'NEXT_PROBE', RESOLVED: 'STOP_RESOLVED',
  AMBIGUOUS: 'STOP_AMBIGUOUS', BUDGET: 'STOP_BUDGET',
  NO_USEFUL: 'STOP_NO_USEFUL_PROBE', TIMEOUT: 'STOP_TIMEOUT',
});
export const strong = (verdict) => verdict === 'confirmed' || verdict === 'likely';
export const queryId = (row) => `${row.binary}|${row.mode}|${row.label}`;

function validObservation(obs) {
  return obs && typeof obs.candidateId === 'string' && typeof obs.sourceIdentity === 'string'
    && obs.sourceIdentity.length > 0 && typeof obs.evidenceProvenance === 'string'
    && obs.evidenceProvenance.length > 0 && typeof obs.code === 'string'
    && evidenceInfo(obs.code) && Number.isFinite(obs.strength)
    && obs.strength >= 0 && obs.strength <= 1;
}

export function productionReplay(row, sequence = []) {
  const original = row.candidates || [];
  const ids = new Set(original.map((c) => c.key));
  if (ids.size !== original.length || !original.length) throw new Error('invalid candidate lattice');
  const added = new Map(original.map((c) => [c.key, []]));
  const knownCodes = new Map(original.map((c) => [c.key, new Set(c.evidence.map((e) => e.code))]));
  const knownSources = new Set();
  for (const candidate of original) {
    for (const item of candidate.evidence) {
      if (item.sourceIdentity) knownSources.add(`${candidate.key}|${item.sourceIdentity}|${item.code}`);
    }
  }
  for (const probe of sequence) {
    if (probe.failed || probe.timedOut || probe.unsupported || !Array.isArray(probe.observations)) continue;
    if (probe.observations.some((obs) => !validObservation(obs) || !ids.has(obs.candidateId))) continue;
    for (const obs of probe.observations) {
      const source = `${obs.candidateId}|${obs.sourceIdentity}|${obs.code}`;
      // One code per candidate is the conservative cap when legacy baseline
      // observations have no instruction identity. It cannot inflate scores.
      if (knownSources.has(source) || knownCodes.get(obs.candidateId).has(obs.code)) continue;
      knownSources.add(source);
      knownCodes.get(obs.candidateId).add(obs.code);
      added.get(obs.candidateId).push(evidence(obs.code, obs.strength, { sourceIdentity: obs.sourceIdentity }));
    }
  }
  const priorCandidates = narrowedPriorCount(original, row.universe);
  if (priorCandidates !== row.priorCandidates) throw new Error('prior mismatch');
  const ranked = original.map((candidate) => ({
    ...candidate,
    fusion: fuse([
      ...candidate.evidence.map((item) => evidence(item.code, item.strength, item.detail, item.lr)),
      ...added.get(candidate.key),
    ], { candidates: priorCandidates }),
  })).sort(byRecallLane);
  const decision = decide(ranked, { allowTrustedTwoGroup: true });
  const truthRank = ranked.findIndex((c) => c.className === row.expectedClass && c.fieldName === row.expectedField) + 1;
  return {
    top: ranked[0]?.key || null, runnerUp: ranked[1]?.key || null,
    topCorrect: truthRank === 1, truthRank,
    verdict: decision.verdict, margin: decision.margin,
    topFusion: ranked[0]?.fusion || null, runnerFusion: ranked[1]?.fusion || null,
    candidates: ranked, evidenceAdded: Object.fromEntries([...added].map(([k, v]) => [k, v.map((e) => e.code)])),
  };
}

export function assertBaselineParity(row) {
  const replay = productionReplay(row);
  const same = replay.top === row.topCandidate && replay.runnerUp === row.runnerUp
    && replay.truthRank === row.truthRank && replay.verdict === row.localVerdict
    && Math.abs(replay.topFusion.logOdds - row.topFusion.logOdds) < 1e-10
    && Math.abs(replay.topFusion.probability - row.topFusion.probability) < 1e-12
    && replay.topFusion.verified === row.topFusion.verified
    && replay.topFusion.identifying === row.topFusion.identifying
    && replay.topFusion.independentGroups === row.topFusion.independentGroups
    && replay.topFusion.groups.join('|') === row.topFusion.groups.join('|')
    && replay.candidates.length === row.candidates.length
    && replay.candidates.every((candidate, index) => {
      const expected = row.candidates[index];
      return candidate.key === expected.key
        && Math.abs(candidate.fusion.logOdds - expected.fusion.logOdds) < 1e-10
        && Math.abs(candidate.fusion.probability - expected.fusion.probability) < 1e-12
        && candidate.fusion.verified === expected.fusion.verified
        && candidate.fusion.identifying === expected.fusion.identifying
        && candidate.fusion.groups.join('|') === expected.fusion.groups.join('|');
    })
    && (Number.isFinite(replay.margin) ? Math.abs(replay.margin - row.margin) < 1e-10 : replay.margin === row.margin);
  if (!same) throw new Error(`empty sequence production parity failed: ${row.queryId}`);
  return true;
}

export function objective(result, cost = { probes: 0, calls: 0, elapsedMs: 0 }) {
  return [
    -(strong(result.verdict) && !result.topCorrect ? 1 : 0),
    result.topCorrect ? 1 : 0,
    strong(result.verdict) && result.topCorrect ? 1 : 0,
    result.verdict === 'ambiguous' ? -1 : 0,
    -cost.calls, -cost.probes, -cost.elapsedMs,
  ];
}
export function compareObjective(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function costOf(sequence) {
  return {
    probes: sequence.length,
    calls: sequence.reduce((n, p) => n + p.analysisCalls, 0),
    elapsedMs: sequence.reduce((n, p) => n + p.elapsedMs, 0),
  };
}

function estimatedCostOf(sequence) {
  return {
    probes: sequence.length,
    calls: sequence.reduce((n, p) => n + (p.estimatedAnalyzeCalls ?? (p.family === 'scan-access' ? 1 : 1)), 0),
    elapsedMs: sequence.reduce((n, p) => n + (p.estimatedElapsedMs ?? 0), 0),
  };
}

export function withinBudget(sequence, budget = BUDGET) {
  const c = costOf(sequence);
  return c.probes <= budget.maxProbeCount && c.calls <= budget.maxAnalyzeCalls
    && c.elapsedMs <= budget.maxElapsedMs;
}

function withinEstimatedBudget(sequence, budget = BUDGET) {
  const c = estimatedCostOf(sequence);
  return c.probes <= budget.maxProbeCount && c.calls <= budget.maxAnalyzeCalls
    && c.elapsedMs <= budget.maxElapsedMs;
}

export function evaluateSequence(row, sequence, budget = null) {
  if (budget && !withinBudget(sequence, budget)) throw new Error('sequence exceeds budget');
  const state = productionReplay(row, sequence);
  const cost = costOf(sequence);
  return {
    queryId: row.queryId, probeIds: sequence.map((p) => p.probeId),
    top: state.top, topCorrect: state.topCorrect, truthRank: state.truthRank,
    verdict: state.verdict, margin: state.margin, cost,
    objective: objective(state, cost),
  };
}

function scoreProbe(probe, row, state, kind, rates, sequence) {
  const rank = state.candidates.findIndex((c) => c.key === probe.candidateId);
  const c = state.candidates[rank];
  const familyRate = rates[probe.family] ?? 0;
  const gap = c && !c.fusion.groups.includes('dataflow') ? 1 : 0;
  const near = rank <= 1 ? 1 : rank <= 4 ? 0.5 : 0.1;
  const differential = rank === 0 ? -0.1 : rank === 1 ? 1 : 0.3;
  const cost = Math.max(0.1, probe.estimatedCost || 1);
  if (kind === 'H6') {
    const name = String(c?.fieldName || '').replace(/^_/, '').toLowerCase();
    const usedNames = new Set(sequence.map((applied) => {
      const target = row.candidates.find((candidate) => candidate.key === applied.candidateId);
      return String(target?.fieldName || '').replace(/^_/, '').toLowerCase();
    }));
    const novelName = usedNames.has(name) ? 0 : 1;
    const accessor = probe.family === 'getter-verification' || probe.family === 'setter-verification' ? 1 : 0;
    return 5 * novelName + 2 * accessor + near - 0.01 * Math.max(0, rank) - 0.1 * cost;
  }
  if (kind === 'H1') return 10 - rank - 0.1 * cost;
  if (kind === 'H2') return familyRate * near / cost;
  if (kind === 'H3') return 2 * gap + near - 0.1 * cost;
  if (kind === 'H4') return differential + near - 0.1 * cost;
  return 2 * familyRate / cost + gap + near + differential - 0.1 * cost;
}

export function runHeuristic(row, probes, kind, rates = {}, budget = BUDGET) {
  const sequence = [];
  const decisions = [];
  let remaining = probes.filter((p) => !p.unsupported && !p.baselineCovered
    && p.family !== 'scan-access');
  let stopReason = STOP.AMBIGUOUS;
  while (remaining.length) {
    const state = productionReplay(row, sequence);
    if (strong(state.verdict)) { stopReason = STOP.RESOLVED; break; }
    const affordable = remaining.filter((p) => withinEstimatedBudget([...sequence, p], budget));
    if (!affordable.length) { stopReason = STOP.BUDGET; break; }
    affordable.sort((a, b) => scoreProbe(b, row, state, kind, rates, sequence) - scoreProbe(a, row, state, kind, rates, sequence)
      || a.probeId.localeCompare(b.probeId));
    const next = affordable[0];
    if (!next) { stopReason = STOP.NO_USEFUL; break; }
    const remainingElapsedMs = Math.max(0, budget.maxElapsedMs - costOf(sequence).elapsedMs);
    if (Number.isFinite(next.elapsedMs) && next.elapsedMs > remainingElapsedMs) {
      sequence.push({ ...next, timedOut: true, observations: [], actualElapsedMs: next.elapsedMs, elapsedMs: remainingElapsedMs });
      decisions.push({ action: STOP.NEXT_PROBE, probeId: next.probeId });
      decisions.push({ action: STOP.TIMEOUT, probeId: next.probeId, chargedElapsedMs: remainingElapsedMs });
      stopReason = STOP.TIMEOUT;
      break;
    }
    decisions.push({ action: STOP.NEXT_PROBE, probeId: next.probeId });
    sequence.push(next);
    remaining = remaining.filter((p) => p.probeId !== next.probeId);
    if (sequence.length >= budget.maxProbeCount) { stopReason = STOP.BUDGET; break; }
  }
  if (strong(productionReplay(row, sequence).verdict)) stopReason = STOP.RESOLVED;
  else if (stopReason !== STOP.TIMEOUT && !remaining.length) stopReason = STOP.NO_USEFUL;
  decisions.push({ action: stopReason });
  return { ...evaluateSequence(row, sequence, budget), scheduler: kind, stopReason, decisions };
}

// Exact subset search over the finite independent probe truth table. Combining
// probes is replayed from raw evidence, so getter+writer interactions survive.
export function runOracle(row, probes, budget = null, seed = null) {
  const truth = row.candidates.find((c) => c.className === row.expectedClass
    && c.fieldName === row.expectedField);
  if (!truth) throw new Error('truth absent from focused lattice');
  // Every scored probe in this catalog only adds positive evidence to its
  // target. With an ambiguous baseline, raising a different candidate cannot
  // improve the lexicographic objective. This is an exact state reduction.
  const useful = probes.filter((p) => !p.failed && !p.timedOut && !p.unsupported
    && !p.baselineCovered && p.candidateId === truth.key && p.observations?.length
    && (productionReplay(row, [p]).evidenceAdded[p.candidateId] || []).length);
  // Identical candidate/code outcomes are equivalent under the conservative
  // one-code-per-candidate provenance rule. Keep the cheapest source.
  const canonical = new Map();
  for (const p of useful) {
    const key = p.observations.map((o) => `${o.candidateId}:${o.code}:${o.strength}`).sort().join('|');
    const old = canonical.get(key);
    if (!old || p.analysisCalls < old.analysisCalls
      || (p.analysisCalls === old.analysisCalls && p.elapsedMs < old.elapsedMs)) canonical.set(key, p);
  }
  const pool = [...canonical.values()].sort((a, b) => a.probeId.localeCompare(b.probeId));
  let best = seed || evaluateSequence(row, []);
  let states = 0;
  const memo = new Set();
  function visit(start, sequence) {
    const current = evaluateSequence(row, sequence);
    states++;
    if (compareObjective(current.objective, best.objective) > 0) best = current;
    if (budget && sequence.length >= budget.maxProbeCount) return;
    for (let i = start; i < pool.length; i++) {
      const next = [...sequence, pool[i]];
      if (budget && !withinBudget(next, budget)) continue;
      const replay = productionReplay(row, next);
      const digest = JSON.stringify(replay.evidenceAdded);
      const cost = costOf(next);
      const key = `${i}|${digest}|${next.length}|${cost.calls}|${cost.elapsedMs}`;
      if (memo.has(key)) continue;
      memo.add(key);
      visit(i + 1, next);
    }
  }
  visit(0, []);
  return { ...best, scheduler: budget ? 'Oracle B' : 'Oracle A', states, reducedProbeCount: pool.length, exact: true };
}
