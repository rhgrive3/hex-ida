/*
 * P4 production confidence policy: field-only trusted 2-group likely.
 *
 * P4 settles #9418 (global 3-group likely) on production, using the #9432
 * real-binary evidence (metadata+structural 2-group: 55/55 correct, no
 * false-strong anywhere; dataflow combos 0/2 correct; DSDA structural+dataflow
 * wrong). Semantics:
 *
 *   likely = existing p>=0.85 AND margin>=ln4 thresholds
 *            AND (independentGroups >= 3
 *                 OR exactly {metadata, structural} 2-group combo)
 *   confirmed: unchanged (still needs >=3 groups + verified + p/margin)
 *
 * Scope and safety contracts pinned here:
 *   - The exception is opt-in per call (`allowTrustedTwoGroup`), field path
 *     only. decide() without the flag keeps #9418 P1 semantics (location /
 *     function paths never pass it).
 *   - Group validation fails closed: unknown/malformed/duplicated group
 *     metadata, or items-vs-recorded disagreement, never open the exception.
 *   - Identifying evidence, likely p/margin thresholds, and the identifying
 *     downgrade are unchanged (no identifying => ambiguous).
 *   - "metadata + dataflow" and "structural + dataflow" are NOT exceptions
 *     (DSDA location false-likely must not return; pinned fixture asserted).
 *
 * Regression companions run separately in the suite:
 *   tests/pinpoint-false-likely-confidence.mjs (#9418 fixture),
 *   tests/evidence-verdict.mjs (existing evidence-verdict suite),
 *   tests/pinpoint-partial-query-recall.test.mjs (recall lane / wait-time).
 * Production contains no offset/symbol/fixture hardcode (no 196/148/mobj/...).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuse, evidence, decide, verdictForFusions, VERDICT } from '../js/evidence.js';
import { newVerdictForFusion, p4VerdictForFusion } from '../scripts/pinpoint-confidence-policy.mjs';

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
const FIELD_OPTS = { allowTrustedTwoGroup: true };
const SMALL = { candidates: 4 };      // exact-lane sized prior (production narrowed prior)
const strongRunner = (logOdds = 0) => ({
  logOdds, probability: 1 / (1 + Math.exp(-logOdds)), verified: false,
  identifying: 1, independentGroups: 1, groups: ['metadata'],
});
const show = (res) => {
  const f = res.top ? res.top.fusion : null;
  return [
    'verdict=' + res.verdict,
    f ? 'p=' + Number(f.probability).toFixed(4) : 'p=-',
    f ? 'groups=' + JSON.stringify(f.groups) : '',
    f ? 'indep=' + f.independentGroups : '',
    'margin=' + (Number.isFinite(res.margin) ? res.margin.toFixed(3) : 'inf'),
    'missing=[' + res.missing.join(',') + ']',
  ].join(' ');
};
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && b.every((g) => a.includes(g));
const recorded = (over) => ({
  logOdds: 4, probability: 0.96, verified: true, identifying: 3,
  independentGroups: 2, groups: ['metadata', 'structural'],
  ...over,
});

/* ── Positive ─────────────────────────────────────────────── */

test('P1 positive: metadata+structural 2-group, identifying, p/margin ok -> likely (flag on only)', () => {
  const topEv = [ev('field-name-asked', 1, {}), ev('sibling-fields', 1, {}), ev('size-fits', 1, { size: 4 })];
  const top = { fusion: fuse(topEv, SMALL) };
  const runner = { fusion: fuse([ev('field-name-weak', 1, {})], SMALL) };
  eq(top.fusion.independentGroups, 2, 'top is 2 groups');
  ok(sameSet(top.fusion.groups, ['metadata', 'structural']), 'groups are exactly metadata+structural: ' + JSON.stringify(top.fusion.groups));
  ok(top.fusion.identifying > 0, 'identifying evidence present');
  ok(top.fusion.probability >= 0.85, 'likely p threshold met: ' + top.fusion.probability);

  const on = decide([top, runner], FIELD_OPTS);
  eq(on.verdict, VERDICT.LIKELY, 'flag on must allow trusted 2-group likely: ' + show(on));
  ok(on.margin >= Math.log(4), 'likely margin threshold met: ' + on.margin);

  const off = decide([top, runner]);
  eq(off.verdict, VERDICT.AMBIGUOUS, 'flag off (location/function/default) keeps #9418 P1: ' + show(off));
});

