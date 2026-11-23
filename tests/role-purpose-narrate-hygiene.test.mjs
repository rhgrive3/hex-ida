import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION, inferRole, stringLookup } from '../js/role.js';
import { WORK, describePurpose } from '../js/purpose.js';
import {
  changeText,
  purposeText,
  fnRoleShort,
  fnRoleTargetLine,
  fnRoleSubject,
  factText,
  roleProofText,
} from '../js/narrate.js';
import { buildSemanticModel } from '../js/blocks.js';
import { findValueUpdates } from '../js/dataflow.js';
import { setLang } from '../js/i18n.js';

const BASE = 0x100000000n;

function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return {
      row: i,
      address: BASE + BigInt(i * 4),
      mn: p < 0 ? s : s.slice(0, p),
      ops: p < 0 ? '' : s.slice(p + 1),
    };
  });
  const rowOfAddress = (addr) => {
    const d = addr - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

/* ── js/role.js ─────────────────────────────────────────────────────── */

test('role: __metadataAccessor override recomputes verdict/missing/marginRatio/others consistently', () => {
  // Strong internal RMW update on another field outscores the metadata accessor,
  // yet the ObjC setter selector contract must remain top with consistent decision metadata.
  const role = inferRole({
    name: '-[Player setHp:]',
    owner: {
      className: 'Player',
      sel: 'setHp:',
      accessorField: {
        name: '_hp',
        property: { name: 'hp' },
        offset: 0x20,
        size: 4,
        declaredType: { kind: 'int', bytes: 4, signed: true },
      },
    },
    updates: [{
      kind: 'read-modify-write',
      location: { base: 'x0', disp: 0x40n, size: 4, stack: false },
      field: { className: 'Player', name: '_hpCache', plain: 'hpCache', offset: 0x40, certain: true },
      steps: [{ op: 'add', imm: 1n }],
      store: { address: BASE + 0x10n, row: 4 },
    }],
    apis: [],
    selectors: [],
    strings: [{ text: 'player hp updated' }],
    callees: [],
    callers: [],
    verified: true,
  });

  assert.equal(role.action, ACTION.SET);
  assert.equal(role.subject.plain, 'hp');
  assert.equal(role.update?.__metadataAccessor, true);
  // others must not duplicate top itself, and must include the rival RMW claim
  assert.ok(role.others.every((o) => !(o.action === role.action && o.subject?.plain === 'hp' && o.topic === role.topic)));
  assert.ok(role.others.some((o) => o.action === ACTION.INCREASE && o.subject?.plain === 'hpCache'));
  // marginRatio is recomputed relative to the overridden top (not the old RMW top)
  assert.equal(typeof role.marginRatio, 'number');
  assert.ok(Number.isFinite(role.marginRatio) || role.marginRatio === Infinity);
});

test('role: actionOfUpdate extracts primary arithmetic op before clamp/tail steps and converts shift imm to 1n << imm', () => {
  const clampedSub = inferRole({
    updates: [{
      kind: 'read-modify-write',
      location: { base: 'x0', disp: 0x20n, size: 4, stack: false },
      steps: [
        { op: 'sub', imm: 5n },
        { op: 'csel' },
      ],
      store: { address: BASE, row: 2 },
    }],
    verified: true,
  });
  assert.equal(clampedSub.action, ACTION.DECREASE);
  assert.equal(clampedSub.amount, 5n);
  assert.equal(clampedSub.op, 'sub');

  const signMaskSub = inferRole({
    updates: [{
      kind: 'read-modify-write',
      location: { base: 'x0', disp: 0x20n, size: 4, stack: false },
      steps: [
        { op: 'sub', imm: 10n },
        { op: 'asr', imm: 31n, signMaskClampPart: true },
        { op: 'bic', signMaskClamp: true },
      ],
      store: { address: BASE, row: 3 },
    }],
    verified: true,
  });
  assert.equal(signMaskSub.action, ACTION.DECREASE);
  assert.equal(signMaskSub.amount, 10n);

  const lslRole = inferRole({
    updates: [{
      kind: 'read-modify-write',
      location: { base: 'x0', disp: 0x20n, size: 4, stack: false },
      steps: [{ op: 'lsl', imm: 1n }],
      store: { address: BASE, row: 1 },
    }],
    verified: true,
  });
  assert.equal(lslRole.action, ACTION.SCALE);
  assert.equal(lslRole.amount, 2n);

  const lsrRole = inferRole({
    updates: [{
      kind: 'read-modify-write',
      location: { base: 'x0', disp: 0x20n, size: 4, stack: false },
      steps: [{ op: 'lsr', imm: 2n }],
      store: { address: BASE, row: 1 },
    }],
    verified: true,
  });
  assert.equal(lsrRole.action, ACTION.SHRINK);
  assert.equal(lsrRole.amount, 4n);

  const outOfRangeShift = inferRole({
    updates: [{
      kind: 'read-modify-write',
      location: { base: 'x0', disp: 0x20n, size: 4, stack: false },
      steps: [{ op: 'lsl', imm: 64n }],
      store: { address: BASE, row: 1 },
    }],
    verified: true,
  });
  assert.equal(outOfRangeShift.action, ACTION.SCALE);
  assert.equal(outOfRangeShift.amount, null);
});

test('role: ARM64 prologue stp stores do not misclassify storage read routines as ACTION.SAVE', () => {
  const prologueOnly = inferRole({
    apis: [{ id: 'prefs', cat: 'storage' }],
    callees: [{ name: '_NSUserDefaults' }],
    selectors: ['objectForKey:'],
    stores: 2, // e.g. stp x29, x30 + stp x19, x20 in prologue
    updates: [],
    verified: true,
  });
  assert.equal(prologueOnly.action, ACTION.LOAD);

  const noHintPrologue = inferRole({
    apis: [{ id: 'file', cat: 'io' }],
    stores: 1, // single prologue stp x29, x30, [sp, #-16]!
    updates: [],
    verified: true,
  });
  assert.equal(noHintPrologue.action, ACTION.LOAD);

  const explicitSave = inferRole({
    apis: [{ id: 'prefs', cat: 'storage' }],
    callees: [{ name: '_NSUserDefaults_setObject' }],
    stores: 0,
    updates: [],
    verified: true,
  });
  assert.equal(explicitSave.action, ACTION.SAVE);
});

test('role: topicSettled guards topic:null and ignores cross-claim rivals', () => {
  // Weak single caller clue (LR=2.6 < 4) must not settle topic against same-claim topic:null
  const weakCaller = inferRole({
    updates: [{
      kind: 'read-modify-write',
      location: { base: 'x0', disp: 0x20n, size: 4, stack: false },
      steps: [{ op: 'add', imm: 1n }],
      store: { address: BASE, row: 1 },
    }],
    callers: [{ name: '_coinRewardHandler' }],
    verified: true,
  });
  assert.equal(weakCaller.topic, 'money');
  assert.equal(weakCaller.topicSettled, false);
  assert.ok(weakCaller.missing.includes('role-topic-unsettled'));

  // When top has topic:null, topicSettled must be false and rivalTopic must be null
  const noTopic = inferRole({
    updates: [{
      kind: 'read-modify-write',
      location: { base: 'x0', disp: 0x20n, size: 4, stack: false },
      steps: [{ op: 'add', imm: 1n }],
      store: { address: BASE, row: 1 },
    }],
    verified: true,
  });
  assert.equal(noTopic.topic, null);
  assert.equal(noTopic.topicSettled, false);
  assert.equal(noTopic.rivalTopic, null);
});

test('role: accessorSpec rejects multi-argument setX:y: selectors', () => {
  const multiArg = inferRole({
    owner: {
      className: 'Player',
      sel: 'setHp:animated:',
      accessorField: { name: '_hp', property: { name: 'hp' }, offset: 0x20, size: 4 },
    },
    updates: [],
    verified: false,
  });
  assert.equal(multiArg.evidence.some((e) => e.code === 'role-accessor-metadata'), false);
  assert.notEqual(multiArg.subject?.plain, 'hp');
});

test('role: stringLookup uses UTF-8 byte length for multibyte strings', () => {
  const s = { addr: 0x1000n, text: 'コイン' }; // 3 UTF-16 chars, 9 UTF-8 bytes + 1 NUL = 10 bytes
  const lookup = stringLookup([s]);
  assert.equal(lookup(0x1000n), s);
  assert.equal(lookup(0x1005n), s); // inside UTF-8 range (would fail with UTF-16 length 3+1=4)
  assert.equal(lookup(0x1009n), s); // NUL terminator byte
  assert.equal(lookup(0x100an), null); // past NUL terminator
});

/* ── js/purpose.js ──────────────────────────────────────────────────── */

test('purpose: WORK.SHRINK separates DIV_OPS from MUL_OPS and respects last op when mixed', () => {
  assert.equal(WORK.SHRINK, 'shrink');

  const divModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'mov w9, #2',
    'sdiv w8, w8, w9',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const divP = describePurpose({ model: divModel, addr: BASE });
  assert.equal(divP.changes[0].work, WORK.SHRINK);

  const lsrModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'lsr w8, w8, #1',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const lsrP = describePurpose({ model: lsrModel, addr: BASE });
  assert.equal(lsrP.changes[0].work, WORK.SHRINK);

  // Mixed MUL_OPS and DIV_OPS: workOf follows the last matching op in amt.ops
  // (ir-ssa records steps store-to-load, so lsr-then-mul produces amt.ops=['mul','lsr'] -> SHRINK,
  //  and mul-then-lsr produces amt.ops=['lsr','mul'] -> SCALE).
  const lastDiv = modelOf([
    'ldr w8, [x0, #0x20]',
    'lsr w8, w8, #1',
    'mov w9, #3',
    'mul w8, w8, w9',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const lastDivP = describePurpose({ model: lastDiv, addr: BASE });
  assert.deepEqual(lastDivP.changes[0].ops, ['mul', 'lsr']);
  assert.equal(lastDivP.changes[0].work, WORK.SHRINK);

  const lastMul = modelOf([
    'ldr w8, [x0, #0x20]',
    'mov w9, #3',
    'mul w8, w8, w9',
    'lsr w8, w8, #1',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const lastMulP = describePurpose({ model: lastMul, addr: BASE });
  assert.deepEqual(lastMulP.changes[0].ops, ['lsr', 'mul']);
  assert.equal(lastMulP.changes[0].work, WORK.SCALE);

  // WORK.SHRINK weight equals WORK.SCALE weight (both base 40)
  assert.equal(lastDivP.changes[0].weight, lastMulP.changes[0].weight);
});

test('purpose: resolveAccess requires certain === true', () => {
  const model = modelOf([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #1',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const uncertainFields = {
    resolveAccess() {
      return { className: 'Player', name: '_hp', plain: 'hp', offset: 0x20, certain: false };
    },
  };
  const p1 = describePurpose({ model, addr: BASE, fields: uncertainFields, owner: { className: 'Player' } });
  assert.equal(p1.changes[0].field, null);

  const certainFields = {
    resolveAccess() {
      return { className: 'Player', name: '_hp', plain: 'hp', offset: 0x20, certain: true };
    },
  };
  const p2 = describePurpose({ model, addr: BASE, fields: certainFields, owner: { className: 'Player' } });
  assert.equal(p2.changes[0].field?.name, '_hp');
});

test('purpose: sourceOnLeft === false on non-commutative ops falls back to WORK.SET', () => {
  const inverted = modelOf([
    'ldr w8, [x0, #0x20]',
    'mov w9, #100',
    'sub w8, w9, w8',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const invUpdates = findValueUpdates(inverted);
  invUpdates[0].steps[0].sourceOnLeft = false;
  invUpdates[0].steps[0].sourceOperandIndex = 1;
  const pInv = describePurpose({ model: inverted, addr: BASE, updates: invUpdates });
  assert.equal(pInv.changes[0].work, WORK.SET);

  // Non-commutative sdiv with sourceOnLeft === false also falls back to WORK.SET
  const invDiv = modelOf([
    'ldr w8, [x0, #0x20]',
    'mov w9, #100',
    'sdiv w8, w9, w8',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const divUpdates = findValueUpdates(invDiv);
  divUpdates[0].steps[0].sourceOnLeft = false;
  divUpdates[0].steps[0].sourceOperandIndex = 1;
  const pDiv = describePurpose({ model: invDiv, addr: BASE, updates: divUpdates });
  assert.equal(pDiv.changes[0].work, WORK.SET);

  // Commutative add with sourceOnLeft === false stays INCREASE
  const commAdd = modelOf([
    'ldr w8, [x0, #0x20]',
    'mov w9, #100',
    'add w8, w9, w8',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const addUpdates = findValueUpdates(commAdd);
  addUpdates[0].steps[0].sourceOnLeft = false;
  addUpdates[0].steps[0].sourceOperandIndex = 1;
  const pAdd = describePurpose({ model: commAdd, addr: BASE, updates: addUpdates });
  assert.equal(pAdd.changes[0].work, WORK.INCREASE);

  // Normal sub with sourceOnLeft === true stays DECREASE
  const normal = modelOf([
    'ldr w8, [x0, #0x20]',
    'mov w9, #100',
    'sub w8, w8, w9',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const normUpdates = findValueUpdates(normal);
  normUpdates[0].steps[0].sourceOnLeft = true;
  normUpdates[0].steps[0].sourceOperandIndex = 0;
  const pNorm = describePurpose({ model: normal, addr: BASE, updates: normUpdates });
  assert.equal(pNorm.changes[0].work, WORK.DECREASE);
});

test('purpose: merge key includes amount so distinct update amounts stay separate', () => {
  const model = modelOf([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #1',
    'str w8, [x0, #0x20]',
    'ldr w9, [x0, #0x20]',
    'add w9, w9, #10',
    'str w9, [x0, #0x20]',
    'ret',
  ]);
  const p = describePurpose({ model, addr: BASE });
  const incs = p.allChanges.filter((c) => c.work === WORK.INCREASE && c.disp === 0x20n);
  assert.equal(incs.length, 2);
  const vals = incs.map((c) => String(c.amount?.value)).sort();
  assert.deepEqual(vals, ['1', '10']);
});

test('purpose: work-format filters non-format strings and work-too-big precedes weak headlines', () => {
  const fmtModel = modelOf([
    'bl #0x100000400',
    'ret',
  ]);
  fmtModel.facts.calls = 1;
  fmtModel.facts.stringRefs = [
    { text: 'OK', addr: 0x2000n, row: 0 },
    { text: '100%%done', addr: 0x2010n, row: 0 },
    { text: 'https://example.com/a%20data', addr: 0x2020n, row: 0 },
    { text: 'HP: %d', addr: 0x2040n, row: 0 },
  ];
  const fp = describePurpose({ model: fmtModel, addr: BASE });
  assert.equal(fp.formats, 1);
  assert.equal(fp.headline?.code, 'work-format');
  assert.equal(fp.headline.texts.length, 1);
  assert.equal(fp.headline.texts[0].text, 'HP: %d');

  // Huge function (>= 1200 instructions) with only a weak SET must report work-too-big
  const bigModel = modelOf([
    'mov w8, #5',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  bigModel.facts.instructionCount = 1500;
  bigModel.facts.calls = 12;
  const bp = describePurpose({ model: bigModel, addr: BASE });
  assert.equal(bp.headline?.code, 'work-too-big');
});

test('purpose: work-fill does not misfire on ObjC indexAddr ivar access inside a loop', () => {
  const model = modelOf([
    'adrp x8, #0x100008000',
    'ldrsw x8, [x8, #0x10]',
    'mov w9, #5',
    'str w9, [x0, x8]',
    'ret',
  ]);
  model.facts.loops = 1;
  const p = describePurpose({ model, addr: BASE });
  assert.notEqual(p.headline?.code, 'work-fill');
});

/* ── js/narrate.js ──────────────────────────────────────────────────── */

test('narrate: changeText formats scale/shrink naturally with safe shift 1n << BigInt(v) conversion', () => {
  const place = { disp: 0x20n, size: 4, base: 'x0' };

  assert.equal(
    changeText({ ...place, work: 'scale', amount: { kind: 'imm', value: 1, op: 'lsl' }, ops: ['lsl'] }),
    'オブジェクトの +0x20（4 バイト）を 2 倍にする',
  );
  assert.equal(
    changeText({ ...place, work: 'shrink', amount: { kind: 'imm', value: 1, op: 'lsr' }, ops: ['lsr'] }),
    'オブジェクトの +0x20（4 バイト）を 2 で割る',
  );
  assert.equal(
    changeText({ ...place, work: 'shrink', amount: { kind: 'imm', value: 3n, op: 'asr' }, ops: ['asr'] }),
    'オブジェクトの +0x20（4 バイト）を 8 で割る',
  );
  // Fallback to c.ops only when c.amount.op is unset
  assert.equal(
    changeText({ ...place, work: 'scale', amount: { kind: 'imm', value: 2 }, ops: ['lsl'] }),
    'オブジェクトの +0x20（4 バイト）を 4 倍にする',
  );
  // When c.amount.op is explicitly 'mul', do NOT shift-convert even if c.ops contains 'lsl'
  assert.equal(
    changeText({ ...place, work: 'scale', amount: { kind: 'imm', value: 3, op: 'mul' }, ops: ['lsl', 'mul'] }),
    'オブジェクトの +0x20（4 バイト）を 3 倍にする',
  );
  // Boundary 0n and 53n
  assert.match(
    changeText({ ...place, work: 'scale', amount: { kind: 'imm', value: 0n, op: 'lsl' } }),
    /1 倍にする/,
  );
  assert.match(
    changeText({ ...place, work: 'scale', amount: { kind: 'imm', value: 53n, op: 'lsl' } }),
    /9007199254740992 倍にする/,
  );
  // Non-integer and out-of-range shift immediates must safely fall back without throwing
  for (const bad of [1.5, NaN, Infinity, -1, -1n, 54, 54n, 64n, '2', Number.MAX_SAFE_INTEGER + 1]) {
    const s1 = changeText({ ...place, work: 'scale', amount: { kind: 'imm', value: bad, op: 'lsl' } });
    assert.equal(s1, 'オブジェクトの +0x20（4 バイト）に倍率を掛ける');
    const s2 = changeText({ ...place, work: 'shrink', amount: { kind: 'imm', value: bad, op: 'lsr' } });
    assert.equal(s2, 'オブジェクトの +0x20（4 バイト）を割り算で減らす');
  }
  // clear & two-sided clamp
  assert.equal(
    changeText({ ...place, work: 'clear', amount: { kind: 'imm', value: 0n } }),
    'オブジェクトの +0x20（4 バイト）を 0 にする',
  );
  const clampedBoth = changeText({
    ...place,
    work: 'decrease',
    amount: { kind: 'imm', value: 5 },
    cappedBy: { disp: 0x24n },
    clamped: true,
  });
  assert.match(clampedBoth, /上限は \+0x24 の値/);
  assert.match(clampedBoth, /下限で止める/);
});

test('narrate: fnRoleShort respects topicSettled === false, fnRoleTargetLine handles get, factText handles read, purposeText naturalizes work-format', () => {
  const unsettled = fnRoleShort({
    action: 'increase',
    amount: 1n,
    topic: 'item',
    topicSettled: false,
    subject: { kind: 'field', name: '_count', plain: 'count', className: 'Bag' },
  });
  assert.doesNotMatch(unsettled, /アイテム/);
  assert.match(unsettled, /count/);
  assert.match(unsettled, /\+1/);

  const getTarget = fnRoleTargetLine({
    action: 'get',
    subject: { kind: 'field', name: '_hp', plain: 'hp', className: 'Player', disp: 0x20n },
  });
  assert.match(getTarget, /^読み出しているのは/);
  assert.doesNotMatch(getTarget, /変えているのは/);

  const readFact = factText({
    code: 'value-update',
    detail: { kind: 'read', base: 'x0', disp: 0x20n },
  });
  assert.match(readFact, /読み出している/);
  assert.doesNotMatch(readFact, /書き込んでいる/);

  const singleFmt = purposeText({
    headline: { code: 'work-format', n: 1, texts: [{ text: 'HP: %d' }] },
  });
  assert.match(singleFmt, /「HP: %d」/);
  assert.doesNotMatch(singleFmt, /など 1 本/);

  const multiFmt = purposeText({
    headline: { code: 'work-format', n: 3, texts: [{ text: 'HP: %d' }] },
  });
  assert.match(multiFmt, /「HP: %d」など 3 本/);

  setLang('en');
  try {
    assert.match(fnRoleTargetLine({
      action: 'get',
      subject: { kind: 'field', name: '_hp', plain: 'hp', className: 'Player', disp: 0x20n },
    }), /^What it reads is/);
    assert.match(factText({
      code: 'value-update',
      detail: { kind: 'read', base: 'x0', disp: 0x20n },
    }), /reads a value from/);
    assert.match(purposeText({
      headline: { code: 'work-format', n: 1, texts: [{ text: 'HP: %d' }] },
    }), /1 format string\b/);
  } finally {
    setLang('ja');
  }
});

test('narrate: null/undefined guards prevent literal null/undefined leakage', () => {
  const outputs = [
    roleProofText({ code: 'role-verb-api', detail: { api: 'unknown_api_id' } }),
    factText({ code: 'compare-const', detail: {} }),
    factText({ code: 'selector', detail: {} }),
    factText({ code: 'instructions', detail: {} }),
    factText({ code: 'calls', detail: {} }),
    factText({ code: 'memory', detail: {} }),
    fnRoleSubject({ subject: { kind: 'location', disp: null } }),
    changeText({ work: 'set', disp: null, amount: { kind: 'imm', value: null } }),
    purposeText({ headline: { code: 'work-too-big', n: null, calls: null } }),
  ];
  for (const out of outputs) {
    assert.equal(typeof out, 'string');
    assert.doesNotMatch(out, /\bnull\b|\bundefined\b/);
  }
});
