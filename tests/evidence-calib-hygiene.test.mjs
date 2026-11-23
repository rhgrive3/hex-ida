import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE,
  FAMILY,
  GROUP,
  VERDICT,
  UNVERIFIED_CEIL,
  evidence,
  adapterEvidence,
  exclusiveLR,
  rarityLR,
  fuse,
  decide,
  verdictForFusions,
  groupOf,
  independentGroupCount,
  calibrateProbability,
  calibrationReport,
} from '../js/evidence.js';
import { groupedFusion, accuracyReport } from '../js/calib.js';

const ev = (code, strength = 1, detail = {}, lr) => evidence(code, strength, detail, lr);

test('Track 3: namesBehaviour via exclusiveLR handles nullish, non-string, empty, asset paths with %d, format specifiers, and code/log noise', () => {
  // Nullish text keeps legacy behaviour; non-string and empty/whitespace return 0
  assert.ok(exclusiveLR(1000, 1, 1, undefined) > 1);
  assert.ok(exclusiveLR(1000, 1, 1, null) > 1);
  assert.equal(exclusiveLR(1000, 1, 1, ''), 0);
  assert.equal(exclusiveLR(1000, 1, 1, '   \t\n  '), 0);
  assert.equal(exclusiveLR(1000, 1, 1, 12345), 0);
  assert.equal(exclusiveLR(1000, 1, 1, {}), 0);
  assert.equal(exclusiveLR(1000, 1, 1, ['damage %d']), 0);

  // Asset paths with extensions or directory paths (even with %d) are rejected before printf check
  assert.equal(exclusiveLR(1000, 1, 1, 'enemy_%03d_attack.maanim'), 0);
  assert.equal(exclusiveLR(1000, 1, 1, 'textures/hero_%d.png'), 0);
  assert.equal(exclusiveLR(1000, 1, 1, 'assets/ui/hp_%d'), 0);
  assert.equal(exclusiveLR(1000, 1, 1, '/var/data/damage_%d'), 0);

  // URL-encoded / pointer-like tokens such as %20p are rejected; real printf/ObjC specifiers pass
  assert.equal(exclusiveLR(1000, 1, 1, '%20p'), 0);
  assert.equal(exclusiveLR(1000, 1, 1, 'hello%20player'), 0);
  assert.ok(exclusiveLR(1000, 1, 1, 'damage %d') > 1);
  assert.ok(exclusiveLR(1000, 1, 1, 'Attack Power: %@') > 1);
  assert.ok(exclusiveLR(1000, 1, 1, 'HP: %2.1f / %2.1f') > 1);
  assert.ok(exclusiveLR(10000, 1, 1, '攻撃力アップ:%d 基ダ×(100+%d+[コンボ:%d])÷100') > 100);

  // Leading [TAG] / <TAG> stripping + log prefixes, assertion failed, file.cpp:123, C++ sig, Qt Signal/Slot, operators, URLs, regex literals
  for (const noisy of [
    '[Combat] error: invalid damage %d',
    '<WARN> failed to update hp %d',
    '[DEBUG] [HP] unable to parse %s',
    'Combat: assertion failed (hp > 0) %d',
    'src/battle/damage.cpp:123 invalid hp %d',
    'void takeDamage(int amount)',
    'virtual int getHp(void) const',
    'void Player::takeDamage(int)',
    '1onDamageChanged(int)',
    '2damageChanged(int)',
    'SIGNAL(hpChanged(int))',
    'SLOT(setHp(int))',
    'player->hp %d',
    'hp = %d',
    'https://example.com/api?damage=%d',
    '/^damage_\\d+$/i',
  ]) {
    assert.equal(exclusiveLR(1000, 1, 1, noisy), 0, `expected noisy string to be rejected: ${noisy}`);
  }
});