test('P2 positive full field path: exact-name representative resolves likely (production facade)', async () => {
  const { FieldIndex } = await import('../js/fields.js');
  const { pinpointField } = await import('../js/pinpoint.js');
  const { parseGoal } = await import('../js/goals.js');
  const INT4 = { kind: 'int', bytes: 4, signed: true, enc: 'i' };
  const fields = new FieldIndex({
    classes: [{
      name: 'HealthComponent', addr: 1n, superName: null, instanceSize: 0x40,
      ivars: [
        { name: '_hp', offset: 0x8, size: 4, type: INT4 },
        { name: '_attack', offset: 0xc, size: 4, type: INT4 },
      ],
      properties: [], methods: [], classMethods: [],
    }],
  });
  const res = await pinpointField({ goal: parseGoal('hp'), fields, limit: 400 });
  eq(res.top && res.top.field && res.top.field.name, '_hp', 'exact-name top stays truth');
  eq(res.top.fusion.independentGroups, 2, 'exact representative is 2-group here');
  ok(sameSet(res.top.fusion.groups, ['metadata', 'structural']), 'trusted combo only: ' + JSON.stringify(res.top.fusion.groups));
  eq(res.verdict, VERDICT.LIKELY, 'P4 field path resolves exact representative likely: ' + show(res));
  ok(res.verdict !== VERDICT.CONFIRMED, 'no analyze => confirmed must stay unreachable');
});

test('P3 confirmed unchanged under flag: 3-group verified high-p still confirmed', () => {
  const topEv = [
    ev('field-name-asked', 1, {}), ev('sibling-fields', 1, {}),
    ev('size-fits', 1, { size: 4 }), ev('getter-verified', 1, { sel: 'hp', addr: 100n }),
    ev('written-in-class', 1, { sel: 'tick', n: 2 }),
  ];
  const top = { fusion: fuse(topEv, SMALL) };
  eq(top.fusion.independentGroups, 3, '3 groups with verified accessor');
  const res = decide([top, { fusion: fuse([ev('field-name-weak', 1, {})], SMALL) }], FIELD_OPTS);
  eq(res.verdict, VERDICT.CONFIRMED, 'confirmed requirements unchanged: ' + show(res));
});

/* ── Negative: excluded combinations / malformed metadata ──── */

test('N1 negative: metadata+dataflow is not an exception', () => {
  const top = { fusion: fuse([ev('field-name-asked', 1, {}), ev('getter-verified', 1, { sel: 'x', addr: 1n })], SMALL) };
  eq(top.fusion.independentGroups, 2, 'metadata+dataflow is 2 groups');
  ok(sameSet(top.fusion.groups, ['metadata', 'dataflow']), 'combo is metadata+dataflow: ' + JSON.stringify(top.fusion.groups));
  const res = decide([top, { fusion: fuse([ev('field-name-weak', 1, {})], SMALL) }], FIELD_OPTS);
  eq(res.verdict, VERDICT.AMBIGUOUS, 'metadata+dataflow must not be likely: ' + show(res));
});

test('N2 negative: structural+dataflow (DSDA shape) recorded fusion not an exception', () => {
  const res = decide([{ fusion: recorded({ groups: ['structural', 'dataflow'] }) }, { fusion: strongRunner(0) }], FIELD_OPTS);
  eq(res.verdict, VERDICT.AMBIGUOUS, 'structural+dataflow must stay ambiguous: ' + show(res));
});

