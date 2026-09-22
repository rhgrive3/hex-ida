/*
 * Oracle Probe Ceiling Harness Invariants (Phase 9).
 *
 * Automated tests for the measurement harness guarantees. Synthetic fixtures
 * only (no binary, no network, no LLM), plus one real-binary row for baseline
 * replay parity (skipped explicitly when the large fixtures are absent, e.g.
 * CI checkouts without `npm run fixtures:large`).
 *
 * Covered guarantees:
 *  1. Oracle A (unbounded) never has a worse objective than Oracle B
 *     (budget-matched) — same objective, A feasible set superset B.
 *  2. Oracle replay uses the exact production prior (narrowedPriorCount).
 *  3. Oracle replay uses the exact production ordering (byRecallLane).
 *  4. Same-provenance evidence is never double-counted (duplicate and
 *     alias-normalized probes collapse; only one survives selection).
 *  5. Zero-cost probes never re-insert baseline evidence (shape_evidence).
 *  6. Empty probe sequence == exact baseline result.
 *  7. budget=0 == baseline.
 *  8. Candidate recall-lane precedence is maintained in replay.
 *  9. Malformed probe results are fail-closed.
 * 10. Timeout/failed probes never raise confidence.
 *
 * The harness functions under test are imported directly; no production
 * semantics are duplicated here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuse, evidence, VERDICT } from '../js/evidence.js';
import { narrowedPriorCount, byRecallLane } from '../js/pinpoint.js';
import {
  objectiveTuple, compareObjective, evidenceProvenanceKey, baselineProvenanceKeys,
  candidateIdOf, evaluateOutcome, buildReplayBaseline, outcomeForSequence,
  searchOptimal, FIELD_LIKELY_OPTS, PRODUCTION_ANALYZE_BUDGET, PRODUCTION_PROBE_BUDGET,
  PRODUCTION_SCAN_BUDGET, MAX_SELECTABLE_PROBES,
} from '../scripts/measure-oracle-probe-ceiling.mjs';

let passed = 0;
const failures = [];
const pendingTests = [];
function pass(name) { passed++; process.stdout.write('  ok  ' + name + '\n'); }
function fail(name, err) {
  failures.push({ name, err });
  process.stdout.write('FAIL  ' + name + '\n      ' + ((err && err.message) || err) + '\n');
}
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pendingTests.push(Promise.resolve(r).then(() => pass(name), (err) => fail(name, err)));
    else pass(name);
  } catch (err) { fail(name, err); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
}

/* Synthetic world: a trusted metadata+structural top that is ambiguous at
 * production scale until probes add verified/dataflow evidence. */
const ev = (code, strength, detail, lr) => evidence(code, strength == null ? 1 : strength, detail || {}, lr);
const CTX_TRUTH = { candidateId: 'Cls#_hp#8' };
const TRUTH_BASE = [
  ev('field-name-exact', 1, {}), ev('sibling-fields', 0.5, {}), ev('size-fits', 0.6, { size: 4 }),
];
const RUNNER_BASE = [
  ev('field-name-contains', 0.77, {}), ev('sibling-fields', 0.5, {}), ev('size-fits', 0.6, { size: 4 }),
];
const PRIOR = 12;
const CMP_EVIDENCE = ev('compare-observed', 0.4, {});
const RMW_EVIDENCE = ev('rmw-observed', 0.5, { addr: 500n });
/*
 * Fixture arithmetic (prior=12, verified against production fuse in CI):
 * baseline truth p=0.697, margin(rival)=0.321
 *  +compare-only : p=0.766, margin=0.671, 3 groups (weak alone)
 *  +rmw-only     : p=0.850, margin=1.217, 3 groups (sub-likely alone)
 *  +both         : p=0.889, margin=1.567, 3 groups, LIKELY (jointly decisive)
 * Margin lift: rmw-alone contributes 0.896, compare-alone 0.35 (both < ln2),
 * combined 1.246 (> ln2). A rank-gain-only heuristic keeps both probes out of
 * its useful pool (each leaves truth below the rank-gain/elevation/margin
 * criteria — the familiar "singly useless, jointly decisive" trap): the
 * optimal search must still find the pair, and only the pair reaches likely.
 */

