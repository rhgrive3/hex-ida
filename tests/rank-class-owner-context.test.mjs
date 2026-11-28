import assert from 'node:assert/strict';
import test from 'node:test';

import { goalFromPreset, parseGoal } from '../js/goals.js';
import { rankCandidates, REASON, reasonKind, breakdown } from '../js/rank.js';

function makeProgram(overrides = {}) {
  return {
    callsCapped: false,
    functionsReferencing: () => {
      const arr = [];
      arr.complete = true;
      return arr;
    },
    functionRange: (addr) => ({ start: addr, end: addr + 0x40n }),
    calleesOf: () => [],
    callersOf: () => [],
    statsOf: () => ({ total: 10, numeric: 0, store: 0, cmp: 0, mul: 0, div: 0, fmul: 0, farith: 0, covered: true }),
    callCountOf: () => 0,
    ...overrides,
  };
}

test('REASON.CLASS_OWNER is exported with fact reasonKind', () => {
  assert.equal(REASON.CLASS_OWNER, 'class-owner');
  assert.equal(reasonKind(REASON.CLASS_OWNER), 'fact');
});

test('omitting classOwners or passing null returns 100% identical results to baseline', () => {
  const goal = goalFromPreset('money');
  const strings = [
    { addr: 0x1000n, text: 'coin_balance_updated' },
    { addr: 0x1040n, text: 'player_gold_count' },
  ];
  const program = makeProgram({
    functionsReferencing: (addr) => {
      const arr = addr === 0x1000n ? [{ addr: 0x2000n, site: 0x2008n, kind: 'adrp' }] : [];
      arr.complete = true;
      return arr;
    },
  });
  const symbols = {
    symbolCount: 1,
    functionCount: 1,
    addrs: [0x3000n],
    names: ['Wallet::addGold'],
    isFunctionStart: () => true,
    nameAt: (a) => (a === 0x3000n ? 'Wallet::addGold' : null),
  };

  const baseline = rankCandidates({ goal, strings, program, symbols });
  const withNull = rankCandidates({ goal, strings, program, symbols, classOwners: null });
  const withEmpty = rankCandidates({ goal, strings, program, symbols, classOwners: new Map() });

  assert.deepEqual(withNull, baseline);
  assert.deepEqual(withEmpty, baseline);
  assert.equal('classOwner' in baseline.candidates[0], false);
  assert.equal('sharedOwners' in baseline.candidates[0], false);
});

test('classOwners accepts Map<bigint>, Map<string>, and hex-key Record and preserves BigInt precision', () => {
  const goal = goalFromPreset('money');
  const highAddr = 0x1000000001001a5384n;
  const link = {
    fnVa: highAddr,
    primaryOwner: 'Game::System::Coin::Abstruct',
    primaryRttiVa: 0x100500000n,
    slotIndex: 9,
    isShared: false,
    sharedOwners: [],
  };

  const fromBigIntMap = rankCandidates({
    goal,
    strings: [],
    program: null,
    symbols: null,
    classOwners: new Map([[highAddr, link]]),
  });

  const fromHexMap = rankCandidates({
    goal,
    strings: [],
    program: null,
    symbols: null,
    classOwners: new Map([[`0x${highAddr.toString(16)}`, link]]),
  });

  const fromRecord = rankCandidates({
    goal,
    strings: [],
    program: null,
    symbols: null,
    classOwners: {
      [`0x${highAddr.toString(16)}`]: link,
      'invalid-key': { primaryOwner: 'Game::Coin::Invalid' },
      '-1': { primaryOwner: 'Game::Coin::Negative' },
    },
  });

  for (const res of [fromBigIntMap, fromHexMap, fromRecord]) {
    assert.equal(res.candidates.length, 1);
    const c = res.candidates[0];
    assert.equal(c.addr, highAddr);
    assert.equal(c.classOwner, 'Game::System::Coin::Abstruct');
    const r = c.reasons.find((x) => x.code === REASON.CLASS_OWNER);
    assert.ok(r, 'must emit REASON.CLASS_OWNER');
    assert.equal(r.kind, 'fact');
    assert.ok(r.points > 0);
    assert.equal(r.detail.owner, 'Game::System::Coin::Abstruct');
    assert.equal(r.detail.slotIndex, 9);
    assert.equal(r.detail.matchKind, 'primary');
    const bd = breakdown(c);
    assert.ok(bd.some((x) => x.code === REASON.CLASS_OWNER && x.points > 0));
  }
});

