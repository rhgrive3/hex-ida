import test from 'node:test';
import assert from 'node:assert/strict';

import { findings } from '../js/auto.js';
import { groupByFeature } from '../js/features.js';
import { goalFromPreset } from '../js/goals.js';
import { buildStringMap } from '../js/appmap.js';

test('anticheat signal and classifiers ignore Friday/FRIDAY while matching real Frida tokens', () => {
  const strings = [
    { addr: 0x1000n, text: 'Friday', byteLength: 6 },
    { addr: 0x1100n, text: 'NAME_DAY_OF_WEEK_FRIDAY', byteLength: 23 },
    { addr: 0x1200n, text: 'frida-server', byteLength: 12 },
    { addr: 0x1300n, text: 'checkFridaHook', byteLength: 14 },
  ];
  const program = {
    functionsReferencing() { return []; },
  };

  const hits = findings(strings, program, null, 40);
  const anticheatTexts = hits.filter((h) => h.id === 'anticheat').map((h) => h.text);
  assert.deepEqual(anticheatTexts, ['frida-server', 'checkFridaHook']);

  const grouped = groupByFeature(strings, 20);
  const featureAnticheat = grouped.find((g) => g.id === 'anticheat');
  const featureTexts = (featureAnticheat?.items || []).map((i) => i.text);
  assert.equal(featureTexts.includes('Friday'), false);
  assert.equal(featureTexts.includes('NAME_DAY_OF_WEEK_FRIDAY'), false);
  assert.equal(featureTexts.includes('frida-server'), true);

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

  const hits = findings(strings, program, symbols, 40);
  const referenced = hits.filter((h) => h.id === 'anticheat' && h.actionable);
  assert.equal(referenced.length, 1);
  assert.equal(referenced[0].text, 'ptrace_deny_attach');
  assert.equal(referenced[0].users[0].addr, 0x100500n);
});