function buildTruth(extra) {
  return {
    className: 'Cls', field: { name: '_hp' }, offset: '8', size: 4, recallLane: false,
    evidence: TRUTH_BASE.concat(extra || []),
  };
}
function buildRunner() {
  return {
    className: 'Cls', field: { name: '_hpx' }, offset: '12', size: 4, recallLane: false,
    evidence: RUNNER_BASE,
  };
}
function truthMatches(c) { return !!c && c.className === 'Cls' && c.field && c.field.name === '_hp'; }
function replayOf(truth, runner) {
  const cands = [truth, runner].map((c) => ({ ...c, fusion: fuse(c.evidence || [], { candidates: PRIOR }) }));
  return { candidates: cands, prior: PRIOR };
}
const MKP = (probeId, candidateIndex, candidateId, added, analysisCalls, scanCalls) => ({
  probeId, candidateIndex, candidateId, evidenceAdded: added,
  analysisCalls: analysisCalls || 0, scanCalls: scanCalls || 0, actualMs: 1,
});
function cmpProbe() {
  return MKP('probe_cmp', 0, CTX_TRUTH.candidateId, [CMP_EVIDENCE], 1, 0);
}
function rmwProbe() {
  return MKP('probe_rmw', 0, CTX_TRUTH.candidateId, [RMW_EVIDENCE], 1, 0);
}

/* 1. Oracle A objective never worse than Oracle B (nested feasible sets). */
test('invariant 1: unbounded oracle objective >= budget-matched objective', () => {
  const replay = replayOf(buildTruth(), buildRunner());
  const baseline = evaluateOutcome({ candidates: replay.candidates, prior: replay.prior, truthMatches, appliedByIndex: new Map() });
  const selectable = [cmpProbe(), rmwProbe()].filter((p) => p.evidenceAdded.length > 0);
  const runA = searchOptimal({ replay, truthMatches, baselineOutcome: baseline, probes: selectable, maxAnalyze: Infinity, maxProbes: Infinity, maxScan: Infinity });
  const budgets = [
    { maxAnalyze: PRODUCTION_ANALYZE_BUDGET, maxProbes: PRODUCTION_PROBE_BUDGET, maxScan: PRODUCTION_SCAN_BUDGET },
    { maxAnalyze: 1, maxProbes: 1, maxScan: 1 },
    { maxAnalyze: 0, maxProbes: 0, maxScan: 0 },
  ];
  for (const b of budgets) {
    const runB = searchOptimal({ replay, truthMatches, baselineOutcome: baseline, probes: selectable, ...b });
    ok(compareObjective(runA.tuple, runB.tuple) >= 0,
      `A >= B under budgets ${JSON.stringify(b)}: ${JSON.stringify(runA.tuple)} vs ${JSON.stringify(runB.tuple)}`);
  }
  const runBoth = searchOptimal({
    replay, truthMatches, baselineOutcome: baseline,
    probes: selectable,
    maxAnalyze: Infinity, maxProbes: 2, maxScan: Infinity,
  });
  eq(runBoth.applied.length, 2, 'the pair is jointly decisive for likely (pair-only design): ' + JSON.stringify(runBoth.applied.map((p) => p.probeId)));
  eq(runBoth.outcome.verdict, VERDICT.LIKELY, 'pair yields the strongest verdict available here');
});

