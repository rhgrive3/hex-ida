import test from 'node:test';
import assert from 'node:assert/strict';

import { findings, notableFunctions } from '../js/auto.js';
import { groupByFeature } from '../js/features.js';
import { goalFromPreset, matchName } from '../js/goals.js';
import { buildStringMap } from '../js/appmap.js';

test('anticheat signal and classifiers ignore Friday/FRIDAY while matching real Frida and cheat tokens', () => {
  const strings = [
    { addr: 0x1000n, text: 'Friday', byteLength: 6 },
    { addr: 0x1100n, text: 'NAME_DAY_OF_WEEK_FRIDAY', byteLength: 23 },
    { addr: 0x1200n, text: 'frida-server', byteLength: 12 },
    { addr: 0x1300n, text: 'checkFridaHook', byteLength: 14 },
    { addr: 0x1400n, text: 'CheatCheckValue', byteLength: 15 },
  ];
  const program = {
    functionsReferencing() { return []; },
  };

  const hits = findings(strings, program, null, 50);
  const anticheatTexts = hits.filter((h) => h.id === 'anticheat').map((h) => h.text);
  assert.deepEqual(anticheatTexts, ['frida-server', 'checkFridaHook', 'CheatCheckValue']);

  const grouped = groupByFeature(strings, 20);
  const featureAnticheat = grouped.find((g) => g.id === 'anticheat');
  const featureTexts = (featureAnticheat?.items || []).map((i) => i.text);
  assert.equal(featureTexts.includes('Friday'), false);
  assert.equal(featureTexts.includes('NAME_DAY_OF_WEEK_FRIDAY'), false);
  assert.equal(featureTexts.includes('frida-server'), true);
  assert.equal(featureTexts.includes('CheatCheckValue'), true);

  const smap = buildStringMap({
    strings,
    program: {
      functionsReferencing() { return [{ addr: 0x100100n, site: 0x100104n }]; },
    },
  });
  const anticheatSub = smap.subsystems.find((sub) => sub.id === 'anticheat');
  const samples = (anticheatSub?.functions || []).flatMap((f) => f.samples || []);
  assert.equal(samples.some((t) => /Friday/i.test(t)), false);
  assert.equal(samples.includes('frida-server'), true);

  const goal = goalFromPreset('anticheat');
  assert.ok(goal);
  assert.equal(goal.strong.some((re) => re.test('Friday')), false);
  assert.equal(goal.strong.some((re) => re.test('frida-server')), true);
});

test('findings() prioritizes referenced (actionable) matches even after sig.max unreferenced matches', () => {
  const strings = [];
  for (let i = 0; i < 12; i++) {
    strings.push({ addr: BigInt(0x2000 + i * 0x20), text: `isDebuggerAttached_${i}`, byteLength: 21 });
  }
  strings.push({ addr: 0x4000n, text: 'ptrace_deny_attach', byteLength: 18 });

  const program = {
    functionsReferencing(addr) {
      if (addr === 0x4000n) {
        return [{ addr: 0x100500n, site: 0x100514n }];
      }
      return [];
    },
  };
  const symbols = {
    nameAt(addr) {
      return addr === 0x100500n ? 'sub_100500' : null;
    },
  };

  const hits = findings(strings, program, symbols, 50);
  const referenced = hits.filter((h) => h.id === 'anticheat' && h.actionable);
  assert.equal(referenced.length, 1);
  assert.equal(referenced[0].text, 'ptrace_deny_attach');
  assert.equal(referenced[0].users[0].addr, 0x100500n);
});

test('findings() deduplicates identical text per signal while merging and promoting users', () => {
  const strings = [
    { addr: 0x1000n, text: 'https://api.example.com/v1/check', byteLength: 32 },
    { addr: 0x1100n, text: 'https://api.example.com/v1/check', byteLength: 32 },
    { addr: 0x1200n, text: 'https://api.example.com/v2/other', byteLength: 32 },
  ];
  const program = {
    functionsReferencing(addr) {
      if (addr === 0x1100n) return [{ addr: 0x200000n, site: 0x200010n }];
      return [];
    },
  };

  const hits = findings(strings, program, null, 50);
  const endpoints = hits.filter((h) => h.id === 'endpoint');
  assert.equal(endpoints.length, 2);
  const checkHit = endpoints.find((h) => h.text === 'https://api.example.com/v1/check');
  assert.equal(checkHit.actionable, true);
  assert.equal(checkHit.status, 'referenced');
  assert.equal(checkHit.users.length, 1);
  assert.equal(checkHit.users[0].addr, 0x200000n);
});

