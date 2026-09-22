/*
 * PINPOINT partial/remembered-query recall.
 *
 * Real-binary measurement (see the PR body) showed the dominant recall failure
 * was candidate narrowing, not ranking:
 *
 *   `pinpointField` kept only `askedByName` candidates whenever any field's
 *   normalized name equalled the query, and dropped every candidate that only
 *   matched by word sequence. So a remembered query like "wait time" lost the
 *   true field `_totalWaitTime` the moment some unrelated field `_waitTime`
 *   existed in the same image.
 *
 * The fix keeps the exact-name lane first and appends the word-sequence/word
 * matches, bounded, so the literal match still leads while the partial truth
 * stays reachable. These tests pin the recovery, the precision boundary
 * (token boundaries / vendor suppression), the candidate bound, and that the
 * exact-name lane's prior is preserved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FieldIndex } from '../js/fields.js';
import { pinpointField } from '../js/pinpoint.js';
import { goalFromPreset, parseGoal } from '../js/goals.js';

const INT4 = { kind: 'int', bytes: 4, signed: true, enc: 'i' };
const INT8 = { kind: 'int', bytes: 8, signed: true, enc: 'i' };

function classTable(defs) {
  return new FieldIndex({
    classes: defs.map((d, i) => ({
      name: d.name,
      addr: BigInt(i + 1),
      superName: d.superName || null,
      instanceSize: d.size || 0x80,
      ivars: d.ivars || [],
      properties: d.properties || [],
      methods: d.methods || [],
      classMethods: [],
    })),
  });
}

const keyOf = (cls, ivar) => (c) => c.className === cls && c.field && c.field.name === ivar;

test('PINPOINT recall: a partial query keeps its word-sequence truth even when an exact-name field exists', async () => {
  const fields = classTable([
    {
      name: 'APMAppMetadata',
      ivars: [
        { name: '_waitTime', offset: 0x8, size: 8, type: INT8 },
        { name: '_totalWaitTime', offset: 0x10, size: 4, type: INT4 },
      ],
    },
  ]);
  const res = await pinpointField({ goal: parseGoal('wait time'), fields, limit: 400 });

  const truth = res.candidates.findIndex(keyOf('APMAppMetadata', '_totalWaitTime'));
  assert.ok(truth >= 0, 'the word-sequence truth must be a candidate (recall recovery)');

  // The exact literal name still leads: the new recall lane must not displace it.
  assert.equal(res.top && res.top.field && res.top.field.name, '_waitTime');
  assert.equal(res.priorCandidates, 1, 'exact-name lane prior is preserved, not widened to the universe');
});

test('PINPOINT recall: exact literal query is still top-1 when several fields share the tail', async () => {
  const fields = classTable([
    {
      name: 'APMAppMetadata',
      ivars: [
        { name: '_waitTime', offset: 0x8, size: 8, type: INT8 },
        { name: '_totalWaitTime', offset: 0x10, size: 4, type: INT4 },
        { name: '_maxWaitTime', offset: 0x14, size: 4, type: INT4 },
      ],
    },
  ]);
  const res = await pinpointField({ goal: parseGoal('wait time'), fields, limit: 400 });
  assert.equal(res.top && res.top.field && res.top.field.name, '_waitTime');
  assert.equal(res.top.fusion.items.some((it) => it.code === 'field-name-asked'), true,
    'the exact literal must carry the exact-name evidence');

  const full = await pinpointField({ goal: parseGoal('total wait time'), fields, limit: 400 });
  assert.equal(full.top && full.top.field && full.top.field.name, '_totalWaitTime',
    'a full literal name must resolve to that exact field');
});

test('PINPOINT recall: token boundaries are respected (no substring false positives)', async () => {
  const cases = [
    { query: 'count', truth: '_count', decoy: '_account', cls: 'Bank' },
    { query: 'load', truth: '_load', decoy: '_preload', cls: 'Assets' },
    { query: 'action', truth: '_action', decoy: '_transaction', cls: 'Ledger' },
    { query: 'close', truth: '_close', decoy: '_disclosure', cls: 'Policy' },
    { query: 'rate', truth: '_rate', decoy: '_accurate', cls: 'Sampling' },
    { query: 'ad', truth: '_ad', decoy: '_header', cls: 'Row' },
  ];
  for (const c of cases) {
    const fields = classTable([
      {
        name: c.cls,
        ivars: [
          { name: c.truth, offset: 0x8, size: 4, type: INT4 },
          { name: c.decoy, offset: 0xc, size: 4, type: INT4 },
        ],
      },
    ]);
    const res = await pinpointField({ goal: parseGoal(c.query), fields, limit: 400 });
    assert.ok(res.candidates.some(keyOf(c.cls, c.truth)),
      `${c.query}: the token-boundary truth ${c.truth} must be a candidate`);
    assert.ok(!res.candidates.some(keyOf(c.cls, c.decoy)),
      `${c.query}: ${c.decoy} must not match ${c.truth} by substring`);
  }
});

test('PINPOINT recall: existing avoid semantics still separate health from healthCheck', async () => {
  const fields = classTable([
    {
      name: 'BattleManager',
      ivars: [
        { name: '_health', offset: 0x8, size: 4, type: INT4 },
        { name: '_healthCheck', offset: 0xc, size: 4, type: INT4 },
      ],
    },
  ]);
  const res = await pinpointField({ goal: goalFromPreset('hp'), fields, limit: 400 });
  assert.ok(res.candidates.some(keyOf('BattleManager', '_health')));
  assert.ok(!res.candidates.some(keyOf('BattleManager', '_healthCheck')),
    'hp must keep avoiding healthCheck');
});

test('PINPOINT recall: vendor suppression keeps an SDK field below the game field, but an exact SDK name still resolves', async () => {
  const fields = classTable([
    {
      name: 'Wallet',
      ivars: [{ name: '_coin', offset: 0x8, size: 4, type: INT4 }],
    },
    // Three LPM classes so the prefix is learned as a high-confidence vendor.
    { name: 'LPMReward', ivars: [{ name: '_coin', offset: 0x8, size: 4, type: INT4 }] },
    { name: 'LPMAd', ivars: [] },
    { name: 'LPMWaterfall', ivars: [] },
  ]);
  const res = await pinpointField({ goal: goalFromPreset('money'), fields, limit: 400 });
  const game = res.candidates.findIndex(keyOf('Wallet', '_coin'));
  const sdk = res.candidates.findIndex(keyOf('LPMReward', '_coin'));
  assert.ok(game >= 0, 'the game field must be a candidate');
  assert.ok(sdk >= 0, 'the SDK field stays a candidate but must carry suppression');
  assert.ok(game < sdk, 'the SDK field must not outrank the game field for a game-value goal');

  // Asking for the SDK field by its exact literal name is still honoured.
  const exact = await pinpointField({ goal: parseGoal('coin'), fields, limit: 400 });
  const sdkExact = exact.candidates.findIndex(keyOf('LPMReward', '_coin'));
  assert.ok(sdkExact >= 0, 'exact literal query keeps the SDK field reachable');
});

test('PINPOINT recall: the lexical rescue lane is bounded', async () => {
  const ivars = [{ name: '_waitTime', offset: 0x8, size: 4, type: INT4 }];
  for (let i = 0; i < 200; i++) {
    ivars.push({ name: `_alpha${i}WaitTime`, offset: 0x10 + i * 4, size: 4, type: INT4 });
  }
  const fields = classTable([{ name: 'Bulk', ivars }]);
  const res = await pinpointField({ goal: parseGoal('wait time'), fields, limit: 400 });
  assert.ok(res.candidates.length <= 1 + 64,
    `rescue lane must stay bounded, got ${res.candidates.length}`);
  assert.ok(res.candidates.length > 1, 'the rescue lane must still contribute candidates');
});

test('PINPOINT recall: the recall lane adds no evidence codes and preserves verdict/confidence stability', async () => {
  const soloFields = classTable([
    {
      name: 'APMAppMetadata',
      ivars: [{ name: '_waitTime', offset: 0x8, size: 8, type: INT8 }],
    },
  ]);
  const combinedFields = classTable([
    {
      name: 'APMAppMetadata',
      ivars: [
        { name: '_waitTime', offset: 0x8, size: 8, type: INT8 },
        { name: '_totalWaitTime', offset: 0x10, size: 4, type: INT4 },
      ],
    },
  ]);
  const soloRes = await pinpointField({ goal: parseGoal('wait time'), fields: soloFields, limit: 400 });
  const combinedRes = await pinpointField({ goal: parseGoal('wait time'), fields: combinedFields, limit: 400 });

  const exact = combinedRes.candidates.find(keyOf('APMAppMetadata', '_waitTime'));
  const rescued = combinedRes.candidates.find(keyOf('APMAppMetadata', '_totalWaitTime'));
  const codes = (c) => c.evidence.map((e) => e.code).sort();
  assert.deepEqual(codes(exact), ['field-name-asked', 'sibling-fields', 'size-fits']);
  assert.deepEqual(codes(rescued), ['field-name-contains', 'sibling-fields', 'size-fits']);

  // Same candidate/evidence input under the preserved prior keeps exact candidate as top.
  assert.equal(combinedRes.priorCandidates, 1);
  assert.equal(combinedRes.top.field.name, '_waitTime');

  // Verdict and confidence stability: adding the recall lane never produces a false-strong
  // verdict (neither likely nor confirmed) without independent evidence groups.
  assert.equal(soloRes.verdict, combinedRes.verdict, 'verdict must remain stable when recall lane is appended');
  assert.equal(combinedRes.verdict, 'ambiguous');
  assert.equal(combinedRes.top.fusion.independentGroups, soloRes.top.fusion.independentGroups);
});