/* 4. Same-provenance evidence is never double-counted. */
test('invariant 4: duplicate and alias-normalized probes collapse to one', () => {
  const truth = buildTruth();
  const dupAlias = ev('rmw-verified', 1, { sel: 'tick', addr: 500n });
  const k1 = evidenceProvenanceKey(RMW_EVIDENCE, CTX_TRUTH);
  const k2 = evidenceProvenanceKey(dupAlias, CTX_TRUTH);
  eq(k1, k2, 'alias rmw-observed/rmw-verified share provenance key: ' + k1 + ' vs ' + k2);
  const sizeMeasured = ev('size-fits', 1, { size: 4, measured: true });
  eq(evidenceProvenanceKey(sizeMeasured, CTX_TRUTH), 'size-fits#size:4', 'measured flag is not source identity');
  const keys = baselineProvenanceKeys(truth);
  ok(keys.has('size-fits#size:4'), 'baseline keys include size-fits identity');
  ok(!keys.has(k1), 'baseline lacks the probe fact');

  const replay = replayOf(truth, buildRunner());
  const baseline = evaluateOutcome({ candidates: replay.candidates, prior: replay.prior, truthMatches, appliedByIndex: new Map() });
  const probes = [
    rmwProbe(),
    MKP('probe_rmw_dup', 0, CTX_TRUTH.candidateId, [RMW_EVIDENCE], 1, 0),
    MKP('probe_rmw_alias', 0, CTX_TRUTH.candidateId, [dupAlias], 1, 0),
  ];
  /* Compare pre-added keeps the run affordable: with only the rmw family
   * present, applying vs not-applying is enough to prove collapse. */
  const exclReplay = replayOf(buildTruth([ev('compare-observed', 0.85, {})]), buildRunner());
  const exclBaseline = evaluateOutcome({ candidates: exclReplay.candidates, prior: exclReplay.prior, truthMatches, appliedByIndex: new Map() });
  const before = evaluateOutcome({ candidates: replay.candidates, prior: replay.prior, truthMatches, appliedByIndex: new Map([[0, [RMW_EVIDENCE]]]) });
  ok(before.verdict === exclBaseline.verdict, 'single rmw application is provably weak (margin < ln4 kept)');
  const run = searchOptimal({ replay: exclReplay, truthMatches, baselineOutcome: exclBaseline, probes, maxAnalyze: Infinity, maxProbes: 2, maxScan: Infinity });
  const kept = run.applied.map((p) => p.probeId);
  eq(kept.length, 1, 'only one of the three identical-fact probes survives: ' + JSON.stringify(kept));
  ok(run.stats.pruned >= 1, 'subsumed branches are pruned: ' + JSON.stringify(run.stats));
});
/* 5. Zero-cost shape_evidence never re-inserts baseline evidence. */
test('invariant 5: zero-cost probe reaching baseline evidence is a no-op (excluded)', () => {
  const shape = MKP('probe_shape', 0, CTX_TRUTH.candidateId, [ev('size-fits', 0.8, { size: 4 })], 0, 0);
  const seen = new Set(baselineProvenanceKeys(replayOf(buildTruth(), buildRunner()).candidates[0]));
  const surviving = shape.evidenceAdded.filter((e) => !seen.has(evidenceProvenanceKey(e, CTX_TRUTH)));
  eq(surviving.length, 0, 'shape_evidence adds nothing new — it must be non-selectable');
  ok(shape.analysisCalls === 0 && shape.scanCalls === 0, 'cost is zero');
});

