/*
 * Pinpoint false-likely / confidence calibration regression.
 *
 * Root cause (DSDA-Doom real ARM64 holdout, PR #9410/#9413):
 * - target mobj_t.health offset 196, final rank D4, competing top-1 offset 148 momz
 * - top p0.915 margin 3.8 (45x) verdict likely, truth p0.076 rank 4, 8 candidates, analyze 18
 * - top: loc-drain-verified 3.4012 (s1 lr30) + loc-shared 1.1632 + loc-size 0.4245 + loc-resource-drain 0.34
 * - truth (baseline): loc-resource-drain 0.3214 + loc-size 0.1323 (no drain, no shared, unverified D5)
 * - first divergence is loc-drain-verified (feed x2, field amount) present in top, absent in truth,
 *   plus loc-shared from same proof and loc-size scale amplification (same size evidence applied
 *   0.4245 vs 0.1323 due to corroborationScale 1.0 vs 0.31, correlated double-counting).
 * - hypotheses 1-3 (drain/clamp saturated, breadth mainly) are FALSE on real data; hypothesis 4
 *   (decide allows likely on prob/margin alone) is TRUE: likely required only p>=0.85 margin>=ln4,
 *   no independent-group check, so groups=2 still likely with need-independent-evidence missing.
 *
 * Fix (js/evidence.js decide): likely now requires independentGroups>=3, same as confirmed.
 * Strong verdicts need 3 independent sources; otherwise weak/breadth/correlated/saturated
 * differences inflate margin and cause false-likely. Ranking unchanged (top stays 148),
 * verdict becomes ambiguous with need-independent-evidence, no new analysis.
 *
 * Tests (no binary, no network, no hardcode in production):
 * 1. DSDA-like regression (2 groups, wrong top likely before -> ambiguous after, ranking unchanged)
 * 2. Clear positive (3 groups, strong independent -> still strong)
 * 3. Exact-name preservation (3 groups, accessor-confirmed -> still strong)
 * 4. Breadth counterexample (strong tie, weak/breadth only diff -> no strong)
 * 5. Discriminating positive (same + truly discriminating binary -> strong allowed)
 *
 * Production contains no offset/symbol/fixture hardcode (no 196/148/mobj/health/momz).
 */
import { fuse, evidence, decide, VERDICT } from '../js/evidence.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('  ok  ' + name + '\n'); }
  catch (err) {
    failures.push({ name, err });
    process.stdout.write('FAIL  ' + name + '\n      ' + (err && err.message) + '\n');
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
}

const ev = (code, strength, detail, lr) => evidence(code, strength == null ? 1 : strength, detail || {}, lr);
const LOC_OPTS = { candidates: 8, absent: 12 };
const FIELD_OPTS = { candidates: 200 };

function show(res) {
  const f = res.top ? res.top.fusion : null;
  return [
    'verdict=' + res.verdict,
    f ? 'p=' + f.probability.toFixed(4) : 'p=-',
    f ? 'groups=' + JSON.stringify(f.groups) : '',
    f ? 'indep=' + f.independentGroups : '',
    'margin=' + (Number.isFinite(res.margin) ? res.margin.toFixed(3) : 'inf'),
    'missing=[' + res.missing.join(',') + ']',
  ].join(' ');
}

/* 1. DSDA-like regression: wrong top with 2 groups must not be likely.
 * Mimics real DSDA baseline (top 148-like drain+shared vs truth 196-like resource+size).
 * Ranking unchanged (top stays first), verdict honest (ambiguous, not likely).
 * Does NOT require health to become top-1. */
