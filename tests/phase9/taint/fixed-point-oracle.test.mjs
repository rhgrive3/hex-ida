import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaintFlow } from '../../../js/symbolic/taint/flow.js';
import { createTaintModels } from '../../../js/symbolic/taint/models.js';
import { identity } from './fixtures.mjs';

// Independent finite-set iteration. No production lattice/join/sanitizer helper
// participates in expected results; only final observed facts are compared.
test('cyclic data/control graphs match an independent finite-set taint oracle', () => {
  let comparisons = 0;
  for (let seed = 1; seed <= 32; seed++) {
    let randomState = seed;
    const random = n => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % n; };
    const count = 20, sources = [0, 1, 2].map(n => ({ id: `s${n}`, valueId: `v${n}` }));
    const dependencies = Array.from({ length: count }, () => Array.from({ length: 3 }, () => random(count)));
    const controls = Array.from({ length: count }, () => random(count));
    const sanitizers = [5, 9].map(n => ({ id: `clean${n}`, valueId: `v${n}`, scope: 'value', removeSources: ['s0'] }));
    const models = createTaintModels({ id: `oracle${seed}`, version: '1', provenance: 'independent-finite-sets', sources, sanitizers,
      sinks: Array.from({ length: count }, (_, n) => ({ id: `sink${n}`, valueId: `v${n}` })) });
    const flow = createTaintFlow({ identity, models });
    for (let n = 0; n < count; n++) flow.value(`v${n}`, dependencies[n].map(i => `v${i}`), 'data', { control: `v${controls[n]}` });
    const expected = Array.from({ length: count }, (_, n) => new Set(n < 3 ? [`s${n}`] : []));
    let changed = true, rounds = 0;
    while (changed) {
      changed = false; assert.ok(++rounds <= 61, 'finite oracle failed to converge');
      for (let n = 0; n < count; n++) {
        const next = new Set();
        for (const input of [...dependencies[n], controls[n]]) for (const source of expected[input]) next.add(source);
        if (n === 5 || n === 9) next.delete('s0');
        if (n < 3) next.add(`s${n}`);
        for (const source of next) if (!expected[n].has(source)) { expected[n].add(source); changed = true; }
      }
    }
    const actual = flow.solve();
    for (let n = 0; n < count; n++) {
      assert.notEqual(actual.sinks[n].taint.kind, 'top', `${seed}/${n}: unexpected widening`);
      assert.deepEqual(actual.sinks[n].taint.sources ?? [], [...expected[n]].sort(), `${seed}/${n}`); comparisons++;
    }
    assert.ok(flow.metrics().updatesPerValue <= 8);
  }
  assert.equal(comparisons, 640);
  console.log(`INDEPENDENT_TAINT_ORACLE_COMPARISONS=${comparisons}`);
});
