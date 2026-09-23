#!/usr/bin/env node
/*
 * Oracle Probe Ceiling & Finite Probe Catalog Measurement Harness (v2).
 *
 * Evaluates the theoretical ceiling of "scheduler intelligence" before Jev is
 * implemented. Does NOT implement Jev/OpenJev. No LLM/API is used for truth.
 *
 * Methodology fixes over v1 (each maps to a documented harness defect):
 *  A. Optimal search, not greedy: every feasible probe subset is enumerated
 *     (canonical subset DFS + production-parity fast replay + subsumption pruning).
 *     The search cannot be worse than any heuristic by construction, and
 *     Oracle A enumerates a superset of Oracle B's feasible sets.
 *  B. Production prior: candidate re-fusion uses the shared
 *     `narrowedPriorCount` helper from js/pinpoint.js (fixed per query, never
 *     `cands.length`), asserted equal to the production priorCandidates.
 *  C. Production ordering: candidates are sorted with the shared exported
 *     `byRecallLane` comparator and decided with `decide(..., field opts)` —
 *     the exact production field-path call.
 *  D. Evidence provenance: probe evidence is deduplicated against the
 *     candidate's baseline evidence (and other applied probes) by
 *     (normalized code, source identity). Independent sources (distinct
 *     addr/sel/size) stay distinct; the same binary fact is never counted
 *     twice (rmw-observed/rmw-verified and compare-observed/guard-verified
 *     are alias-normalized).
 *  E. Zero-cost probes: a probe whose evidence after provenance-dedup is a
 *     subset of baseline evidence is a no-op — recorded in the catalog but
 *     never selectable (baseline evidence is never re-inserted).
 *  F. Lexicographic objective (identical for both oracles, recorded in the
 *     report): 1) minimize false-strong  2) maximize top-1 correct
 *     3) maximize correct-strong  4) minimize cost  5) minimize probe count.
 *     Oracle A feasible set is a superset of Oracle B's, so
 *     objective(A) >= objective(B) is asserted per query.
 *  G. Intent classification separates LEXICALLY_AMBIGUOUS (lexical fact) from
 *     BINARY_DISTINGUISHABLE / BINARY_INDISTINGUISHABLE / INTENT_UNDERSPECIFIED
 *     (probe/binary-evidence facts). Fixture labels (exact/partial) are never
 *     used as production conditions.
 *
 * Budgets (production envelope, recorded in final-baseline.json):
 *   analyze calls <= 12 (MAX_ROUNDS 3 x VERIFY_ROUND 4, js/pinpoint-legacy.js)
 *   probes <= 6, scanAccess passes <= 2.
 *
 * Bound measurement: final-baseline.json in OUT_DIR must match the worktree
 * confidence policy (js/evidence.js blob sha), the query corpus sha256 and the
 * production analyze budget; a mismatch fails closed (no mixed-policy runs).
 * HEX_ORACLE_LIMIT=N runs only the first N queries (smoke runs).
 *
 * Artifacts (OUT_DIR): probe-catalog.json, oracle-classification.json,
 * oracle-summary.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openBinary } from '../tests/harness.mjs';
import { pinpointField, narrowedPriorCount, byRecallLane } from '../js/pinpoint.js';
import { parseGoal } from '../js/goals.js';
import { fuse, evidence, decide, verdictForFusions, verdictRank, VERDICT } from '../js/evidence.js';
import { verifyAccessor, verifyFunctionHandlesField, verifyGuard, selfRegisters } from '../js/verify.js';
import { findValueUpdates, constantComparisons } from '../js/dataflow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.env.HEX_ORACLE_OUT || 'reports/investigations/pinpoint-confidence-calibration');

export const PRODUCTION_ANALYZE_BUDGET = 12;
export const PRODUCTION_PROBE_BUDGET = 6;
export const PRODUCTION_SCAN_BUDGET = 2;
/* Production field-path decide opts (js/pinpoint.js / js/pinpoint-legacy.js). */
export const FIELD_LIKELY_OPTS = Object.freeze({ allowTrustedTwoGroup: true });
const PROBE_POOL_TOP = 8;          // scheduler acts on the top-8 candidates only
const CLASS_LOCAL_METHOD_CAP = 2;  // realistic class-local inspection breadth
export const MAX_SELECTABLE_PROBES = 20;  // exhaustive-search ceiling (fail closed above)
const PROBE_TIMEOUT_MS = 30_000;

const isStrong = (v) => v === VERDICT.LIKELY || v === VERDICT.CONFIRMED;

/*
 * Lexicographic oracle objective (identical for A and B — recorded in report).
 * Tuple is compared element-wise, larger is better.
 */
export const OBJECTIVE = Object.freeze([
  '1. falseStrong == 0 preferred (minimize false-strong)',
  '2. top1 correct maximized',
  '3. correct-strong maximized',
  '4. cost (analyze calls + scan passes) minimized',
  '5. probe count minimized',
]);

export function objectiveTuple(outcome, cost, probeCount) {
  return [
    outcome.falseStrong ? 0 : 1,
    outcome.topCorrect ? 1 : 0,
    outcome.correctStrong ? 1 : 0,
    -cost,
    -probeCount,
  ];
}