test('N3 negative: metadata-only / structural-only never qualify', () => {
  const meta = decide([{ fusion: recorded({ independentGroups: 1, groups: ['metadata'] }) }, { fusion: strongRunner(0) }], FIELD_OPTS);
  eq(meta.verdict, VERDICT.AMBIGUOUS, 'metadata-only: ' + show(meta));
  const struct = decide([{ fusion: recorded({ independentGroups: 1, groups: ['structural'] }) }, { fusion: strongRunner(0) }], FIELD_OPTS);
  eq(struct.verdict, VERDICT.AMBIGUOUS, 'structural-only: ' + show(struct));
});

test('N4 negative: malformed group metadata fails closed', () => {
  const unknownName = decide([{ fusion: recorded({ groups: ['metadata', 'banana'] }) }, { fusion: strongRunner(0) }], FIELD_OPTS);
  eq(unknownName.verdict, VERDICT.AMBIGUOUS, 'unknown group name: ' + show(unknownName));
  const malformedType = decide([{ fusion: recorded({ groups: 'metadata,structural' }) }, { fusion: strongRunner(0) }], FIELD_OPTS);
  eq(malformedType.verdict, VERDICT.AMBIGUOUS, 'non-array groups: ' + show(malformedType));
  const missingRecord = decide([{ fusion: recorded({ groups: undefined, independentGroups: undefined }) }, { fusion: strongRunner(0) }], FIELD_OPTS);
  eq(missingRecord.verdict, VERDICT.AMBIGUOUS, 'no groups evidence at all: ' + show(missingRecord));
});

test('N5 negative: duplicated group entries fail closed', () => {
  const dup = decide([{ fusion: recorded({ independentGroups: 2, groups: ['metadata', 'metadata', 'structural'] }) }, { fusion: strongRunner(0) }], FIELD_OPTS);
  eq(dup.verdict, VERDICT.AMBIGUOUS, 'duplicated group must not pass: ' + show(dup));
});

test('N6 negative: items vs recorded group disagreement fails closed', () => {
  const spoof = recorded({
    items: [
      { code: 'field-name-asked', family: 'name', kind: 'fact', id: true, applied: 3.1, lr: 400, strength: 1 },
      { code: 'rmw-observed', family: 'usage', kind: 'fact', id: false, applied: 1.7, lr: 6, strength: 1 },
    ],
  });
  const res = decide([{ fusion: spoof }, { fusion: strongRunner(0) }], FIELD_OPTS);
  eq(res.verdict, VERDICT.AMBIGUOUS, 'items (metadata+dataflow) beat spoofed recorded combo: ' + show(res));
});

test('N7b negative: unknown positive evidence cannot hide behind metadata fallback', () => {
  const top = { fusion: fuse([
    ev('field-name-asked', 1, {}),
    ev('size-fits', 1, { size: 4 }),
    ev('custom-unknown-evidence', 1, {}, 4),
  ], SMALL) };
  ok(sameSet(top.fusion.groups, ['metadata', 'structural']),
    'legacy groupOf fallback still projects the unknown item into metadata');
  ok(top.fusion.items.some((item) => item.code === 'custom-unknown-evidence' && item.applied > 0),
    'counterexample must contain positive unknown evidence');
  const res = decide([top, { fusion: fuse([ev('field-name-weak', 1, {})], SMALL) }], FIELD_OPTS);
  eq(res.verdict, VERDICT.AMBIGUOUS, 'P4 admission must reject unregistered applied evidence: ' + show(res));
});

test('N7 negative: identifying evidence still required', () => {
  const res = decide([{ fusion: recorded({ identifying: 0 }) }, { fusion: strongRunner(0) }], FIELD_OPTS);
  eq(res.verdict, VERDICT.AMBIGUOUS, 'no identifying => ambiguous: ' + show(res));
  ok(res.missing.includes('need-name-evidence'), 'missing names the absent name evidence');
});