test('sharedOwners matches when primaryOwner is null and ranks below dedicated primaryOwner', () => {
  const goal = goalFromPreset('money');
  const classOwners = new Map([
    [0x1001a5384n, {
      fnVa: 0x1001a5384n,
      primaryOwner: 'Game::System::Coin::Abstruct',
      slotIndex: 9,
      isShared: false,
      sharedOwners: [],
    }],
    [0x1001a5400n, {
      fnVa: 0x1001a5400n,
      primaryOwner: null,
      slotIndex: 2,
      isShared: true,
      sharedOwners: ['Game::System::Coin::SharedBase', 'Game::System::Inventory::Base'],
    }],
  ]);

  const res = rankCandidates({ goal, strings: [], program: null, symbols: null, classOwners });
  assert.equal(res.candidates.length, 2);
  assert.equal(res.candidates[0].addr, 0x1001a5384n, 'primaryOwner match must rank above sharedOwners match');
  assert.equal(res.candidates[1].addr, 0x1001a5400n);
  const sharedReason = res.candidates[1].reasons.find((r) => r.code === REASON.CLASS_OWNER);
  assert.ok(sharedReason);
  assert.equal(sharedReason.detail.matchKind, 'shared');
  assert.equal(sharedReason.detail.isShared, true);
  assert.ok(res.candidates[0].score > res.candidates[1].score);
});

test('ad SDK / vendor classes in classOwners receive vendor penalty and suppress false positives', () => {
  const goal = goalFromPreset('money');
  const strings = [
    { addr: 0x5000n, text: 'coin_reward_amount' },
    { addr: 0x5040n, text: 'gold_currency_balance' },
    { addr: 0x5080n, text: 'wallet_coin_add' },
  ];
  const program = makeProgram({
    functionsReferencing: (addr) => {
      const arr = (addr === 0x5000n || addr === 0x5040n || addr === 0x5080n)
        ? [
            { addr: 0x100100000n, site: 0x100100008n, kind: 'adrp' },
            { addr: 0x100200000n, site: 0x100200008n, kind: 'adrp' },
          ]
        : [];
      arr.complete = true;
      return arr;
    },
  });

  const classOwners = new Map([
    [0x100100000n, {
      fnVa: 0x100100000n,
      primaryOwner: 'AppLovin::CoinRewardManager',
      slotIndex: 4,
      isShared: false,
      sharedOwners: [],
    }],
    [0x100200000n, {
      fnVa: 0x100200000n,
      primaryOwner: 'Game::System::Coin::Abstruct',
      slotIndex: 9,
      isShared: false,
      sharedOwners: [],
    }],
  ]);

  const res = rankCandidates({ goal, strings, program, symbols: null, classOwners });
  assert.ok(res.candidates.length >= 1);
  assert.equal(res.candidates[0].addr, 0x100200000n, 'game class must rank #1 over AppLovin ad SDK class');
  assert.equal(res.candidates[0].vendor, undefined);

  const adCand = res.candidates.find((c) => c.addr === 0x100100000n);
  assert.ok(adCand, 'ad SDK candidate with string evidence should remain visible for vendor penalty verification');
  assert.ok(adCand.vendor, 'ad SDK candidate must carry vendor info');
  assert.equal(adCand.vendor.where, 'class-owner');
  assert.ok(adCand.reasons.some((r) => r.code === REASON.VENDOR && r.points < 0));
  assert.ok(res.candidates[0].score > adCand.score);
});