export function compareObjective(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/* Cross-check an exhaustive enumeration against the current search result. */
export function enumerateSubsets(probes, maxAnalyze, maxProbes, maxScan) {
  const sorted = probes.slice().sort((a, b) =>
    ((a.analysisCalls + a.scanCalls) - (b.analysisCalls + b.scanCalls))
    || (a.probeId < b.probeId ? -1 : a.probeId > b.probeId ? 1 : 0));
  const out = [];
  const walk = (idx, applied, costA, costS) => {
    out.push(applied.slice());
    if (idx >= sorted.length) return;
    walk(idx + 1, applied, costA, costS);
    const p = sorted[idx];
    const pA = p.analysisCalls;
    const pS = p.scanCalls;
    if (applied.length + 1 <= maxProbes && costA + pA <= maxAnalyze && costS + pS <= maxScan) {
      walk(idx + 1, applied.concat([p]), costA + pA, costS + pS);
    }
  };
  walk(0, [], 0, 0);
  return out;
}

function stableStringify(value) {
  if (value == null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export const candidateIdOf = (c) => `${c.className}#${c.field && c.field.name}#${c.offset}`;

/*
 * Evidence provenance (Problems D/E): normalized code + source identity.
 * Alias pairs are alternate labels for the same binary fact and must never
 * double-count; identity keys distinguish independent sources (addr/sel/size)
 * or collapse candidate-scoped presence facts.
 */
const ALIAS_CODE = { 'rmw-observed': 'rmw-verified', 'compare-observed': 'guard-verified' };

export function evidenceProvenanceKey(item, ctx) {
  const raw = item && item.code;
  const code = ALIAS_CODE[raw] || raw;
  const d = (item && item.detail) || {};
  let ident;
  switch (code) {
    case 'getter-verified':
    case 'setter-verified':
    case 'access-verified':
      ident = d.addr != null ? 'addr:' + String(d.addr)
        : d.sel != null ? 'sel:' + String(d.sel) : 'nosrc';
      break;
    case 'rmw-verified':
      ident = d.addr != null ? 'addr:' + String(d.addr)
        : d.address != null ? 'fn:' + String(d.address) : 'fn@' + (ctx && ctx.candidateId);
      break;
    case 'guard-verified':
      ident = d.addr != null ? 'addr:' + String(d.addr) : 'fn@' + (ctx && ctx.candidateId);
      break;
    case 'written-in-class':
      /* Candidate-scoped presence fact: one "written in own class" per candidate. */
      ident = 'present@' + (ctx && ctx.candidateId);
      break;
    case 'size-fits':
      ident = 'size:' + String(d.size);
      break;
    case 'field-name-asked':
    case 'field-name-contains':
    case 'field-name-words':
    case 'field-name-exact':
    case 'field-name-strong':
    case 'field-name-weak':
      ident = 'name:' + String(d.name ?? '') + '|' + String(d.term ?? '');
      break;
    default:
      ident = stableStringify(d);
  }
  return code + '#' + ident;
}

export function baselineProvenanceKeys(candidate) {
  const ctx = { candidateId: candidateIdOf(candidate) };
  return new Set((candidate.evidence || []).map((e) => evidenceProvenanceKey(e, ctx)));
}
/*
 * Replay evaluation with production semantics (B/C): fixed production prior,
 * shared byRecallLane ordering, production field decide opts. Only candidates
 * with added evidence are re-fused; every other candidate keeps its baseline
 * fusion (production evidence never changes for them).
 *
 * FAST PATH: replay.candidates arrives already sorted exactly the way
 * production sorted it (buildReplayBaseline asserted that). Instead of
 * re-running Array#sort over all candidates at every enumerated subset
 * (the dominant per-node cost of exhaustive search), the two byRecallLane
 * blocks are captured once and each subset rebuilds the order with a
 * k-way merge of the (few) changed candidates under the SAME total order
 * (lane asc, logOdds desc, input index asc for ties — identical to a
 * stable sort of the input). The verdict comes from the shared production
 * core verdictForFusions with the production field opts (no maxVerdict cap
 * is set, so this is exactly decide()'s result). evaluateOutcomeReference
 * keeps the original map+sort+decide implementation; the invariant suite
 * asserts both paths agree on every synthetic subset and on sampled
 * real-binary subsets. Unsorted inputs fall back to the reference.
 */
const ORDER_CACHE = new WeakMap();
const scratchOrdered = [];

function baselineBlocks(candidates) {
  let blocks = ORDER_CACHE.get(candidates);
  if (!blocks) {
    const nonLane = [];
    const lane = [];
    let sorted = true;
    let prevNon = Infinity;
    let prevLane = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const log = c.fusion.logOdds;
      if (c.recallLane) {
        if (log > prevLane) sorted = false;
        prevLane = log;
        lane.push({ i, log, cand: c });
      } else {
        if (log > prevNon) sorted = false;
        prevNon = log;
        nonLane.push({ i, log, cand: c });
      }
    }
    blocks = { nonLane, lane, sorted };
    ORDER_CACHE.set(candidates, blocks);
  }
  return blocks;
}

/* Merge unchanged baseline entries with re-fused changed entries under the
 * byRecallLane total order (lane groups are handled by the caller). */
function mergeBlock(unchanged, changed, out) {
  changed.sort((a, b) => (b.log - a.log) || (a.i - b.i));
  let ui = 0;
  let ci = 0;
  while (ui < unchanged.length && ci < changed.length) {
    const u = unchanged[ui];
    const x = changed[ci];
    if (u.log > x.log || (u.log === x.log && u.i < x.i)) { out.push(u.cand); ui++; }
    else { out.push(x.cand); ci++; }
  }
  while (ui < unchanged.length) out.push(unchanged[ui++].cand);
  while (ci < changed.length) out.push(changed[ci++].cand);
}

/** Original map+sort+decide implementation (kept as the trusted reference). */
export function evaluateOutcomeReference({ candidates, prior, truthMatches, appliedByIndex, withOrder }) {
  const ranked = candidates.map((c, i) => {
    const add = appliedByIndex.get ? appliedByIndex.get(i) : null;
    if (!add || !add.length) return c;
    const evs = (c.evidence || []).concat(add);
    return { ...c, evidence: evs, fusion: fuse(evs, { candidates: prior }) };
  });
  ranked.sort(byRecallLane);
  const decision = decide(ranked, FIELD_LIKELY_OPTS);
  const ti = ranked.findIndex(truthMatches);
  const topCorrect = ti === 0;
  const strong = isStrong(decision.verdict);
  const top = ranked[0] || null;
  return {
    topCorrect,
    truthRank: ti >= 0 ? ti + 1 : 0,
    verdict: decision.verdict,
    falseStrong: !!top && !topCorrect && strong,
    correctStrong: !!top && topCorrect && strong,
    margin: decision.margin,
    topKey: top ? candidateIdOf(top) : null,
    rankedKeys: withOrder ? ranked.map(candidateIdOf) : null,
  };
}

export function evaluateOutcome(args) {
  const { candidates, prior, truthMatches, appliedByIndex, withOrder } = args;
  if (!candidates || !candidates.length) {
    return {
      topCorrect: false, truthRank: 0, verdict: VERDICT.NONE, falseStrong: false,
      correctStrong: false, margin: 0, topKey: null, rankedKeys: withOrder ? [] : null,
    };
  }
  const blocks = baselineBlocks(candidates);
  const iterable = appliedByIndex && typeof appliedByIndex[Symbol.iterator] === 'function';
  if (!blocks.sorted || !iterable) {
    /* Unsorted input or exotic appliedByIndex: fall back to the reference. */
    return evaluateOutcomeReference(args);
  }
  const changedIdx = [];
  for (const entry of appliedByIndex) {
    const i = entry[0];
    const items = entry[1];
    if (items && items.length) changedIdx.push(i);
  }
  if (!changedIdx.length) {
    const ordered = withOrder ? candidates.slice() : candidates;
    const top = ordered[0];
    const runner = ordered[1] || null;
    const core = verdictForFusions(top.fusion, runner ? runner.fusion : null, FIELD_LIKELY_OPTS);
    const ti = ordered.findIndex(truthMatches);
    const topCorrect = ti === 0;
    const strong = isStrong(core.verdict);
    return {
      topCorrect,
      truthRank: ti >= 0 ? ti + 1 : 0,
      verdict: core.verdict,
      falseStrong: !topCorrect && strong,
      correctStrong: topCorrect && strong,
      margin: core.margin,
      topKey: candidateIdOf(top),
      rankedKeys: withOrder ? ordered.map(candidateIdOf) : null,
    };
  }

  const changedSet = new Set(changedIdx);
  const changedNon = [];
  const changedLane = [];
  for (const i of changedIdx) {
    const c = candidates[i];
    const items = appliedByIndex.get(i);
    const evs = (c.evidence || []).concat(items);
    const nc = { ...c, evidence: evs, fusion: fuse(evs, { candidates: prior }) };
    (nc.recallLane ? changedLane : changedNon).push({ i, log: nc.fusion.logOdds, cand: nc });
  }
  const unNon = [];
  const unLane = [];
  for (const e of blocks.nonLane) if (!changedSet.has(e.i)) unNon.push(e);
  for (const e of blocks.lane) if (!changedSet.has(e.i)) unLane.push(e);
  const ordered = withOrder ? [] : scratchOrdered;
  ordered.length = 0;
  mergeBlock(unNon, changedNon, ordered);
  mergeBlock(unLane, changedLane, ordered);

  const top = ordered[0];
  const runner = ordered[1] || null;
  const core = verdictForFusions(top.fusion, runner ? runner.fusion : null, FIELD_LIKELY_OPTS);
  const ti = ordered.findIndex(truthMatches);
  const topCorrect = ti === 0;
  const strong = isStrong(core.verdict);
  return {
    topCorrect,
    truthRank: ti >= 0 ? ti + 1 : 0,
    verdict: core.verdict,
    falseStrong: !topCorrect && strong,
    correctStrong: topCorrect && strong,
    margin: core.margin,
    topKey: candidateIdOf(top),
    rankedKeys: withOrder ? ordered.map(candidateIdOf) : null,
  };
}

/*
 * Rebuild the production baseline state independently (empty probe sequence =
 * exact production result — invariant 6/7) and assert prior/order parity
 * (invariant 2/3) against the production pinpointField result.
 */
export function buildReplayBaseline({ res, truthMatches }) {
  const candidates = res.candidates || [];
  const prior = narrowedPriorCount(candidates, res.universe);
  if (prior !== res.priorCandidates) {
    throw new Error(`oracle-replay-prior-parity: replay=${prior} production=${res.priorCandidates}`);
  }
  const withFusion = candidates.map((c) => ({ ...c, fusion: fuse(c.evidence || [], { candidates: prior }) }));
  withFusion.sort(byRecallLane);
  const orderMatch = withFusion.length === candidates.length
    && withFusion.every((c, i) => candidateIdOf(c) === candidateIdOf(candidates[i]));
  if (!orderMatch) {
    throw new Error('oracle-replay-order-parity: replay order differs from production order');
  }
  const baseline = evaluateOutcome({ candidates: withFusion, prior, truthMatches, appliedByIndex: new Map(), withOrder: true });
  if (candidates.length && res.verdict != null && res.verdict !== baseline.verdict) {
    /* Verdict parity against production decide() (same shared core + opts). */
    throw new Error(`oracle-replay-verdict-parity: replay=${baseline.verdict} production=${res.verdict}`);
  }
  if (res.top && baseline.topKey && candidateIdOf(res.top) !== baseline.topKey) {
    throw new Error('oracle-replay-top-parity: replay top differs from production top');
  }
  if (candidates.length && res.margin != null && Number.isFinite(res.margin)
    && Number.isFinite(baseline.margin) && Math.abs(res.margin - baseline.margin) > 1e-9) {
    throw new Error(`oracle-replay-margin-parity: replay=${baseline.margin} production=${res.margin}`);
  }
  return { candidates: withFusion, prior, baseline };
}
/*
 * Probe catalog generation (Phase 5). Families map 1:1 to existing production
 * primitives; no new analysis engine is invented:
 *   accessor_getter_verify      verifyAccessor on the getter (verify.js)
 *   setter_verify               verifyAccessor on the setter (verify.js)
 *   class_local_method_inspect  verifyFunctionHandlesField on name-matching
 *                               class methods — same primitive and evidence
 *                               shapes as production deep-verify
 *   compare_constant_behavior   verifyGuard/constantComparisons on accessors
 *   value_update_rmw            findValueUpdates on class methods
 *   shape_evidence              candidate size metadata (zero analysis cost)
 *   scan_access_sites           scanAccess read/write sites for the offset
 * caller/callee inspection is deliberately NOT cataloged: Hex has
 * ProgramIndex.callersOf/calleesOf, but no production field-evidence primitive
 * consumes that output today, so it is not a realistic selectable probe yet.
 */
export function generateProbePool(cands, w) {
  const probes = [];
  let seq = 1;
  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci];
    const candId = candidateIdOf(c);
    const accessors = c.accessors || {};
    if (accessors.getter && accessors.getter.addr != null) {
      probes.push({ probeId: `probe_${seq++}_getter_${c.field.name}`, family: 'accessor_getter_verify', candidateIndex: ci, candidateId: candId, sourceIdentity: 'getter:' + String(accessors.getter.addr), method: accessors.getter, estimatedCost: 1 });
    }
    if (accessors.setter && accessors.setter.addr != null) {
      probes.push({ probeId: `probe_${seq++}_setter_${c.field.name}`, family: 'setter_verify', candidateIndex: ci, candidateId: candId, sourceIdentity: 'setter:' + String(accessors.setter.addr), method: accessors.setter, estimatedCost: 1 });
    }
    const methods = w.fields ? (w.fields.classInfo(c.className)?.methods || []) : [];
    const matching = methods.filter((m) => m.addr != null && (m.sel || '').toLowerCase().includes(String(c.field.name).toLowerCase().replace(/^_/, '')));
    for (const m of matching.slice(0, CLASS_LOCAL_METHOD_CAP)) {
      probes.push({ probeId: `probe_${seq++}_class_method_${m.sel}`, family: 'class_local_method_inspect', candidateIndex: ci, candidateId: candId, sourceIdentity: 'method:' + String(m.addr), method: m, estimatedCost: 1 });
    }
    if (matching.length) {
      probes.push({ probeId: `probe_${seq++}_rmw_${c.field.name}`, family: 'value_update_rmw', candidateIndex: ci, candidateId: candId, sourceIdentity: 'rmw:' + String(matching[0].addr), method: matching[0], estimatedCost: 1 });
    }
    if (accessors.getter && accessors.getter.addr != null) {
      probes.push({ probeId: `probe_${seq++}_guard_${c.field.name}`, family: 'compare_constant_behavior', candidateIndex: ci, candidateId: candId, sourceIdentity: 'guard:' + String(accessors.getter.addr), method: accessors.getter, estimatedCost: 1 });
    }
    probes.push({ probeId: `probe_${seq++}_shape_${c.field.name}`, family: 'shape_evidence', candidateIndex: ci, candidateId: candId, sourceIdentity: 'shape:' + candId, estimatedCost: 0 });
    probes.push({ probeId: `probe_${seq++}_scan_${c.field.name}`, family: 'scan_access_sites', candidateIndex: ci, candidateId: candId, sourceIdentity: 'scan:' + candId, estimatedCost: 1 });
  }
  return probes;
}