test('N8 negative: margin below likely threshold stays ambiguous', () => {
  const res = decide([{ fusion: recorded({ logOdds: 3, probability: 0.9 }) }, { fusion: strongRunner(2.75) }], FIELD_OPTS);
  eq(res.verdict, VERDICT.AMBIGUOUS, 'margin < ln4: ' + show(res));
  ok(res.margin < Math.log(4), 'margin must be under ln4: ' + res.margin);
});

test('N9 negative: p below likely threshold stays ambiguous', () => {
  const res = decide([{ fusion: recorded({ logOdds: 4, probability: 0.7 }) }, { fusion: strongRunner(-4) }], FIELD_OPTS);
  eq(res.verdict, VERDICT.AMBIGUOUS, 'p < 0.85: ' + show(res));
});

test('N10 negative: confirmed requirements unchanged (2-group p0.99 => likely, not confirmed)', () => {
  const res = decide([{ fusion: recorded({ logOdds: 6, probability: 0.995, items: [{ code: 'field-name-asked', family: 'name', applied: 1 }, { code: 'size-fits', family: 'struct', applied: 1 }] }) }, { fusion: strongRunner(-6) }], FIELD_OPTS);
  eq(res.verdict, VERDICT.LIKELY, 'high-p trusted 2-group tops out at likely: ' + show(res));
  ok(res.verdict !== VERDICT.CONFIRMED, 'confirmed must not be reachable at 2 groups');
  ok(res.missing.includes('need-independent-evidence'), 'missing still records the group shortfall');
});

test('N11 negative: candidate-not-found empty lattice stays none under the field flag', () => {
  const res = decide([], FIELD_OPTS);
  eq(res.verdict, VERDICT.NONE, 'an absent truth/candidate lattice cannot become strong: ' + show(res));
  eq(res.top, null, 'candidate-not-found has no top candidate');
});

/* ── Regression ────────────────────────────────────────────── */

test('R1 regression: "wait time" family stays ambiguous under P4 (recall lane stability)', async () => {
  const { FieldIndex } = await import('../js/fields.js');
  const { pinpointField } = await import('../js/pinpoint.js');
  const { parseGoal } = await import('../js/goals.js');
  const INT4 = { kind: 'int', bytes: 4, signed: true, enc: 'i' };
  const INT8 = { kind: 'int', bytes: 8, signed: true, enc: 'i' };
  const ct = (defs) => new FieldIndex({
    classes: defs.map((d, i) => ({
      name: d.name, addr: BigInt(i + 1), superName: null, instanceSize: 0x80,
      ivars: d.ivars, properties: [], methods: [], classMethods: [],
    })),
  });
  const solo = await pinpointField({
    goal: parseGoal('wait time'),
    fields: ct([{ name: 'APMAppMetadata', ivars: [{ name: '_waitTime', offset: 0x8, size: 8, type: INT8 }] }]),
    limit: 400,
  });
  const combined = await pinpointField({
    goal: parseGoal('wait time'),
    fields: ct([{ name: 'APMAppMetadata', ivars: [
      { name: '_waitTime', offset: 0x8, size: 8, type: INT8 },
      { name: '_totalWaitTime', offset: 0x10, size: 4, type: INT4 },
    ] }]),
    limit: 400,
  });
  eq(combined.top.field.name, '_waitTime', 'exact literal still leads');
  eq(solo.verdict, VERDICT.AMBIGUOUS, 'solo partial representative ambiguous: ' + show(solo));
  eq(combined.verdict, VERDICT.AMBIGUOUS, 'partial representative ambiguous (p/margin gates): ' + show(combined));
  eq(solo.verdict, combined.verdict, 'verdict stable when recall lane appended');
  eq(solo.top.fusion.independentGroups, combined.top.fusion.independentGroups, 'group count stable');
  ok(combined.margin < Math.log(4) || combined.top.fusion.probability < 0.85,
    'ambiguity comes from p/margin, not from the group gate');
});