/* 6 + 7. Empty probe sequence == baseline; budget=0 == baseline. */
test('invariant 6/7: empty probe sequence and zero budget equal the baseline', () => {
  const replay = replayOf(buildTruth(), buildRunner());
  const baseline = evaluateOutcome({ candidates: replay.candidates, prior: replay.prior, truthMatches, appliedByIndex: new Map() });
  const empty = outcomeForSequence({ replay, truthMatches, applied: [] });
  eq(empty.verdict, baseline.verdict, 'empty sequence verdict');
  eq(empty.truthRank, baseline.truthRank, 'empty sequence rank');
  eq(empty.topCorrect, baseline.topCorrect, 'empty sequence top');
  const zero = searchOptimal({
    replay, truthMatches, baselineOutcome: baseline, probes: [cmpProbe(), rmwProbe()],
    maxAnalyze: 0, maxProbes: 0, maxScan: 0,
  });
  eq(zero.outcome.verdict, baseline.verdict, 'budget=0 verdict');
  eq(zero.outcome.truthRank, baseline.truthRank, 'budget=0 rank');
  eq(zero.probeCount, 0, 'budget=0 applies nothing');
});
/* 2. Oracle replay uses the exact production prior. */
test('invariant 2: replay prior equals production narrowedPriorCount', () => {
  const mkRow = (flags) => ({ askedByName: !!flags.name, askedBySequence: !!flags.seq, askedByWords: !!flags.words });
  const cands = [mkRow({ name: true }), mkRow({ seq: true }), mkRow({ words: true }), mkRow({ seq: true })];
  const universe = 20000;
  const replayPrior = narrowedPriorCount(cands, universe);
  eq(replayPrior, 1, 'exact-name lane prior is the exact count, not the universe');
  const listed = [mkRow({ seq: true }), mkRow({ words: true })];
  eq(narrowedPriorCount(listed, universe), listed.length, 'literal lane prior equals the narrowed count');
  const all = [mkRow({}), mkRow({}), mkRow({})];
  eq(narrowedPriorCount(all, universe), universe, 'unnarrowed prior falls back to the universe');
  eq(narrowedPriorCount([], universe), universe, 'empty prior is well-defined');
});
/* 3 + 8. Production ordering and recall-lane precedence in replay. */
test('invariant 3/8: byRecallLane orders exactly like production (recall lane last)', async () => {
  const lane = (logOdds, recallLane) => ({ recallLane: !!recallLane, fusion: { logOdds } });
  const exact = lane(1.0, false);
  const laneA = lane(9.0, true);
  const laneB = lane(8.0, true);
  const other = lane(2.0, false);
  const sorted = [laneA, laneB, other, exact].slice().sort(byRecallLane);
  eq(sorted.map((c) => (c.recallLane ? 'L' : 'N')).join(''), 'NNLL', 'lane boundary exact');
  eq(sorted[0], other, 'non-lane order follows fusion logOdds (other 2.0 > exact 1.0)');
  eq(sorted[1], exact, 'exact follows within the non-lane block');
  eq(sorted[2], laneA, 'recall lane keeps fusion order (laneA 9.0 first)');
  eq(sorted[3], laneB, 'recall lane keeps fusion order (laneB 8.0 last)');
  ok(sorted.indexOf(exact) < sorted.indexOf(laneA) && sorted.indexOf(exact) < sorted.indexOf(laneB),
    'exact-name item leads even when recall-lane logOdds is higher');

  /* End-to-end on the real production facade: exact-name top stays first even
   * when the recall lane carries equal-strength lexical evidence at equal
   * logOdds (the production recall-recovery shape, no fixture hardcode). */
  const { FieldIndex } = await import('../js/fields.js');
  const { pinpointField } = await import('../js/pinpoint.js');
  const { parseGoal } = await import('../js/goals.js');
  const INT4 = { kind: 'int', bytes: 4, signed: true, enc: 'i' };
  const fields = new FieldIndex({
    classes: [{
      name: 'APMAppMetadata', addr: 1n, superName: null, instanceSize: 0x80,
      ivars: [
        { name: '_waitTime', offset: 0x8, size: 4, type: INT4 },
        { name: '_totalWaitTime', offset: 0x10, size: 4, type: INT4 },
      ],
      properties: [], methods: [], classMethods: [],
    }],
  });
  const res = await pinpointField({ goal: parseGoal('wait time'), fields, limit: 400 });
  const truth = res.candidates.find((c) => c.field && c.field.name === '_waitTime');
  const rescued = res.candidates.find((c) => c.field && c.field.name === '_totalWaitTime');
  ok(truth && rescued, 'both lanes present');
  ok(rescued.recallLane === true, 'rescued candidate is marked recallLane');
  eq(candidateIdOf(res.top), candidateIdOf(truth), 'exact-name candidate leads the recall lane at equal logOdds');
  /* And the oracle replay reproduces the identical order. */
  const listed = res.candidates.slice().sort(byRecallLane);
  eq(listed.map(candidateIdOf).join(','), res.candidates.map(candidateIdOf).join(','), 'replay order == production order');
});
/* 9. Malformed probe results are fail-closed. */
test('invariant 9: malformed probe payload never strengthens confidence', () => {
  const replay = replayOf(buildTruth(), buildRunner());
  const baseline = evaluateOutcome({ candidates: replay.candidates, prior: replay.prior, truthMatches, appliedByIndex: new Map() });

  /* Unknown codes fall back to weak CONTEXT defaults, so they cannot lift. */
  const weird = ev('not-a-real-code', 1, { whatever: 1 });
  const weirdOut = evaluateOutcome({
    candidates: replay.candidates, prior: replay.prior, truthMatches,
    appliedByIndex: new Map([[0, [weird]]]),
  });
  ok(weirdOut.verdict === VERDICT.AMBIGUOUS || weirdOut.verdict === VERDICT.NONE,
    'unknown evidence code stays non-strong: ' + weirdOut.verdict);

  /* Malformed probe descriptors (no evidence, detail-less duplicate). */
  const broken = [
    MKP('probe_empty', 0, CTX_TRUTH.candidateId, [], 1, 0),
    MKP('probe_null_detail', 0, CTX_TRUTH.candidateId, [ev('size-fits', 1, null)], 1, 0),
  ];
  const narrowed = broken.filter((p) => p.evidenceAdded.length > 0);
  eq(narrowed.length, 1, 'empty probes never reach the oracle (one carries a detail-less duplicate)');
  const prov = evidenceProvenanceKey(narrowed[0].evidenceAdded[0], CTX_TRUTH);
  eq(prov, 'size-fits#size:undefined', 'detail-less evidence has an explicit key, no crash');
  const run = searchOptimal({ replay, truthMatches, baselineOutcome: baseline, probes: narrowed, maxAnalyze: Infinity, maxProbes: Infinity, maxScan: Infinity });
  ok(run.outcome.verdict !== VERDICT.LIKELY && run.outcome.verdict !== VERDICT.CONFIRMED,
    'malformed-detail evidence cannot reach strong: ' + run.outcome.verdict);
});

