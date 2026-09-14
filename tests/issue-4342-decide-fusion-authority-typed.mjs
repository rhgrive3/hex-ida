// Issue #4342 regression: decide() passed fusion.verified / identifying /
// probability / logOdds straight into truthiness and relational arithmetic, so
// Array / numeric-string metadata could mint confirmed without canonical
// boolean / number evidence authority.
import assert from 'node:assert/strict';
import test from 'node:test';

import { decide, fuse, evidence, VERDICT } from '../js/evidence.js';

const CANDIDATES = { candidates: 200 };
const ev = (code, strength) => evidence(code, strength == null ? 1 : strength, {});
const THREE_GROUPS = [
  'field-name-asked', 'class-name', 'getter-verified', 'setter-verified',
  'rmw-verified', 'type-declared',
];
const canonicalTop = () => ({ fusion: fuse(THREE_GROUPS.map((c) => ev(c)), CANDIDATES) });
const weakRunnerUp = () => ({ fusion: fuse([ev('field-name-weak')], CANDIDATES) });

test('#4342 issue counterexample: structured array fields must not confirm', () => {
  const res = decide([
    {
      fusion: {
        logOdds: ['20'],
        probability: ['0.999'],
        verified: [],
        identifying: ['1'],
        independentGroups: 3,
        groups: ['metadata', 'dataflow', 'semantic'],
        items: [],
      },
    },
  ]);
  assert.notEqual(res.verdict, VERDICT.CONFIRMED);
  assert.ok(res.missing.includes('need-verification'));
  assert.ok(res.missing.includes('need-more-evidence'));
  assert.ok(res.missing.includes('need-name-evidence'));
});

test('#4342 verified accepts literal true and the canonical finite count only', () => {
  for (const good of [true, 1, 3]) {
    const top = canonicalTop();
    top.fusion.verified = good;
    assert.equal(decide([top, weakRunnerUp()]).verdict, VERDICT.CONFIRMED, `${String(good)} is real verification authority`);
  }
  for (const bad of ['1', 'true', [], ['1'], { verified: 1 }, { valueOf: () => 1 }, 1n, () => 1, NaN, Infinity, -1, 0]) {
    const top = canonicalTop();
    top.fusion.verified = bad;
    const res = decide([top, weakRunnerUp()]);
    assert.notEqual(res.verdict, VERDICT.CONFIRMED, `verified ${String(bad)} must not confirm`);
    assert.ok(res.missing.includes('need-verification'), `verified ${String(bad)} must report need-verification`);
  }
});

test('#4342 probability outside finite 0..1 falls closed', () => {
  const top = canonicalTop();
  top.fusion.probability = ['0.999'];
  const res = decide([top, weakRunnerUp()]);
  assert.notEqual(res.verdict, VERDICT.CONFIRMED);
  assert.ok(res.missing.includes('need-more-evidence'));

  for (const bad of [NaN, Infinity, -Infinity, 1.5, -0.5, {}, '1', 1n]) {
    const c = canonicalTop();
    c.fusion.probability = bad;
    assert.notEqual(decide([c, weakRunnerUp()]).verdict, VERDICT.CONFIRMED, `probability ${String(bad)} must not confirm`);
  }
});

test('#4342 structured or NaN identifying must not satisfy the name-evidence gate', () => {
  for (const bad of [['1'], '1', {}, NaN, Infinity, -1, 0, true]) {
    const top = canonicalTop();
    top.fusion.identifying = bad;
    const res = decide([top, weakRunnerUp()]);
    assert.notEqual(res.verdict, VERDICT.CONFIRMED, `identifying ${String(bad)} must not confirm`);
    assert.ok(res.missing.includes('need-name-evidence'), `identifying ${String(bad)} must report need-name-evidence`);
  }
  for (const good of [1, 12.5]) {
    const top = canonicalTop();
    top.fusion.identifying = good;
    assert.equal(decide([top, weakRunnerUp()]).verdict, VERDICT.CONFIRMED);
  }
});

test('#4342 malformed logOdds cannot mint an infinite margin', () => {
  const top = canonicalTop();
  const rival = canonicalTop();
  rival.fusion.logOdds = NaN;
  const res = decide([top, rival]);
  assert.notEqual(res.verdict, VERDICT.CONFIRMED, `NaN runner-up logOdds gave margin ${res.margin}`);
  assert.ok(res.missing.includes('need-separation'));

  const own = canonicalTop();
  own.fusion.logOdds = ['20'];
  const res2 = decide([own, weakRunnerUp()]);
  assert.notEqual(res2.verdict, VERDICT.CONFIRMED);
  assert.ok(res2.missing.includes('need-separation'));
});

test('#4342 canonical fuse() verdicts are unchanged', () => {
  const top = canonicalTop();
  const res = decide([top, weakRunnerUp()]);
  assert.equal(res.verdict, VERDICT.CONFIRMED);
  assert.equal(res.missing.length, 0);
  assert.ok(Number.isFinite(res.margin));
  assert.ok(res.marginRatio > 20);

  const thin = { fusion: fuse([ev('field-name-exact')], CANDIDATES) };
  assert.notEqual(decide([thin, weakRunnerUp()]).verdict, VERDICT.CONFIRMED);
});

test('#4342 combined with the independent-group gate, no authority is fabricated', () => {
  const res = decide([
    {
      fusion: {
        logOdds: '20', probability: '0.999', verified: 'yes', identifying: '1',
        independentGroups: '3', groups: ['metadata', 'dataflow', 'semantic'], items: [],
      },
    },
  ]);
  assert.notEqual(res.verdict, VERDICT.CONFIRMED);
  assert.notEqual(res.verdict, VERDICT.LIKELY);
});