test('R2 regression: pinned DSDA location fixture stays ambiguous even with flag forced', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/pinpoint-false-likely-dsda.json'), 'utf8'));
  const built = manifest.candidates.map((c) => ({
    key: c.key, offset: c.offset,
    fusion: fuse(c.evidence.map((e) => ev(e.code, e.strength, {}, e.lr)), manifest.fuseOpts),
  }));
  built.sort((a, b) => b.fusion.logOdds - a.fusion.logOdds);
  eq(built.map((c) => c.offset).join(','), manifest.expected.order.join(','), 'pinned ranking unchanged');
  eq(built[0].fusion.independentGroups, 2, 'DSDA top is 2-group');

  const locationLike = decide(built);   // location path never passes the flag
  eq(locationLike.verdict, VERDICT.AMBIGUOUS, 'location path (no flag) stays ambiguous: ' + show(locationLike));
  const forced = decide(built, FIELD_OPTS);  // even a forced flag must not open structural+dataflow
  eq(forced.verdict, VERDICT.AMBIGUOUS, 'forced flag must not resurrect DSDA false-likely: ' + show(forced));
  ok(!sameSet(built[0].fusion.groups, ['metadata', 'structural']),
    'DSDA combo is not the trusted pair: ' + JSON.stringify(built[0].fusion.groups));
  const replay = p4VerdictForFusion(built[0].fusion, built[1] ? built[1].fusion : null, { allowTrustedTwoGroup: false });
  eq(replay.verdict, VERDICT.AMBIGUOUS, 'location replay (flag off) matches production');
});

test('R3 regression: field-only scope is explicit in production sources', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const legacy = fs.readFileSync(path.join(root, 'js/pinpoint-legacy.js'), 'utf8');
  const facade = fs.readFileSync(path.join(root, 'js/pinpoint.js'), 'utf8');
  const legacyTrue = (legacy.match(/allowTrustedTwoGroup: true/g) || []).length;
  eq(legacyTrue, 1, 'legacy defines the field opts exactly once (shared FIELD_LIKELY_OPTS)');
  ok(legacy.includes('decide(ranked, FIELD_LIKELY_OPTS)'), 'field path passes the flag');
  ok(/decide\(list, \{ maxVerdict: VERDICT\.LIKELY \}\)/.test(legacy), 'location path must NOT pass the flag');
  ok(!/allowTrustedTwoGroup/.test(legacy.replace(/const FIELD_LIKELY_OPTS[\s\S]*?\}\);?/, '')),
    'no other legacy call site enables the exception');
  const facadeTrue = (facade.match(/allowTrustedTwoGroup: true/g) || []).length;
  eq(facadeTrue, 1, 'facade field decide passes the flag exactly once');
});

test('R4 regression: replay shares the production core (P1/P4 parity)', () => {
  const trusted = recorded({ items: [{ code: 'field-name-asked', family: 'name', applied: 1 }, { code: 'size-fits', family: 'struct', applied: 1 }] });
  const runner = strongRunner(-4);
  const p1 = newVerdictForFusion(trusted, runner);
  const p4 = p4VerdictForFusion(trusted, runner);
  eq(p1.verdict, VERDICT.AMBIGUOUS, 'P1 replay = production flag off');
  eq(p4.verdict, VERDICT.LIKELY, 'P4 replay = production flag on');
  eq(p1.verdict, decide([{ fusion: trusted }, { fusion: runner }]).verdict, 'P1 decide parity');
  eq(p4.verdict, decide([{ fusion: trusted }, { fusion: runner }], FIELD_OPTS).verdict, 'P4 decide parity');
  const core = verdictForFusions(trusted, runner, FIELD_OPTS);
  eq(core.verdict, p4.verdict, 'verdictForFusions is the single semantic truth');
});

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);



