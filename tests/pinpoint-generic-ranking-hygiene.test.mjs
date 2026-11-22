import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseGoal, goalFromPreset, matchText, typeFits,
  extractCallableLeaf, numericSymbolRole, isDiagnosticString,
} from '../js/goals.js';
import { exclusiveLR, VERDICT } from '../js/evidence.js';
import { rankCandidates } from '../js/rank.js';
import { pinpointField, pinpointFunction } from '../js/pinpoint.js';

test('typeFits rejects C99 bool (kind="bool") for numeric goals', () => {
  const atk = parseGoal('攻撃力');
  const hp = goalFromPreset('hp');
  assert.equal(typeFits(atk, { kind: 'bool', bytes: 1, enc: 'B' }), 'conflict');
  assert.equal(typeFits(hp, { kind: 'bool', bytes: 1, enc: 'B' }), 'conflict');
  assert.equal(typeFits(atk, { kind: 'int', bytes: 4 }), 'fit');
  assert.equal(typeFits(atk, { kind: 'float', bytes: 4 }), 'fit');
});

test('matchText respects token boundaries for short ASCII extraTerms', () => {
  const atk = parseGoal('攻撃力');
  // "atK" inside GameChatKeyboardHandler must never match "atk"
  assert.equal(matchText(atk, 'GameChatKeyboardHandler'), null);
  assert.equal(matchText(atk, 'catkeeper'), null);
  // Real token-bounded occurrences still match
  assert.ok(matchText(atk, 'getAtk'));
  assert.ok(matchText(atk, 'm_atk_value'));
  assert.ok(matchText(atk, 'ATK_UP'));
  assert.ok(matchText(atk, 'getAttackPower'));
  assert.ok(matchText(atk, '攻撃力アップ:%d'));
});

test('extractCallableLeaf and numericSymbolRole separate value calculators from predicates/UI', () => {
  assert.deepEqual(extractCallableLeaf('__ZNK4VCMI16DamageCalculator16getAttackFactorsEv'), {
    leaf: 'getAttackFactors',
    owner: 'DamageCalculator',
    isConst: true,
    isCtorOrDtor: false,
  });
  assert.deepEqual(extractCallableLeaf('-[BattleUnit getAttack]'), {
    leaf: 'getAttack',
    owner: 'BattleUnit',
    isConst: false,
    isCtorOrDtor: false,
  });
  assert.deepEqual(extractCallableLeaf('__ZN20MeleeAttackAnimationC2Ev'), {
    leaf: 'MeleeAttackAnimation',
    owner: null,
    isConst: false,
    isCtorOrDtor: true,
  });

  const atk = parseGoal('攻撃力');
  assert.equal(numericSymbolRole(atk, '__ZNK4VCMI14AFactionMember9getAttackEb'), 'value');
  assert.equal(numericSymbolRole(atk, '__ZNK4VCMI9CCreature13getBaseAttackEv'), 'value');
  assert.equal(numericSymbolRole(atk, '__ZNK4VCMI16DamageCalculator16getAttackFactorsEv'), 'value');
  assert.equal(numericSymbolRole(atk, '__ZNK4VCMI19CBattleInfoCallback18isLongWeaponAttackEPKNS_6battle4UnitES4_'), 'non-value');
  assert.equal(numericSymbolRole(atk, '__ZNK4VCMI19CBattleInfoCallback18battleCanAttackHexEv'), 'non-value');
  assert.equal(numericSymbolRole(atk, '__ZL12formatAttackEv'), 'non-value');
  assert.equal(numericSymbolRole(atk, '__ZN20MeleeAttackAnimationC2Ev'), 'non-value');

  // If user explicitly queries "attack animation", animation is not penalized
  const animGoal = parseGoal('attack animation');
  assert.notEqual(numericSymbolRole(animGoal, '__ZN20MeleeAttackAnimation4playEv'), 'non-value');
});

test('exclusiveLR filters array-indexed identifiers, bare code identifiers, and English error logs while keeping formulas', () => {
  assert.equal(exclusiveLR(50000, 1, 1, 'cdef_y_pri_strength[i]'), 0);
  assert.equal(exclusiveLR(50000, 1, 1, 'battleCanAttackHex'), 0);
  assert.equal(exclusiveLR(50000, 1, 1, 'vcmi.battle.action.attack'), 0);
  assert.equal(exclusiveLR(50000, 1, 1, 'Undefined attacker in isLongWeaponAttack!'), 0);
  assert.equal(exclusiveLR(50000, 1, 1, 'Error: cannot find a hex to attack hex %d from!'), 0);
  assert.equal(isDiagnosticString('cdef_y_pri_strength[i]'), true);
  assert.equal(isDiagnosticString('Error: invalid attack target'), true);
  // Real display/formula strings keep full exclusiveLR
  assert.ok(exclusiveLR(1000, 1, 1, 'damage %d') > 1);
  assert.ok(exclusiveLR(10000, 1, 1, '攻撃力アップ:%d 基ダ×(100+%d)÷100') > 100);
  assert.equal(isDiagnosticString('攻撃力アップ:%d 基ダ×(100+%d)÷100'), false);
});