test('Track 3: fuse() separates negative evidence from positive family CAP and damping while preserving net byFamily', () => {
  // TYPE cap is 6 -> ln(6). Adding type-conflict (lr=0.06, negative) must NOT let positive TYPE exceed ln(6).
  const posOnly = fuse([
    ev('field-name-asked'),
    ev('type-declared', 1, {}, 10),
  ], { candidates: 200 });
  const withNeg = fuse([
    ev('field-name-asked'),
    ev('type-conflict'),
    ev('type-declared', 1, {}, 10),
  ], { candidates: 200 });

  const posType = posOnly.items.find((it) => it.code === 'type-declared');
  const withNegType = withNeg.items.find((it) => it.code === 'type-declared');
  assert.ok(Math.abs(posType.applied - Math.log(6)) < 1e-12, 'positive item capped at FAMILY_CAP[TYPE]');
  assert.ok(Math.abs(withNegType.applied - Math.log(6)) < 1e-12, 'negative item must not expand positive cap headroom');
  assert.equal(withNegType.nth, 0, 'negative item must not advance damping counter');
  assert.ok(withNeg.byFamily[FAMILY.TYPE] < posOnly.byFamily[FAMILY.TYPE], 'net byFamily preserves negative contribution');

  // Zero-delta (strength 0) or negative item with same code must not damp a subsequent positive item
  const negThenPos = fuse([
    ev('field-name-asked'),
    ev('usage-none', 1, {}, 0.3),
    ev('usage-none', 1, {}, 5),
  ], { candidates: 200 });
  const posUsage = negThenPos.items.find((it) => it.code === 'usage-none' && it.applied > 0);
  assert.equal(posUsage.nth, 0, 'negative delta did not increment counted for same code');
});

test('Track 3: groupedFusion() separates negative evidence from positive group CAP and damping while preserving net byGroup', () => {
  // STRUCTURAL cap is 12 -> ln(12).
  const negItem = { code: 'type-conflict', family: FAMILY.TYPE, kind: 'fact', lr: 0.01, strength: 1 };
  const posItem = { code: 'type-declared', family: FAMILY.TYPE, kind: 'fact', lr: 100, strength: 1 };
  const posOnly = groupedFusion([posItem], { candidates: 200, prior: 0.1 });
  const withNeg = groupedFusion([negItem, posItem], { candidates: 200, prior: 0.1 });

  const appliedPosOnly = posOnly.items.find((it) => it.code === 'type-declared');
  const appliedWithNeg = withNeg.items.find((it) => it.code === 'type-declared');
  assert.ok(Math.abs(appliedPosOnly.applied - Math.log(12)) < 1e-12);
  assert.ok(Math.abs(appliedWithNeg.applied - Math.log(12)) < 1e-12, 'negative evidence must not expand positive GROUP_CAP');
  assert.equal(appliedWithNeg.nth, 0, 'negative evidence must not damp positive item in same group');
  assert.ok(withNeg.byGroup[GROUP.STRUCTURAL] < posOnly.byGroup[GROUP.STRUCTURAL], 'net byGroup preserves negative sum');
});

test('Track 3: EVIDENCE table contracts (loc-shape kind=fact, role-* CODE_GROUP metadata, field-name-contains=58, #5972 unregistered codes)', () => {
  // loc-damage-source / loc-resource-drain / loc-self-resource are fact, not verified
  for (const code of ['loc-damage-source', 'loc-resource-drain', 'loc-self-resource']) {
    assert.equal(EVIDENCE[code].kind, 'fact', `${code} must be kind='fact'`);
    const f = fuse([ev(code, 1, {}, 1e6)], { candidates: 2, absent: 0 });
    assert.equal(f.verified, 0, `${code} alone must not count as verified`);
    assert.ok(f.logOdds <= UNVERIFIED_CEIL + 1e-12, `${code} alone must not bypass UNVERIFIED_CEIL`);
  }

  // role-verb-selector / role-topic-agree keep FAMILY.USAGE in EVIDENCE, map to GROUP.METADATA via CODE_GROUP
  for (const code of ['role-verb-selector', 'role-topic-agree']) {
    assert.equal(EVIDENCE[code].family, FAMILY.USAGE, `${code} family must remain FAMILY.USAGE`);
    assert.equal(groupOf(code), GROUP.METADATA, `${code} must map to GROUP.METADATA`);
  }
  const roleOnlyMeta = fuse([
    ev('role-accessor-metadata'),
    ev('role-verb-selector'),
    ev('role-topic-agree'),
  ], { candidates: 200 });
  assert.equal(roleOnlyMeta.independentGroups, 1, 'metadata-only role codes must not inflate independentGroups');
  assert.deepEqual(roleOnlyMeta.groups, [GROUP.METADATA]);

  // field-name-contains LR=58 and strict monotonicity: asked(400) > contains(58) > exact(55) > words(45)
  assert.equal(EVIDENCE['field-name-asked'].lr, 400);
  assert.equal(EVIDENCE['field-name-contains'].lr, 58);
  assert.equal(EVIDENCE['field-name-exact'].lr, 55);
  assert.equal(EVIDENCE['field-name-words'].lr, 45);

  // #5972 contract: loc-scan-capped and loc-object-identity-unknown stay unregistered
  assert.equal(Object.hasOwn(EVIDENCE, 'loc-scan-capped'), false);
  assert.equal(Object.hasOwn(EVIDENCE, 'loc-object-identity-unknown'), false);
});