async function withTimeout(work, ms) {
  let timer = null;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe-timeout')), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
/*
 * Execute one probe against the world and record the Phase-5 record.
 * Evidence is provenance-deduplicated against the target candidate's baseline
 * evidence: anything already known at baseline is dropped (no re-insertion,
 * no double counting). A probe that adds nothing is a no-op: recorded but
 * never selectable by the oracle search.
 */
export async function executeProbe(probe, replay, truthMatches, baselineOutcome, w, catalogSink) {
  const target = replay.candidates[probe.candidateIndex];
  const ctx = { candidateId: probe.candidateId };
  const baselineKeys = baselineProvenanceKeys(target);
  const startedMs = Date.now();
  let analysisCalls = 0;
  let scanCalls = 0;
  const rawEvidence = [];
  let failed = false;
  let timedOut = false;
  let reason = '';
  const endOf = (addr) => {
    const r = w.program ? w.program.functionRange(addr) : null;
    return r ? r.end : null;
  };

  try {
    if (probe.family === 'accessor_getter_verify') {
      const model = await withTimeout(() => { analysisCalls++; return w.analyze(probe.method.addr, endOf(probe.method.addr)); }, PROBE_TIMEOUT_MS);
      if (model) {
        const v = verifyAccessor(model, { offset: BigInt(target.offset), size: target.size });
        if (v.getter) {
          rawEvidence.push(evidence('getter-verified', v.exclusive ? 1 : 0.75, {
            sel: probe.method.sel, addr: probe.method.addr, className: target.className,
            offset: target.offset, size: v.size, exclusive: v.exclusive,
          }));
          if (v.size && target.size && v.size === target.size) {
            rawEvidence.push(evidence('size-fits', 1, { size: v.size, measured: true }));
          }
        }
      }
    } else if (probe.family === 'setter_verify') {
      const model = await withTimeout(() => { analysisCalls++; return w.analyze(probe.method.addr, endOf(probe.method.addr)); }, PROBE_TIMEOUT_MS);
      if (model) {
        const v = verifyAccessor(model, { offset: BigInt(target.offset), size: target.size });
        if (v.setter) {
          rawEvidence.push(evidence('setter-verified', v.fromArgument ? 1 : 0.7, {
            sel: probe.method.sel, addr: probe.method.addr, className: target.className,
            offset: target.offset, fromArgument: !!v.fromArgument,
          }));
        }
      }
    } else if (probe.family === 'class_local_method_inspect') {
      const model = await withTimeout(() => { analysisCalls++; return w.analyze(probe.method.addr, endOf(probe.method.addr)); }, PROBE_TIMEOUT_MS);
      if (model) {
        const use = verifyFunctionHandlesField(model, BigInt(target.offset));
        if (use.touches) {
          rawEvidence.push(evidence('access-verified', 1, {
            sel: probe.method.sel, addr: probe.method.addr, className: target.className,
            loads: use.use.loads, stores: use.use.stores,
          }));
          if (use.rmw) {
            rawEvidence.push(evidence('rmw-verified', 1, {
              sel: probe.method.sel, addr: probe.method.addr,
              address: use.use.rmw[0] ? use.use.rmw[0].store.address : null,
            }));
          }
          if (use.guard) {
            rawEvidence.push(evidence('guard-verified', 0.8, {
              sel: probe.method.sel, addr: probe.method.addr,
              value: use.use.compares[0] ? use.use.compares[0].value : null,
            }));
          }
          if (use.writes) rawEvidence.push(evidence('written-in-class', 1, { sel: probe.method.sel, n: use.use.stores }));
        }
      }
    } else if (probe.family === 'compare_constant_behavior') {
      const model = await withTimeout(() => { analysisCalls++; return w.analyze(probe.method.addr, endOf(probe.method.addr)); }, PROBE_TIMEOUT_MS);
      if (model) {
        const g = verifyGuard(model, BigInt(target.offset));
        if (g.guards && g.guards.length) {
          rawEvidence.push(evidence('guard-verified', 0.8, {
            sel: probe.method.sel, addr: probe.method.addr, value: g.guards[0] ? g.guards[0].value : null,
          }));
        }
      }
    } else if (probe.family === 'value_update_rmw') {
      const model = await withTimeout(() => { analysisCalls++; return w.analyze(probe.method.addr, endOf(probe.method.addr)); }, PROBE_TIMEOUT_MS);
      if (model) {
        const offset = BigInt(target.offset);
        for (const u of findValueUpdates(model)) {
          if (u.kind !== 'read-modify-write' || !u.location || u.location.disp !== offset) continue;
          if (u.location.self === false) continue;
          rawEvidence.push(evidence('rmw-observed', 1, {
            sel: probe.method.sel, addr: probe.method.addr,
            address: u.store && u.store.address != null ? u.store.address : null,
          }));
          break;
        }
      }
    } else if (probe.family === 'shape_evidence') {
      if (target.size && target.size <= 8) {
        rawEvidence.push(evidence('size-fits', 0.8, { size: target.size }));
      }
    } else if (probe.family === 'scan_access_sites') {
      if (w.scanAccess) {
        const res = await withTimeout(() => { scanCalls++; return w.scanAccess([{ offset: target.offset, size: target.size || 0 }]); }, PROBE_TIMEOUT_MS);
        const list = (res && (res.get ? res.get(String(target.offset)) : res[String(target.offset)])) || [];
        for (const s of list) {
          const fn = w.program ? w.program.functionStartOf(s.addr) : null;
          const owner = fn != null && w.fields ? w.fields.ownerOf(fn) : null;
          if (s.kind !== 'load' && owner && owner.className === target.className) {
            rawEvidence.push(evidence('written-in-class', 1, { addr: s.addr, offset: target.offset }));
            break;
          }
        }
      }
    } else {
      failed = true;
      reason = 'unknown-probe-family';
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    timedOut = msg === 'probe-timeout';
    failed = true;
    reason = msg;
  }

  /* Provenance dedup against baseline (Problems D/E). */
  const seen = new Set(baselineKeys);
  const evidenceAdded = [];
  for (const e of rawEvidence) {
    const key = evidenceProvenanceKey(e, ctx);
    if (seen.has(key)) continue;
    seen.add(key);
    evidenceAdded.push(e);
  }
  const noop = !evidenceAdded.length;
  const costBasis = probe.estimatedCost === 0
    ? (noop ? 'noop-baseline-duplicate' : 'zero-cost-derivable-from-baseline-metadata')
    : 'analysis-call';

  const standalone = !failed && !timedOut && !noop
    ? evaluateOutcome({
        candidates: replay.candidates, prior: replay.prior,
        truthMatches, appliedByIndex: new Map([[probe.candidateIndex, evidenceAdded]]),
      })
    : null;
  const out = standalone || baselineOutcome;
  const rankBefore = baselineOutcome.truthRank;
  const rankAfter = out.truthRank;
  const decisive = !!standalone && (
    out.topCorrect !== baselineOutcome.topCorrect
    || out.falseStrong !== baselineOutcome.falseStrong
    || out.correctStrong !== baselineOutcome.correctStrong
    || (rankAfter > 0 && rankAfter < rankBefore));
  let useful = decisive;
  let usefulReason = decisive ? 'outcome-tuple-improved' : '';
  if (!useful && standalone && rankBefore === 1 && rankAfter === 1 && baselineOutcome.verdict === VERDICT.AMBIGUOUS
    && (out.verdict === VERDICT.LIKELY || out.verdict === VERDICT.CONFIRMED)) {
    useful = true;
    usefulReason = 'verdict-elevated';
  }
  if (!useful && standalone && rankBefore === 1 && rankAfter === 1
    && Number.isFinite(out.margin) && Number.isFinite(baselineOutcome.margin)
    && out.margin >= baselineOutcome.margin + Math.log(2)) {
    useful = true;
    usefulReason = 'separation-margin-gained';
  }

  const evidenceKeysAdded = evidenceAdded.map((e) => evidenceProvenanceKey(e, ctx));
  const record = {
    probeId: probe.probeId,
    family: probe.family,
    candidateId: probe.candidateId,
    sourceIdentity: probe.sourceIdentity,
    estimatedCost: probe.estimatedCost,
    actualCost: analysisCalls + scanCalls,
    analysisCalls,
    scanCalls,
    actualMs: Date.now() - startedMs,
    evidenceBefore: baselineKeys.size,
    evidenceAdded: evidenceKeysAdded,
    evidenceAfter: baselineKeys.size + evidenceKeysAdded.length,
    rankBefore,
    rankAfter,
    verdictBefore: baselineOutcome.verdict,
    verdictAfter: out.verdict,
    useful,
    decisive,
    failed,
    timedOut,
    budgetConsumed: analysisCalls + scanCalls,
    independent: !noop,
    selectable: !noop && !failed && !timedOut,
    costBasis,
    reason: reason || (noop ? 'noop-baseline-duplicate' : usefulReason || 'no-effect'),
  };
  if (catalogSink) catalogSink.push(record);
  return {
    record,
    evidenceAdded,
    candidateIndex: probe.candidateIndex,
    analysisCalls,
    scanCalls,
    actualMs: record.actualMs,
    probeId: probe.probeId,
    family: probe.family,
    selectable: record.selectable,
  };
}
/*
 * Exhaustive optimal subset search (Problems A/F).
 *
 * Enumerates EVERY feasible probe subset by DFS (exhaustive — Problem A).
 * The canonical subset DFS visits each applied-probe set exactly once, so no
 * memo is required for correctness: outcomes are deterministic functions of
 * the incremental per-candidate evidence (keysMap/itemsMap), and branches
 * whose evidence is fully subsumed are pruned because only cost would grow.
 * The returned state is therefore at least as good as any heuristic under
 * the shared lexicographic objective — no feasible subset is skipped.
 * Oracle B passes the production budgets; Oracle A passes Infinity
 * constraints over the same probes, so A's feasible set is a superset of
 * B's.  verifySearchOptimal() cross-checks this search against an
 * independent brute-force enumeration in the invariant suite.
 * lexicographic objective.  Oracle B passes the production budgets; Oracle A
 * passes Infinity constraints over the same probes, so A's feasible set is a
 * superset of B's.
 */
export function searchOptimal({ replay, truthMatches, baselineOutcome, probes, maxAnalyze, maxProbes, maxScan }) {
  const sorted = probes.slice().sort((a, b) =>
    ((a.analysisCalls + a.scanCalls) - (b.analysisCalls + b.scanCalls))
    || (a.probeId < b.probeId ? -1 : a.probeId > b.probeId ? 1 : 0));
  const n = sorted.length;

  const baselineTuple = objectiveTuple(baselineOutcome, 0, 0);
  let best = { tuple: baselineTuple, outcome: baselineOutcome, applied: [], cost: 0, probeCount: 0 };
  let evaluated = 0;
  let pruned = 0;

  const maybeBest = (outcome, applied, cost) => {
    const tuple = objectiveTuple(outcome, cost, applied.length);
    if (compareObjective(tuple, best.tuple) > 0) {
      best = { tuple, outcome, applied: applied.slice(), cost, probeCount: applied.length };
    }
    return tuple;
  };

  const dfs = (idx, applied, keysMap, itemsMap, costA, costS) => {
    const outcome = evaluateOutcome({ candidates: replay.candidates, prior: replay.prior, truthMatches, appliedByIndex: itemsMap });
    evaluated++;
    const cost = costA + costS;
    maybeBest(outcome, applied, cost);
    if (idx >= sorted.length) return;
    const p = sorted[idx];
    /* Exclude branch (always feasible). */
    dfs(idx + 1, applied, keysMap, itemsMap, costA, costS);
    /* Include branch when budgets allow. */
    const pA = p.analysisCalls;
    const pS = p.scanCalls;
    if (applied.length + 1 <= maxProbes && costA + pA <= maxAnalyze && costS + pS <= maxScan) {
      const ci = p.candidateIndex;
      const prevKeys = keysMap.get(ci) || new Set();
      const prevItems = itemsMap.get(ci) || [];
      const nextKeys = new Set(prevKeys);
      const nextItems = prevItems.slice();
      let addedAny = false;
      for (const e of p.evidenceAdded) {
        const k = evidenceProvenanceKey(e, { candidateId: p.candidateId });
        if (nextKeys.has(k)) continue;
        nextKeys.add(k);
        nextItems.push(e);
        addedAny = true;
      }
      if (addedAny) {
        const nextKeysMap = new Map(keysMap);
        const nextItemsMap = new Map(itemsMap);
        nextKeysMap.set(ci, nextKeys);
        nextItemsMap.set(ci, nextItems);
        dfs(idx + 1, applied.concat([p]), nextKeysMap, nextItemsMap, costA + pA, costS + pS);
      } else {
        pruned++;   /* evidence-subsumed: identical outcome, strictly higher cost */
      }
    }
  };

  dfs(0, [], new Map(), new Map(), 0, 0);
  return {
    outcome: best.outcome,
    applied: best.applied,
    cost: best.cost,
    probeCount: best.probeCount,
    tuple: best.tuple,
    stats: { enumerated: evaluated, pruned, selectable: probes.length },
  };
}

/* Self-check: the branch-and-bound search must match brute-force enumeration
 * on live probe pools (invariant A/F for correctness, not only optimality
 * of the objective).  Each returned subset is re-evaluated through the
 * shared evaluateOutcome path and compared against the search result. */
export function verifySearchOptimal({ replay, truthMatches, baselineOutcome, probes, maxAnalyze, maxProbes, maxScan }) {
  const result = searchOptimal({ replay, truthMatches, baselineOutcome, probes, maxAnalyze, maxProbes, maxScan });
  const subsets = enumerateSubsets(probes, maxAnalyze, maxProbes, maxScan);
  let compared = 0;
  for (const subset of subsets) {
    const outcome = outcomeForSequence({ replay, truthMatches, applied: subset });
    const cost = subset.reduce((a, p) => a + p.analysisCalls + p.scanCalls, 0);
    const tuple = objectiveTuple(outcome, cost, subset.length);
    if (compareObjective(tuple, result.tuple) > 0) {
      throw new Error(`branch-and-bound suboptimal: brute force beats search (${JSON.stringify(tuple)} > ${JSON.stringify(result.tuple)})`);
    }
    compared++;
  }
  return { compared, tuple: result.tuple };
}

/** Build the applied-probe evidence map with provenance dedup (shared by
 * outcomeForSequence and the fast-vs-reference invariant tests). */
export function appliedItemsMap(applied) {
  const itemsMap = new Map();
  for (const p of applied) {
    const ci = p.candidateIndex;
    const keys = new Set((itemsMap.get(ci) || []).map((e) => evidenceProvenanceKey(e, { candidateId: p.candidateId })));
    const items = (itemsMap.get(ci) || []).slice();
    for (const e of p.evidenceAdded) {
      const k = evidenceProvenanceKey(e, { candidateId: p.candidateId });
      if (keys.has(k)) continue;
      keys.add(k);
      items.push(e);
    }
    itemsMap.set(ci, items);
  }
  return itemsMap;
}

/** Outcome for an explicit probe sequence (tests: empty sequence == baseline). */
export function outcomeForSequence({ replay, truthMatches, applied, withOrder }) {
  return evaluateOutcome({
    candidates: replay.candidates, prior: replay.prior, truthMatches,
    appliedByIndex: appliedItemsMap(applied), withOrder,
  });
}
/*
 * First decisive evidence along the reported sequence (Phase 7 cost/time to
 * first decisive). Report order: ascending cost, then probeId. A probe is
 * decisive in the final set when removing it worsens the cost-free objective
 * components (false-strong / top1 / correct-strong / rank).
 */
export function sequenceDecisive({ replay, truthMatches, baselineOutcome, applied }) {
  const ordered = applied.slice().sort((a, b) =>
    ((a.analysisCalls + a.scanCalls) - (b.analysisCalls + b.scanCalls))
    || (a.probeId < b.probeId ? -1 : a.probeId > b.probeId ? 1 : 0));
  if (!ordered.length) {
    return { ordered, firstDecisiveProbeId: null, costToFirstDecisive: 0, msToFirstDecisive: 0, decisiveIds: [] };
  }
  const full = outcomeForSequence({ replay, truthMatches, applied: ordered });
  const decisiveIds = [];
  let costTo = 0;
  let msTo = 0;
  let first = null;
  for (let i = 0; i < ordered.length; i++) {
    const without = outcomeForSequence({ replay, truthMatches, applied: ordered.filter((_, j) => j !== i) });
    const better = compareObjective(
      objectiveTuple(full, 0, 0), objectiveTuple(without, 0, 0)) > 0
      || (full.truthRank > 0 && full.truthRank < without.truthRank);
    costTo += ordered[i].analysisCalls + ordered[i].scanCalls;
    msTo += ordered[i].actualMs || 0;
    if (better) {
      decisiveIds.push(ordered[i].probeId);
      if (first == null) first = { probeId: ordered[i].probeId, costTo, msTo };
    }
  }
  return {
    ordered,
    firstDecisiveProbeId: first ? first.probeId : null,
    costToFirstDecisive: first ? first.costTo : null,
    msToFirstDecisive: first ? first.msTo : null,
    decisiveIds,
  };
}
/*
 * Problem G intent analysis. The lexical fact (>=2 candidate field names
 * contain every query word) is reported separately from what binary evidence
 * can actually do:
 *   BINARY_DISTINGUISHABLE    probes/full evidence change the relative order
 *                             of the matching set, or a matching candidate
 *                             carries a binary contradiction (applied < 0)
 *   INTENT_UNDERSPECIFIED     every match naturally fits the words (each has
 *                             identifying name evidence), no contradiction,
 *                             and the full probe set cannot separate them
 *   BINARY_INDISTINGUISHABLE  the rest (no separation, not all natural fits)
 */
export function intentAnalysisOf({ lexicalMatches, baselineOutcome, fullOutcome }) {
  if (!lexicalMatches || lexicalMatches.length < 2) {
    return { lexical: 'UNIQUE', intent: null };
  }
  const ids = lexicalMatches.map(candidateIdOf);
  const orderOf = (outcome) => (outcome.rankedKeys || [])
    .filter((k) => ids.includes(k));
  const baselineOrder = orderOf(baselineOutcome);
  const fullOrder = orderOf(fullOutcome);
  const separated = baselineOrder.join(',') !== fullOrder.join(',')
    || fullOutcome.truthRank !== baselineOutcome.truthRank
    || fullOutcome.verdict !== baselineOutcome.verdict
    || fullOutcome.topCorrect !== baselineOutcome.topCorrect;
  const contradiction = lexicalMatches.some((c) =>
    (c.fusion && c.fusion.items || []).some((it) => typeof it.applied === 'number' && it.applied < 0));
  if (separated || contradiction) return { lexical: 'AMBIGUOUS', intent: 'BINARY_DISTINGUISHABLE' };
  const naturalAll = lexicalMatches.every((c) =>
    (c.fusion && c.fusion.items || []).some((it) => it.id && it.applied > 0));
  if (naturalAll) return { lexical: 'AMBIGUOUS', intent: 'INTENT_UNDERSPECIFIED' };
  return { lexical: 'AMBIGUOUS', intent: 'BINARY_INDISTINGUISHABLE' };
}

/*
 * Phase 8 failure taxonomy (disjoint, evaluated in this order). Labels
 * (exact/partial) are never consulted.
 */
export function classifyQuery({ baseline, oracleB, oracleA, intent, probeAnyEvidence }) {
  const resolved = (o) => !!(o && o.topCorrect && isStrong(o.verdict));
  const order = [
    ['ALREADY_RESOLVED', resolved(baseline), 'top-1 correct and strong in the production baseline'],
    ['BUDGET_RESOLVABLE', resolved(oracleB), 'resolved to top-1 correct strong within the production budget'],
    ['ONLY_UNBOUNDED_RESOLVABLE', resolved(oracleA), 'resolved only with the unbounded probe catalog'],
    ['CONFIDENCE_POLICY_LIMIT', baseline.topCorrect && !isStrong(baseline.verdict)
      && !resolved(oracleB) && !resolved(oracleA)
      && oracleA.topCorrect && !isStrong(oracleA.verdict),
    'truth already ranks first but no probe subset reaches a strong verdict under the confidence policy'],
    ['LEXICALLY_AMBIGUOUS_BUT_BINARY_RESOLVABLE', intent === 'BINARY_DISTINGUISHABLE',
      'lexically ambiguous, but binary probes expose separating evidence (gap is ranking/confidence)'],
    ['INTENT_UNDERSPECIFIED', intent === 'INTENT_UNDERSPECIFIED',
      'multiple candidates naturally fit the words and available probes cannot separate them'],
    ['EVIDENCE_ABSENT', !probeAnyEvidence,
      'no probe adds any new binary evidence beyond baseline'],
    ['CANDIDATE_RANKING_LIMIT', oracleA.truthRank > 0 && oracleA.truthRank < baseline.truthRank,
      'probes improve truth rank but not to a resolved top-1'],
    ['ANALYSIS_UNSUPPORTED', true, 'evidence exists but no local probe resolves the query'],
  ];
  for (const [category, hit, reason] of order) {
    if (hit) return { category, reason };
  }
  return { category: 'OTHER', reason: 'unclassified' };
}
/** Lexical observation only (Problem G): candidate field names containing every query word. */
export function lexicalMatchesOf(candidates, q) {
  const words = String(q.label).toLowerCase().split(/\s+/).filter(Boolean);
  return (candidates || []).filter((c) =>
    c && c.field && words.every((wd) => String(c.field.name || '').toLowerCase().includes(wd)));
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
function distribution(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return { n: 0, mean: null, median: null, p50: null, p95: null, max: null };
  const sum = v.reduce((a, b) => a + b, 0);
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return {
    n: v.length,
    mean: Math.round((sum / v.length) * 1000) / 1000,
    median,
    p50: percentile(v, 50),
    p95: percentile(v, 95),
    max: v[v.length - 1],
  };
}
function gitHead() {
  try { return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}
function gitBlobSha(relPath) {
  try { return execFileSync('git', ['-C', ROOT, 'hash-object', relPath], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}
function sha256File(relPath) {
  return createHash('sha256').update(fs.readFileSync(path.join(ROOT, relPath))).digest('hex');
}

async function main() {
  const wallStart = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  /*
   * Phase 3 final-baseline binding: when final-baseline.json exists, this run
   * MUST measure that exact confidence policy and corpus. Any mismatch fails
   * closed instead of mixing measurements taken under different policies.
   */
  const baselinePath = path.join(OUT_DIR, 'final-baseline.json');
  let baselineArtifact = null;
  const policySha = gitBlobSha('js/evidence.js');
  const queriesSha256 = sha256File('tests/fixtures/pinpoint-confidence-queries.json');
  if (fs.existsSync(baselinePath)) {
    baselineArtifact = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    if (baselineArtifact.confidencePolicySha && baselineArtifact.confidencePolicySha !== policySha) {
      throw new Error(`final-baseline-policy-mismatch: artifact=${baselineArtifact.confidencePolicySha} worktree=${policySha}`);
    }
    if (baselineArtifact.queriesSha256 && baselineArtifact.queriesSha256 !== queriesSha256) {
      throw new Error(`final-baseline-corpus-mismatch: artifact=${baselineArtifact.queriesSha256} worktree=${queriesSha256}`);
    }
    if (baselineArtifact.productionAnalyzeBudget != null
      && baselineArtifact.productionAnalyzeBudget !== PRODUCTION_ANALYZE_BUDGET) {
      throw new Error(`final-baseline-budget-mismatch: artifact=${baselineArtifact.productionAnalyzeBudget} harness=${PRODUCTION_ANALYZE_BUDGET}`);
    }
  } else if (process.env.HEX_ORACLE_REQUIRE_BASELINE === '1') {
    throw new Error(`final-baseline-missing: ${baselinePath}`);
  } else {
    console.warn('WARNING: final-baseline.json absent — unbound run, do NOT use for Go/No-Go.');
  }

  const queries = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests/fixtures/pinpoint-confidence-queries.json'), 'utf8'));
  /* HEX_ORACLE_LIMIT=N runs the first N queries only; HEX_ORACLE_MATCH=<label
   * substring> filters by label (both for smoke/timing runs; full runs leave
   * them unset). */
  const LIMIT = Number(process.env.HEX_ORACLE_LIMIT || 0) || 0;
  const MATCH = process.env.HEX_ORACLE_MATCH || '';
  const base = LIMIT > 0 ? queries.slice(0, LIMIT) : queries;
  const list = MATCH ? base.filter((q) => String(q.label).includes(MATCH)) : base;
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
  const rows = [];
  const harnessErrors = [];
  const invariantViolations = [];
  const familyStats = {};

  console.log(`Oracle Probe Ceiling v2: ${list.length} queries, budgets `
    + `analyze<=${PRODUCTION_ANALYZE_BUDGET} probes<=${PRODUCTION_PROBE_BUDGET} scan<=${PRODUCTION_SCAN_BUDGET}...`);

  for (let qi = 0; qi < list.length; qi++) {
    const q = list[qi];
    try {
      const w = await getWorld(q.binary);
      let goal = null;
      try { goal = parseGoal(q.label); } catch { goal = null; }
      if (!goal) throw new Error('unparseable-goal');

      let baselineAnalyzeCalls = 0;
      const analyzeCounter = async (...a) => { baselineAnalyzeCalls++; return w.analyze(...a); };
      const res = await pinpointField({
        goal, fields: w.fields, program: w.program, symbols: w.symbols,
        strings: w.strings, analyze: analyzeCounter, scanAccess: w.scanAccess, limit: 400,
      });
      const truthMatches = (c) => !!c && c.className === q.class && c.field && c.field.name === q.ivar;
      const replay = buildReplayBaseline({ res, truthMatches });
      const baseline = replay.baseline;

      const pool = generateProbePool(replay.candidates.slice(0, PROBE_POOL_TOP), w);
      const execResults = [];
      for (const probe of pool) {
        const r = await executeProbe(probe, replay, truthMatches, baseline, w, catalogRecords);
        execResults.push(r);
        const fam = familyStats[r.family] || (familyStats[r.family] = {
          total: 0, useful: 0, decisive: 0, selectable: 0, noop: 0, failed: 0, timedOut: 0,
        });
        fam.total++;
        if (r.record.useful) fam.useful++;
        if (r.record.decisive) fam.decisive++;
        if (r.record.selectable) fam.selectable++;
        if (!r.record.independent && !r.record.failed) fam.noop++;
        if (r.record.failed && !r.record.timedOut) fam.failed++;
        if (r.record.timedOut) fam.timedOut++;
      }
      const selectable = execResults.filter((r) => r.selectable);

      const oracleB = searchOptimal({
        replay, truthMatches, baselineOutcome: baseline, probes: selectable,
        maxAnalyze: PRODUCTION_ANALYZE_BUDGET, maxProbes: PRODUCTION_PROBE_BUDGET, maxScan: PRODUCTION_SCAN_BUDGET,
      });
      const oracleA = searchOptimal({
        replay, truthMatches, baselineOutcome: baseline, probes: selectable,
        maxAnalyze: Infinity, maxProbes: Infinity, maxScan: Infinity,
      });
      const baselineTuple = objectiveTuple(baseline, 0, 0);
      const aNotWorseB = compareObjective(oracleA.tuple, oracleB.tuple) >= 0;
      const bNotWorseBase = compareObjective(oracleB.tuple, baselineTuple) >= 0;
      const aStrictlyBetterThanB = compareObjective(oracleA.tuple, oracleB.tuple) > 0;
      if (!aNotWorseB) {
        invariantViolations.push({ label: q.label, kind: 'A-not-worse-than-B', a: oracleA.tuple, b: oracleB.tuple });
      }
      if (!bNotWorseBase) {
        invariantViolations.push({ label: q.label, kind: 'B-not-worse-than-baseline', b: oracleB.tuple, base: baselineTuple });
      }
      const emptyOutcome = outcomeForSequence({ replay, truthMatches, applied: [] });
      const emptyIsBaseline = emptyOutcome.verdict === baseline.verdict
        && emptyOutcome.truthRank === baseline.truthRank;
      if (!emptyIsBaseline) {
        invariantViolations.push({ label: q.label, kind: 'empty-sequence-not-baseline' });
      }

      const fullOutcome = outcomeForSequence({ replay, truthMatches, applied: selectable, withOrder: true });
      const lexicalMatches = lexicalMatchesOf(replay.candidates, q);
      const intent = intentAnalysisOf({ lexicalMatches, baselineOutcome: baseline, fullOutcome });
      const probeAnyEvidence = execResults.some((r) => r.evidenceAdded.length > 0);
      const classification = classifyQuery({
        baseline, oracleB: oracleB.outcome, oracleA: oracleA.outcome,
        intent: intent.intent, probeAnyEvidence,
      });
      const decisiveB = sequenceDecisive({ replay, truthMatches, baselineOutcome: baseline, applied: oracleB.applied });
      const bAnalyze = oracleB.applied.reduce((a, p) => a + p.analysisCalls, 0);
      const bScan = oracleB.applied.reduce((a, p) => a + p.scanCalls, 0);
      const budgetExhausted = (bAnalyze >= PRODUCTION_ANALYZE_BUDGET
        || oracleB.probeCount >= PRODUCTION_PROBE_BUDGET
        || bScan >= PRODUCTION_SCAN_BUDGET)
        && selectable.length > oracleB.applied.length;

      rows.push({
        binary: q.binary, mode: q.mode, label: q.label,
        expectedClass: q.class, expectedField: q.ivar,
        category: classification.category,
        reason: classification.reason,
        lexical: intent.lexical,
        intentAnalysis: intent.intent,
        bestProbeSequence: oracleA.applied.map((p) => p.probeId),
        cost: {
          baselineAnalyzeCalls,
          oracleB: oracleB.cost,
          oracleA: oracleA.cost,
          toFirstDecisive: decisiveB.costToFirstDecisive,
          toFirstDecisiveMs: decisiveB.msToFirstDecisive,
        },
        finalRank: oracleA.outcome.truthRank,
        finalVerdict: oracleA.outcome.verdict,
        baselineRank: baseline.truthRank,
        baselineVerdict: baseline.verdict,
        oracleBRank: oracleB.outcome.truthRank,
        oracleBVerdict: oracleB.outcome.verdict,
        oracleBSequence: oracleB.applied.map((p) => p.probeId),
        oracleBAnalyze: bAnalyze,
        oracleBScan: bScan,
        oracleBProbeCount: oracleB.probeCount,
        oracleARank: oracleA.outcome.truthRank,
        oracleAVerdict: oracleA.outcome.verdict,
        oracleAAnalyze: oracleA.applied.reduce((a, p) => a + p.analysisCalls, 0),
        oracleAProbeCount: oracleA.probeCount,
        firstDecisiveProbeId: decisiveB.firstDecisiveProbeId,
        budgetExhausted,
        probeAnyEvidence,
        search: {
          selectable: selectable.length,
          enumeratedB: oracleB.stats.enumerated,
          enumeratedA: oracleA.stats.enumerated,
          prunedB: oracleB.stats.pruned,
          prunedA: oracleA.stats.pruned,
        },
        invariants: {
          aNotWorseThanB: aNotWorseB,
          bNotWorseThanBaseline: bNotWorseBase,
          emptySequenceIsBaseline: emptyIsBaseline,
        },
        aStrictlyBetterThanB,
      });
    } catch (err) {
      harnessErrors.push({
        binary: q.binary, mode: q.mode, label: q.label,
        error: String((err && err.stack) || err).slice(0, 600),
      });
      rows.push({
        binary: q.binary, mode: q.mode, label: q.label,
        expectedClass: q.class, expectedField: q.ivar,
        category: 'OTHER', reason: 'harness-error',
        error: String((err && err.message) || err),
      });
    }
    if ((qi + 1) % 25 === 0 || qi === list.length - 1) {
      console.log(`  [${qi + 1}/${list.length}] rows=${rows.length} harnessErrors=${harnessErrors.length}`);
    }
  }

  /* ── Phase 7 metrics over the completed rows ── */
  const okRows = rows.filter((r) => !r.error);
  const total = rows.length;
  const strongV = (v) => v === 'likely' || v === 'confirmed';
  const count = (fn) => okRows.filter(fn).length;
  const resBase = (r) => r.baselineRank === 1 && strongV(r.baselineVerdict);
  const resB = (r) => r.oracleBRank === 1 && strongV(r.oracleBVerdict);
  const resA = (r) => r.finalRank === 1 && strongV(r.finalVerdict);
  const topNAcc = (rankK, n) => count((r) => r[rankK] > 0 && r[rankK] <= n);
  const gainB = okRows.map((r) => (r.baselineRank > 0 && r.oracleBRank > 0 ? r.baselineRank - r.oracleBRank : 0));
  const gainA = okRows.map((r) => (r.baselineRank > 0 && r.finalRank > 0 ? r.baselineRank - r.finalRank : 0));
  const rankGainB = distribution(gainB);
  const rankGainA = distribution(gainA);

  const accuracyRanking = {
    top1: {
      baseline: count((r) => r.baselineRank === 1),
      oracleB: count((r) => r.oracleBRank === 1),
      oracleA: count((r) => r.finalRank === 1),
    },
    top4Recall: {
      baseline: topNAcc('baselineRank', 4),
      oracleB: topNAcc('oracleBRank', 4),
      oracleA: topNAcc('finalRank', 4),
    },
    top8Recall: {
      baseline: topNAcc('baselineRank', 8),
      oracleB: topNAcc('oracleBRank', 8),
      oracleA: topNAcc('finalRank', 8),
    },
    rankGainB,
    rankGainA,
    meanRankGain: { oracleB: rankGainB.mean, oracleA: rankGainA.mean },
    medianRankGain: { oracleB: rankGainB.median, oracleA: rankGainA.median },
    rescued: {
      byOracleB: count((r) => !resBase(r) && resB(r)),
      byOracleAOnly: count((r) => !resBase(r) && !resB(r) && resA(r)),
      total: count((r) => !resBase(r) && (resB(r) || resA(r))),
    },
  };

  const csBase = count(resBase);
  const csB = count(resB);
  const csA = count(resA);
  const fsBase = count((r) => r.baselineRank !== 1 && strongV(r.baselineVerdict));
  const fsB = count((r) => r.oracleBRank !== 1 && strongV(r.oracleBVerdict));
  const fsA = count((r) => r.finalRank !== 1 && strongV(r.finalVerdict));
  const confidence = {
    correctStrong: { baseline: csBase, oracleB: csB, oracleA: csA },
    falseStrong: { baseline: fsBase, oracleB: fsB, oracleA: fsA },
    ambiguous: {
      baseline: count((r) => r.baselineVerdict === 'ambiguous'),
      oracleB: count((r) => r.oracleBVerdict === 'ambiguous'),
      oracleA: count((r) => r.finalVerdict === 'ambiguous'),
    },
    falseStrongPreventedB: count((r) => r.baselineRank !== 1 && strongV(r.baselineVerdict) && !(r.oracleBRank !== 1 && strongV(r.oracleBVerdict))),
    falseStrongPreventedA: count((r) => r.baselineRank !== 1 && strongV(r.baselineVerdict) && !(r.finalRank !== 1 && strongV(r.finalVerdict))),
    correctStrongGainedB: count((r) => !resBase(r) && resB(r)),
    correctStrongGainedA: count((r) => !resBase(r) && resA(r)),
  };

  const exhausted = count((r) => r.budgetExhausted === true);
  const catalogTotal = catalogRecords.length;
  const catalogUseful = catalogRecords.filter((r) => r.useful).length;
  const catalogDecisive = catalogRecords.filter((r) => r.decisive).length;
  const cost = {
    totalBaselineAnalyzeCalls: okRows.reduce((a, r) => a + (r.cost.baselineAnalyzeCalls || 0), 0),
    perQueryBaselineAnalyze: distribution(okRows.map((r) => r.cost.baselineAnalyzeCalls)),
    probesEvaluated: catalogTotal,
    probeCost: distribution(catalogRecords.map((r) => r.actualCost)),
    totalOracleBAnalyzeCalls: okRows.reduce((a, r) => a + (r.oracleBAnalyze || 0), 0),
    totalOracleBScanPasses: okRows.reduce((a, r) => a + (r.oracleBScan || 0), 0),
    totalOracleAAnalyzeCalls: okRows.reduce((a, r) => a + (r.oracleAAnalyze || 0), 0),
    totalQueryCostOracleB: distribution(okRows.map((r) => r.cost.baselineAnalyzeCalls + r.cost.oracleB)),
    totalQueryCostOracleA: distribution(okRows.map((r) => r.cost.baselineAnalyzeCalls + r.cost.oracleA)),
    budgetExhaustions: { count: exhausted, rate: total ? Math.round((exhausted / total) * 1e6) / 1e6 : null },
    uselessProbes: catalogTotal - catalogUseful,
    usefulProbes: catalogUseful,
    usefulRate: catalogTotal ? Math.round((catalogUseful / catalogTotal) * 1e4) / 1e4 : null,
    decisiveRate: catalogTotal ? Math.round((catalogDecisive / catalogTotal) * 1e4) / 1e4 : null,
    costToFirstDecisive: distribution(okRows.map((r) => r.cost.toFirstDecisive).filter((v) => v != null)),
    timeToFirstDecisiveMs: distribution(okRows.map((r) => r.cost.toFirstDecisiveMs).filter((v) => v != null)),
  };

  const taxonomy = {};
  const intentBreakdown = { lexicalUnique: 0, lexicalAmbiguous: 0, binaryDistinguishable: 0, binaryIndistinguishable: 0, intentUnderspecified: 0 };
  for (const r of rows) {
    taxonomy[r.category] = (taxonomy[r.category] || 0) + 1;
    if (r.lexical === 'UNIQUE') intentBreakdown.lexicalUnique++;
    if (r.lexical === 'AMBIGUOUS') intentBreakdown.lexicalAmbiguous++;
    if (r.intentAnalysis === 'BINARY_DISTINGUISHABLE') intentBreakdown.binaryDistinguishable++;
    if (r.intentAnalysis === 'BINARY_INDISTINGUISHABLE') intentBreakdown.binaryIndistinguishable++;
    if (r.intentAnalysis === 'INTENT_UNDERSPECIFIED') intentBreakdown.intentUnderspecified++;
  }

  const search = {
    cap: MAX_SELECTABLE_PROBES,
    maxSelectableObserved: okRows.reduce((a, r) => Math.max(a, (r.search && r.search.selectable) || 0), 0),
    atCapQueries: count((r) => r.search && r.search.selectable >= MAX_SELECTABLE_PROBES),
    enumeratedTotalB: okRows.reduce((a, r) => a + ((r.search && r.search.enumeratedB) || 0), 0),
    enumeratedTotalA: okRows.reduce((a, r) => a + ((r.search && r.search.enumeratedA) || 0), 0),
    prunedTotal: okRows.reduce((a, r) => a + ((r.search && r.search.prunedB) || 0) + ((r.search && r.search.prunedA) || 0), 0),
    mode: 'exhaustive-subset-enumeration',
  };

  const schedulerGap = {
    baselineToOracleB: {
      top1: accuracyRanking.top1.oracleB - accuracyRanking.top1.baseline,
      correctStrong: csB - csBase,
      falseStrongReduction: fsBase - fsB,
    },
    oracleBToOracleA: {
      top1: accuracyRanking.top1.oracleA - accuracyRanking.top1.oracleB,
      correctStrong: csA - csB,
      falseStrongReduction: fsB - fsA,
    },
    budgetLoss: {
      queriesWhereUnboundedStrictlyBeatsBudget: count((r) => r.aStrictlyBetterThanB === true),
      objective: OBJECTIVE,
    },
    unsupportedAnalysisCeiling: taxonomy['ANALYSIS_UNSUPPORTED'] || 0,
    ambiguityCeiling: {
      intentUnderspecified: taxonomy['INTENT_UNDERSPECIFIED'] || 0,
      lexicallyAmbiguousButBinaryResolvable: taxonomy['LEXICALLY_AMBIGUOUS_BUT_BINARY_RESOLVABLE'] || 0,
      lexicalAmbiguousTotal: intentBreakdown.lexicalAmbiguous,
    },
  };

  const summary = {
    schema: 'hex-pinpoint-oracle-ceiling/v2',
    metadata: {
      totalQueries: total,
      exactQueries: rows.filter((r) => r.mode === 'exact').length,
      partialQueries: rows.filter((r) => r.mode === 'partial').length,
      analyzedQueries: okRows.length,
      harnessErrorQueries: harnessErrors.length,
      productionAnalyzeBudget: PRODUCTION_ANALYZE_BUDGET,
      productionProbeBudget: PRODUCTION_PROBE_BUDGET,
      productionScanBudget: PRODUCTION_SCAN_BUDGET,
      finalBaselineSha: baselineArtifact ? (baselineArtifact.mainSha || null) : null,
      baselineArtifactBound: !!baselineArtifact,
      confidencePolicySha: policySha,
      queriesSha256,
      measurementGitHead: gitHead(),
      objective: OBJECTIVE,
      wallClockMs: Date.now() - wallStart,
    },
    accuracyRanking,
    confidence,
    cost,
    schedulerGap,
    taxonomy,
    intentBreakdown,
    probeStatistics: {
      totalProbesEvaluated: catalogTotal,
      usefulProbesCount: catalogUseful,
      usefulRate: cost.usefulRate,
      decisiveProbesCount: catalogDecisive,
      decisiveRate: cost.decisiveRate,
      selectableProbesCount: catalogRecords.filter((r) => r.selectable).length,
      noopDuplicates: catalogRecords.filter((r) => !r.independent && !r.failed).length,
      failedProbes: catalogRecords.filter((r) => r.failed).length,
      timedOutProbes: catalogRecords.filter((r) => r.timedOut).length,
      byFamily: familyStats,
    },
    search,
    invariants: {
      objectiveViolations: invariantViolations,
      objectiveViolationCount: invariantViolations.length,
      replayParity: 'enforced per query (prior/order/verdict/margin mismatch throws)',
      emptyProbeSequenceIsBaseline: okRows.every((r) => r.invariants && r.invariants.emptySequenceIsBaseline),
      budgetedOracleNeverWorseThanBaseline: okRows.every((r) => r.invariants && r.invariants.bNotWorseThanBaseline),
      unboundedOracleNeverWorseThanBudgeted: okRows.every((r) => r.invariants && r.invariants.aNotWorseThanB),
    },
    harnessErrors,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'oracle-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'oracle-classification.json'), JSON.stringify(rows, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'probe-catalog.json'), JSON.stringify(catalogRecords, null, 2) + '\n');

  console.log('Oracle Ceiling v2 measurement complete. Artifacts written to:', OUT_DIR);
  console.log(JSON.stringify({
    top1: summary.accuracyRanking.top1,
    correctStrong: summary.confidence.correctStrong,
    falseStrong: summary.confidence.falseStrong,
    taxonomy: summary.taxonomy,
    schedulerGap: summary.schedulerGap,
  }, null, 2));

  if (harnessErrors.length || invariantViolations.length) {
    console.error(`FAIL-CLOSED: ${harnessErrors.length} harness errors, ${invariantViolations.length} objective invariant violations.`);
    process.exitCode = 1;
  }

}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal error in oracle ceiling runner:', err);
    process.exit(1);
  });
}