test('findings() sorts actionable entries across all signals before slicing by limit', () => {
  const strings = [];
  for (let i = 0; i < 12; i++) {
    strings.push({ addr: BigInt(0x1000 + i * 0x40), text: `https://unreferenced${i}.example.com`, byteLength: 34 });
  }
  strings.push({ addr: 0x9000n, text: '/Users/dev/secret/build.cpp', byteLength: 27 });
  const program = {
    functionsReferencing(addr) {
      return addr === 0x9000n ? [{ addr: 0x300000n, site: 0x300010n }] : [];
    },
  };

  const hits = findings(strings, program, null, 8);
  assert.equal(hits.length, 8);
  assert.equal(hits[0].id, 'path');
  assert.equal(hits[0].actionable, true);
});

test('features.js save category ignores UI progress indicators while keeping save progress', () => {
  const strings = [
    { addr: 0x1000n, text: 'void FlashMotion::Node::showProgressBar(float, bool)', byteLength: 52 },
    { addr: 0x1100n, text: 'Initialization in progress.', byteLength: 27 },
    { addr: 0x1200n, text: 'progress\\meter\\layer_1', byteLength: 22 },
    { addr: 0x1300n, text: 'save_player_progress', byteLength: 20 },
  ];
  const grouped = groupByFeature(strings, 20);
  const saveTexts = (grouped.find((g) => g.id === 'save')?.items || []).map((i) => i.text);
  assert.deepEqual(saveTexts, ['save_player_progress']);
});

test('notableFunctions() falls back to next function boundary when range.end is null (Mach-O LC_FUNCTION_STARTS)', () => {
  const region = { vmAddr: 0x100000n, size: 0x1000n };
  const symbols = {
    functionCount: 2,
    funcs: [0x100000n, 0x100200n],
    functionList() {
      return [
        { addr: 0x100000n, name: null, size: null },
        { addr: 0x100200n, name: null, size: null },
      ];
    },
    _containmentBound(idx) {
      return idx === 0 ? 0x100200n : 0x101000n;
    },
  };
  const program = {
    functionRange(addr) {
      return { start: addr, end: null, region };
    },
    statsOf(start, end) {
      if (start === 0x100000n && end === 0x100200n) {
        return { total: 40, numeric: 4, store: 3, load: 4, cmp: 3 };
      }
      return { total: 4, numeric: 0, store: 0, load: 0, cmp: 0 };
    },
    callCountOf(addr) {
      return addr === 0x100000n ? 5 : 0;
    },
  };

  const notable = notableFunctions(program, symbols, region, 12);
  assert.equal(notable.length, 1);
  assert.equal(notable[0].addr, 0x100000n);
  assert.equal(notable[0].range.end, 0x100200n);
  assert.ok(notable[0].score > 6);
});

test('goals.js avoid rules and matchName() suppress ad-SDK false positives without suppressing real game methods', () => {
  const gacha = goalFromPreset('gacha');
  const level = goalFromPreset('level');
  const item = goalFromPreset('item');

  assert.equal(matchName(gacha, '-[MarketingAdUnit updateDraw]'), null);
  assert.equal(matchName(gacha, '-[MarketingAdProviderManager updateDraw:rect:]'), null);
  assert.equal(matchName(level, '-[MarketingAdError setLevel:]'), null);
  assert.equal(matchName(item, '-[AdUserStatus setInventoryId:]'), null);
  assert.equal(matchName(item, '-[AdUnitMeta setInventoryType:]'), null);

  assert.notEqual(matchName(gacha, '-[GachaManager updateDraw]'), null);
  assert.notEqual(matchName(level, '-[Player setLevel:]'), null);
  assert.notEqual(matchName(item, '-[InventoryManager setInventoryId:]'), null);
  assert.equal(item.avoid.some((re) => re.test('-[ItemInventory setInventoryType:]')), false);
});