test('Track 3: canonicalAppliedGroup strictness and fuse()/independentGroupCount() consistency', () => {
  // Unregistered code with custom LR does not enter groups in either fuse() or independentGroupCount()
  const mixed = fuse([
    ev('field-name-asked'),
    ev('size-fits'),
    ev('custom-unregistered-code', 1, {}, 50),
  ], { candidates: 200 });
  assert.equal(mixed.independentGroups, 2);
  assert.equal(independentGroupCount(mixed), mixed.independentGroups);

  // Registered adapter evidence still counts cleanly
  const withAdapter = fuse([
    ev('field-name-asked'),
    ev('size-fits'),
    adapterEvidence('runtime-field-verified', 1, {}, 18),
  ], { candidates: 200 });
  assert.equal(withAdapter.independentGroups, 3);
  assert.equal(independentGroupCount(withAdapter), 3);

  // Malformed applied values (string, Infinity, NaN, <=0) and unregistered items are skipped
  assert.equal(independentGroupCount({
    items: [
      { code: 'field-name-asked', applied: '3.0' },
      { code: 'size-fits', applied: Infinity },
      { code: 'getter-verified', applied: NaN },
      { code: 'type-declared', applied: 0 },
      { code: 'rmw-observed', applied: -2 },
      { code: 'not-registered', applied: 5 },
    ],
  }), 0);

  // Valid registered item among malformed ones is still counted (element-wise skip)
  assert.equal(independentGroupCount({
    items: [
      { code: 'not-registered', applied: 5 },
      { code: 'field-name-asked', applied: '2' },
      { code: 'size-fits', applied: 0.4 },
    ],
  }), 1);
});

test('Track 3: exclusiveLR and rarityLR boundary defenses', () => {
  // exclusiveLR: totalC > 0 && k >= totalC => 0
  assert.equal(exclusiveLR(1, 1, 1, 'damage %d'), 0);
  assert.equal(exclusiveLR(2, 2, 1, 'damage %d'), 0);
  assert.equal(exclusiveLR(0, 0, 1, 'damage %d'), 1);

  // rarityLR: totalC > 0 && matching === 0 => 0, while (0, 0) => 1
  assert.equal(rarityLR(342, 0), 0);
  assert.equal(rarityLR(10, 0), 0);
  assert.equal(rarityLR(0, 0), 1);
  assert.equal(rarityLR(342, 4), (342 / 4) * 0.3);
});

test('Track 3: fuse prior validation and calibration flag accuracy', () => {
  const defaultPrior = 1 / (200 + 40);
  for (const badPrior of [NaN, Infinity, -Infinity, '0.2', [0.2], true, {}]) {
    const f = fuse([], { candidates: 200, absent: 40, prior: badPrior });
    assert.equal(f.prior, defaultPrior, `invalid prior ${String(badPrior)} must fall back to 1/n`);
  }

  for (const badCal of [null, undefined, [], {}, 'curve', [null, { score: NaN, observed: 0.5 }]]) {
    const f = fuse([ev('field-name-asked')], { candidates: 200, calibration: badCal });
    assert.equal(f.calibrated, false, `invalid/empty calibration ${JSON.stringify(badCal)} must keep calibrated=false`);
    assert.equal(f.probability, f.rawProbability);
  }

  const cal = fuse([ev('field-name-asked')], {
    candidates: 200,
    calibration: [{ score: 0.0, observed: 0.05 }, { score: 1.0, observed: 0.9 }],
  });
  assert.equal(cal.calibrated, true);
  assert.ok(cal.probability >= 0.05 && cal.probability <= 0.9);
});