test('1 DSDA-like false-likely becomes ambiguous, ranking unchanged', () => {
  const topEv = [
    ev('loc-drain-verified', 1, { n: 2 }),
    ev('loc-shared', 1, { n: 3 }),
    ev('loc-size', 0.8, { size: 4 }),
    ev('loc-resource-drain', 0.20833333333333334, {}, 5.13),
  ];
  const truthEv = [
    ev('loc-resource-drain', 0.1965909090909091, {}, 5.13),
    ev('loc-size', 0.8, { size: 4 }),
  ];
  const top = { key: 'wrong-top', offset: '148', fusion: fuse(topEv, LOC_OPTS) };
  const truth = { key: 'labelled-truth', offset: '196', fusion: fuse(truthEv, LOC_OPTS) };
  // Sanity: real DSDA shape (top first, truth rank 4 in full list; here top vs truth directly)
  ok(top.fusion.logOdds > truth.fusion.logOdds, 'top must still rank first (no forced boost): ' + show({ top, verdict: '', margin: 0, missing: [] }));
  ok(top.fusion.probability >= 0.85, 'top p must be high enough to have been false-likely before: ' + top.fusion.probability);
  eq(top.fusion.independentGroups, 2, 'DSDA-like top has only 2 groups (dataflow+structural): ' + show({ top, verdict: '', margin: 0, missing: [] }));
  const res = decide([top, truth]);
  ok(res.top === top, 'ranking unchanged (wrong top stays, not boosted): ' + show(res));
  ok(res.runnerUp === truth, 'truth stays runner-up in this pair: ' + show(res));
  ok(res.verdict !== VERDICT.LIKELY && res.verdict !== VERDICT.CONFIRMED,
    'weak/breadth-only diff with 2 groups must not be strong: ' + show(res));
  eq(res.verdict, VERDICT.AMBIGUOUS, 'should fall back to existing ambiguous contract: ' + show(res));
  ok(res.missing.includes('need-independent-evidence'), 'reason must be independent evidence: ' + show(res));
});

/* 2. Clear positive: strong independent evidence concentrated stays strong.
 * 3 groups (metadata+structural+dataflow), verified, identifying, high p, large margin. */
test('2 clear positive with 3 independent groups stays strong', () => {
  const strong = [
    'field-name-asked', 'class-name', 'getter-verified', 'setter-verified', 'rmw-verified', 'type-declared',
  ];
  const top = { fusion: fuse(strong.map((c) => ev(c)), FIELD_OPTS) };
  const weak = { fusion: fuse([ev('field-name-weak')], FIELD_OPTS) };
  eq(top.fusion.independentGroups, 3, 'clear positive must have 3 groups');
  const res = decide([top, weak]);
  ok(res.verdict === VERDICT.CONFIRMED || res.verdict === VERDICT.LIKELY,
    'clear positive must stay strong (not ambiguous): ' + show(res));
  ok(!res.missing.includes('need-independent-evidence'), 'must not lack independence: ' + show(res));
});

/* 3. Exact-name preservation: exact-name + accessor-confirmed stays strong. */
test('3 exact-name accessor-confirmed path not degraded', () => {
  const top = { fusion: fuse([ev('field-name-asked'), ev('type-declared'), ev('getter-verified')], FIELD_OPTS) };
  const weak = { fusion: fuse([ev('field-name-weak')], FIELD_OPTS) };
  eq(top.fusion.independentGroups, 3, 'exact-name+type+verified must be 3 groups');
  ok(top.fusion.verified > 0, 'must be verified');
  ok(top.fusion.identifying > 0, 'must be identifying');
  const res = decide([top, weak]);
  ok(res.verdict === VERDICT.CONFIRMED || res.verdict === VERDICT.LIKELY,
    'exact-name path must stay strong: ' + show(res));
});

/* 4. Breadth counterexample: strong tie, weak/breadth only diff -> no strong.
 * Both tie on drain+clamp (same strong binary), top has extra shared+size (weak/breadth).
 * Margin from weak alone (~1.58) would have been likely before (p high, margin>=ln4, 2 groups),
 * after fix ambiguous due to groups<3. Ranking unchanged (top stays first). */