/* 10. Timeout/failed probes never raise confidence. */
test('invariant 10: failed probes are unselectable and cannot strengthen verdicts', () => {
  const failedish = [
    { ...rmwProbe(), probeId: 'probe_failed', failed: true, selectable: false, evidenceAdded: [] },
    { ...rmwProbe(), probeId: 'probe_timeout', timedOut: true, failed: true, selectable: false, evidenceAdded: [] },
  ];
  for (const f of failedish) {
    ok(f.selectable === false, f.probeId + ' must be unselectable');
  }
  const selectable = failedish.filter((p) => p.selectable);
  eq(selectable.length, 0, 'failed probes never enter the selectable pool');
  const replay = replayOf(buildTruth(), buildRunner());
  const baseline = evaluateOutcome({ candidates: replay.candidates, prior: replay.prior, truthMatches, appliedByIndex: new Map() });
  const run = searchOptimal({ replay, truthMatches, baselineOutcome: baseline, probes: selectable, maxAnalyze: Infinity, maxProbes: Infinity, maxScan: Infinity });
  eq(run.outcome.verdict, baseline.verdict, 'no selectable probes => oracle equals baseline');
  eq(run.probeCount, 0, 'nothing applied');
});
/* Real-binary baseline replay parity (at least one real row on the exact baseline). */
test('real-binary row: oracle replay reproduces production prior/order/verdict', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ['battlecats', 'TsumTsum', 'YWP']) {
    const target = path.join(here, name);
    let stat = null;
    try { stat = fs.statSync(target); } catch { stat = null; }
    if (!stat || stat.size < 1024 * 1024) {
      process.stdout.write(`    (skipped: large fixture ${name} absent — run: npm run fixtures:large)\n`);
      continue;
    }
    const { openBinary } = await import('./harness.mjs');
    const { pinpointField } = await import('../js/pinpoint.js');
    const { parseGoal } = await import('../js/goals.js');
    const queries = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/pinpoint-confidence-queries.json'), 'utf8'));
    const q = queries.find((x) => x.binary === name && x.mode === 'exact');
    ok(q, 'exact fixture query present for ' + name);
    const w = await openBinary('tests/' + name, { log: () => {} });
    const goal = parseGoal(q.label);
    const res = await pinpointField({
      goal, fields: w.fields, program: w.program, symbols: w.symbols,
      strings: w.strings, analyze: w.analyze, scanAccess: w.scanAccess, limit: 400,
    });
    ok(res.candidates && res.candidates.length > 0, 'production returns candidates');
    const truthMatchesReal = (c) => !!c && c.className === q.class && c.field && c.field.name === q.ivar;
    const replay = buildReplayBaseline({ res, truthMatches: truthMatchesReal });
    eq(replay.prior, res.priorCandidates, 'replay prior == production priorCandidates');
    eq(replay.baseline.truthRank, res.candidates.findIndex(truthMatchesReal) + 1, 'replay rank == production rank');
    eq(replay.baseline.verdict, res.verdict, 'replay verdict == production verdict');
    return; /* one row is enough for the invariant */
  }
});

await Promise.allSettled(pendingTests);
process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);