test('Track 3: verdictForFusions null logOdds fail-closed, decide runnerUp fail-closed, and maxVerdict validation', () => {
  // verdictForFusions: null top logOdds => margin = -Infinity even without runnerFusion
  const badTopCore = verdictForFusions({
    logOdds: NaN, probability: 0.999, verified: 1, identifying: 1, independentGroups: 3,
    groups: [GROUP.METADATA, GROUP.STRUCTURAL, GROUP.DATAFLOW],
  }, null);
  assert.equal(badTopCore.margin, -Infinity);
  assert.equal(badTopCore.marginRatio, 0);
  assert.ok(badTopCore.missing.includes('need-separation'));
  assert.notEqual(badTopCore.verdict, VERDICT.CONFIRMED);

  const strongTop = () => ({
    fusion: fuse([
      ev('field-name-asked'), ev('class-name'),
      ev('getter-verified'), ev('setter-verified'), ev('rmw-verified'),
      ev('type-declared'),
    ], { candidates: 200 }),
  });
  const weak = () => ({ fusion: fuse([ev('field-name-weak')], { candidates: 200 }) });

  // decide preserves list[1] runnerUp (recall-lane ranking contract) and fails closed on invalid runnerUp
  const badRival = { fusion: Object.assign({}, weak().fusion, { logOdds: NaN }) };
  const resFailClosed = decide([strongTop(), badRival]);
  assert.equal(resFailClosed.runnerUp, badRival);
  assert.equal(resFailClosed.margin, -Infinity);
  assert.notEqual(resFailClosed.verdict, VERDICT.CONFIRMED);
  assert.ok(resFailClosed.missing.includes('need-separation'));

  // opts.maxVerdict: only own keys of VERDICT_ORDER are accepted
  const resBogusCap = decide([strongTop(), weak()], { maxVerdict: 'bogus' });
  assert.equal(resBogusCap.verdict, VERDICT.CONFIRMED);
  const resProtoCap = decide([strongTop(), weak()], { maxVerdict: 'toString' });
  assert.equal(resProtoCap.verdict, VERDICT.CONFIRMED);
  const resValidCap = decide([strongTop(), weak()], { maxVerdict: VERDICT.LIKELY });
  assert.equal(resValidCap.verdict, VERDICT.LIKELY);
  assert.ok(resValidCap.missing.includes('no-name'));
});

test('Track 3: calibrateProbability, calibrationReport, and accuracyReport defensive guards', () => {
  // calibrateProbability: non-finite score -> 0; non-array / null elements safe
  assert.equal(calibrateProbability(NaN, [{ score: 0.5, observed: 0.5 }]), 0);
  assert.equal(calibrateProbability(Infinity, [{ score: 0.5, observed: 0.5 }]), 0);
  assert.equal(calibrateProbability('0.5', [{ score: 0.5, observed: 0.5 }]), 0);
  assert.equal(calibrateProbability(0.6, {}), 0.6);
  assert.ok(Math.abs(calibrateProbability(0.6, [null, undefined, { score: 0.5, observed: 0.4 }, { score: 0.7, observed: 0.8 }]) - 0.6) < 1e-12);

  // calibrationReport: non-array, null elements, non-finite score, invalid binCount
  assert.equal(calibrationReport(null).count, 0);
  assert.equal(calibrationReport({}).count, 0);
  const rep = calibrationReport([
    null,
    { score: NaN, outcome: 1 },
    { score: '0.8', outcome: 1 },
    { score: 0.9, outcome: 1 },
    { score: 0.1, outcome: 0 },
  ], NaN);
  assert.equal(rep.count, 2);
  assert.ok(Number.isFinite(rep.brier));
  assert.equal(calibrationReport([{ score: 0.5, outcome: 1 }], Infinity).count, 1);
  assert.equal(calibrationReport([{ score: 0.5, outcome: 1 }], -5).count, 1);
  assert.equal(calibrationReport([{ score: 0.5, outcome: 1 }], 1.5).count, 1);

  // accuracyReport: strict Number.isSafeInteger(r.rank)
  const acc = accuracyReport([
    { correct: true, rank: 1, verdict: 'confirmed', probability: 0.99 },
    { correct: true, rank: '1', verdict: 'likely', probability: 0.9 },
    { correct: true, rank: true, verdict: 'likely', probability: 0.9 },
    { correct: true, rank: [1], verdict: 'likely', probability: 0.9 },
    { correct: true, rank: 1.5, verdict: 'likely', probability: 0.9 },
    { correct: true, rank: 0, verdict: 'likely', probability: 0.9 },
    { correct: true, rank: 3, verdict: 'likely', probability: 0.9 },
  ]);
  assert.equal(acc.total, 7);
  assert.equal(acc.top1, 1 / 7, 'only integer rank 1 counts toward top1');
  assert.equal(acc.top3, 2 / 7, 'only integer ranks 1 and 3 count toward top3');
});