test('4 breadth-only diff with strong tie is not strong', () => {
  const strongTie = [
    ev('loc-drain-verified', 1, { n: 2 }),
    ev('loc-clamp-verified', 1, { n: 2 }),
    ev('loc-resource-drain', 0.2, {}, 5.13),
  ];
  const topEv = [...strongTie, ev('loc-shared', 1, { n: 3 }), ev('loc-size', 0.8, { size: 4 })];
  const runnerEv = [...strongTie];
  const top = { fusion: fuse(topEv, LOC_OPTS) };
  const runner = { fusion: fuse(runnerEv, LOC_OPTS) };
  ok(top.fusion.logOdds > runner.fusion.logOdds, 'top stays first (breadth extra): ' + top.fusion.logOdds + ' vs ' + runner.fusion.logOdds);
  ok(top.fusion.probability >= 0.85, 'top p high: ' + top.fusion.probability);
  const rawMargin = top.fusion.logOdds - runner.fusion.logOdds;
  ok(rawMargin >= Math.log(4), 'weak diff alone pushes margin over likely threshold (would have been false-likely): ' + rawMargin);
  eq(top.fusion.independentGroups, 2, 'breadth case has only 2 groups: ' + show({ top, verdict: '', margin: 0, missing: [] }));
  const res = decide([top, runner]);
  ok(res.verdict !== VERDICT.LIKELY && res.verdict !== VERDICT.CONFIRMED,
    'breadth-only diff must not be strong: ' + show(res));
  eq(res.verdict, VERDICT.AMBIGUOUS, 'should be ambiguous: ' + show(res));
});

/* 5. Discriminating positive: same 3-group tie + truly discriminating binary -> strong allowed.
 * Baseline: both 3 groups (drain+clamp+in-goal-fn+size+resource-drain tie, shared small diff 0.387,
 * margin<ln4 -> ambiguous). Discriminating: top adds loc-capped-by-field (HP/maxHP pair, lr14,
 * VERIFIED id true, highly specific) -> margin>=ln4, 3 groups -> likely allowed. */
test('5 discriminating binary evidence allows strong', () => {
  const baseTie = (sharedStrength) => [
    ev('loc-drain-verified', 1, { n: 2 }),
    ev('loc-clamp-verified', 1, { n: 2 }),
    ev('loc-in-goal-fn', 1, { n: 2 }),
    ev('loc-size', 0.8, { size: 4 }),
    ev('loc-resource-drain', 0.2, {}, 5.13),
    ev('loc-shared', sharedStrength, { n: sharedStrength >= 1 ? 3 : 2 }),
  ];
  const baseTop = { fusion: fuse(baseTie(1), LOC_OPTS) };
  const baseRunner = { fusion: fuse(baseTie(0.6666666666666666), LOC_OPTS) };
  eq(baseTop.fusion.independentGroups, 3, 'discriminating baseline must have 3 groups (metadata+structural+dataflow)');
  eq(baseRunner.fusion.independentGroups, 3, 'runner also 3 groups');
  const baseRes = decide([baseTop, baseRunner]);
  ok(baseRes.margin < Math.log(4), 'baseline breadth diff alone margin small: ' + baseRes.margin);
  eq(baseRes.verdict, VERDICT.AMBIGUOUS, 'baseline tie+breadth must be ambiguous: ' + show(baseRes));

  const discTopEv = [...baseTie(1), ev('loc-capped-by-field', 1, { cap: 1 })];
  const discTop = { fusion: fuse(discTopEv, LOC_OPTS) };
  eq(discTop.fusion.independentGroups, 3, 'discriminating top still 3 groups');
  const discRes = decide([discTop, baseRunner]);
  ok(discRes.margin >= Math.log(4), 'discriminating margin must clear likely threshold: ' + discRes.margin);
  ok(discRes.verdict === VERDICT.LIKELY || discRes.verdict === VERDICT.CONFIRMED,
    'truly discriminating binary must allow strong: ' + show(discRes));
});

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);