test('rankCandidates + pinpointFunction rank real value getters above error-logging predicates and never confirm on untargeted stores', async () => {
  const goal = parseGoal('攻撃力');
  const addrs = [0x1000n, 0x2000n, 0x3000n];
  const names = [
    '__ZNK4Game19CBattleInfoCallback18isLongWeaponAttackEv',
    '__ZNK4Game9CCreature13getBaseAttackEv',
    '_cbs_av1_read_cdef_params',
  ];
  const symbols = {
    symbolCount: addrs.length,
    functionCount: 20000,
    addrs,
    names,
    nameAt: (a) => {
      const i = addrs.indexOf(a);
      return i >= 0 ? names[i] : null;
    },
    isFunctionStart: (a) => addrs.includes(a),
  };
  const strings = [
    { addr: 0x9000n, text: 'Undefined attacker in isLongWeaponAttack!' },
    { addr: 0x9100n, text: 'isLongWeaponAttack' },
    { addr: 0x9200n, text: 'cdef_y_pri_strength[i]' },
    { addr: 0x9300n, text: 'cdef_y_sec_strength[i]' },
  ];
  const refMap = new Map([
    [0x9000n, [{ addr: 0x1000n, site: 0x1010n, kind: 0 }]],
    [0x9100n, [{ addr: 0x1000n, site: 0x1014n, kind: 0 }]],
    [0x9200n, [{ addr: 0x3000n, site: 0x3010n, kind: 0 }]],
    [0x9300n, [{ addr: 0x3000n, site: 0x3014n, kind: 0 }]],
  ]);
  const program = {
    functionsReferencing: (addr) => {
      const u = refMap.get(addr) || [];
      u.complete = true;
      return u;
    },
    functionRange: (a) => ({ start: a, end: a + 0x40n }),
    calleesOf: () => [],
    callersOf: () => [],
    statsOf: () => ({ total: 10, numeric: 1, store: 1, cmp: 0, mul: 1, div: 0, fmul: 0, farith: 0, covered: true }),
    callCountOf: () => 2,
    callsCapped: false,
  };

  const rk = rankCandidates({ goal, strings, program, symbols, limit: 10 });
  assert.equal(rk.candidates[0].addr, 0x2000n, 'getBaseAttack should rank #1 ahead of logging predicate and AV1 decoder');

  const analyze = async (addr) => ({
    instructions: [
      { mnemonic: 'str', ops: [], memory: { kind: 'store', stack: false, base: 'x0', offset: 8 } },
      { mnemonic: 'mul', ops: [] },
      { mnemonic: 'ret', ops: [] },
    ],
  });
  const pf = await pinpointFunction({
    goal, ranked: rk.candidates, program, symbols, strings, analyze, limit: 10,
  });
  assert.equal(pf.candidates[0].addr, 0x2000n, 'pinpointFunction should keep getBaseAttack #1');
  assert.notEqual(pf.verdict, VERDICT.CONFIRMED, 'untargeted generic store must not fabricate confirmed verdict');
  assert.ok(!pf.candidates[0].evidence.some((e) => e.code === 'fn-writes-field'),
    'untargeted store must emit non-verified fn-store-observed, not verified fn-writes-field');
});

test('pinpointField does not false-positive on bool flag in class matching "atk" across CamelCase', async () => {
  const goal = parseGoal('攻撃力');
  const cls = {
    name: 'GameChatKeyboardHandler',
    instanceSize: 9,
    superName: null,
    ivars: [{
      name: '_wasChatMessageSent',
      offset: 8,
      size: 1,
      type: { kind: 'bool', bytes: 1, enc: 'B' },
      property: { name: 'wasChatMessageSent', type: { kind: 'bool', bytes: 1, enc: 'B' } },
    }],
    methods: [],
  };
  const fields = {
    classes: new Map([[cls.name, cls]]),
    classCount: 1,
    fieldCount: 1,
    classInfo: (n) => (n === cls.name ? cls : null),
    ownerOf: () => null,
    ownersOf: () => [],
  };
  const res = await pinpointField({ goal, fields, limit: 10 });
  assert.equal(res.candidates.length, 0);
  assert.equal(res.verdict, VERDICT.NONE);
});