test('mixed ICF sharedOwners with a game class is not falsely vendor-penalized while all-vendor sharedOwners is penalized', () => {
  const goal = goalFromPreset('money');
  const strings = [{ addr: 0x6000n, text: 'coin_balance' }];
  const program = makeProgram({
    functionsReferencing: () => {
      const arr = [
        { addr: 0x100300000n, site: 0x100300004n, kind: 'adrp' },
        { addr: 0x100400000n, site: 0x100400004n, kind: 'adrp' },
      ];
      arr.complete = true;
      return arr;
    },
  });

  const classOwners = new Map([
    [0x100300000n, {
      fnVa: 0x100300000n,
      primaryOwner: null,
      isShared: true,
      sharedOwners: ['Game::System::Coin::Base', 'AppLovin::CoinTracker'],
    }],
    [0x100400000n, {
      fnVa: 0x100400000n,
      primaryOwner: null,
      isShared: true,
      sharedOwners: ['AppLovin::CoinTracker', 'IronSource::CoinAdapter'],
    }],
  ]);

  const res = rankCandidates({ goal, strings, program, symbols: null, classOwners });
  const mixed = res.candidates.find((c) => c.addr === 0x100300000n);
  const allVendor = res.candidates.find((c) => c.addr === 0x100400000n);

  assert.ok(mixed, 'mixed game+vendor ICF function should remain a positive candidate');
  assert.equal(mixed.reasons.some((r) => r.code === REASON.VENDOR), false);
  assert.ok(!allVendor || allVendor.reasons.some((r) => r.code === REASON.VENDOR && r.points < 0));
});

test('classOwners respects region bounds and caps >400 new candidates deterministically', () => {
  const goal = parseGoal('damage');
  const classOwners = new Map();
  for (let i = 0; i < 420; i++) {
    const addr = 0x10000n + BigInt(i * 0x10);
    classOwners.set(addr, {
      fnVa: addr,
      primaryOwner: `Game::Battle::DamageCalc${i}`,
      slotIndex: 1,
      isShared: false,
      sharedOwners: [],
    });
  }
  // Out-of-region entry
  classOwners.set(0x900000n, {
    fnVa: 0x900000n,
    primaryOwner: 'Game::Battle::DamageOutOfRegion',
    slotIndex: 0,
    isShared: false,
    sharedOwners: [],
  });

  const res = rankCandidates({
    goal,
    strings: [],
    program: null,
    symbols: null,
    region: { vmAddr: 0x10000n, size: 0x10000n },
    limit: 500,
    classOwners,
  });

  assert.equal(res.candidates.length, 400);
  assert.ok(res.notes.includes('class-owner-matches-capped'));
  assert.equal(res.candidates.some((c) => c.addr === 0x900000n), false);
});

test('rejects Array/Set classOwners safely and blocks vendor primaryOwner from sharedOwners boost bypass', () => {
  const goal = goalFromPreset('money');
  const strings = [
    { addr: 0x7000n, text: 'coin_balance_total' },
    { addr: 0x7040n, text: 'gold_currency_reward' },
    { addr: 0x7080n, text: 'wallet_coin_update' },
  ];
  const program = makeProgram({
    functionsReferencing: () => {
      const arr = [{ addr: 0x100500000n, site: 0x100500004n, kind: 'adrp' }];
      arr.complete = true;
      return arr;
    },
  });

  // Array / Set must not be treated as Record
  const fromArray = rankCandidates({ goal, strings, program, symbols: null, classOwners: [{ primaryOwner: 'Game::Coin' }] });
  const fromSet = rankCandidates({ goal, strings, program, symbols: null, classOwners: new Set(['Game::Coin']) });
  assert.equal('classOwner' in fromArray.candidates[0], false);
  assert.equal('classOwner' in fromSet.candidates[0], false);

  // Vendor primaryOwner with non-vendor sharedOwners must NOT receive shared-owner CLASS_OWNER boost
  const symbols = {
    symbolCount: 1,
    functionCount: 1,
    addrs: [0x100500000n],
    names: ['addCoinReward'],
    isFunctionStart: () => true,
    nameAt: (a) => (a === 0x100500000n ? 'addCoinReward' : null),
  };
  const res = rankCandidates({
    goal,
    strings,
    program,
    symbols,
    classOwners: new Map([[0x100500000n, {
      fnVa: 0x100500000n,
      primaryOwner: 'AppLovin::EventTracker',
      isShared: false,
      sharedOwners: ['Game::System::Coin::Manager'],
    }]]),
  });
  const cand = res.candidates.find((c) => c.addr === 0x100500000n);
  assert.ok(cand);
  assert.ok(cand.reasons.some((r) => r.code === REASON.VENDOR && r.points < 0));
  assert.equal(cand.reasons.some((r) => r.code === REASON.CLASS_OWNER), false);
});
