import assert from 'node:assert/strict';
import test from 'node:test';

import { autoAnalyze } from '../../js/auto.js';
import { KnowledgeDB } from '../../js/knowledge/index.js';
import { LRU } from '../../js/lru.js';
import { StringCollectionBudget } from '../../js/string-budget.js';

/**
 * Numeric coverage/capacity boundaries must be strict primitive integers.
 * Relational/ToNumber coercion previously let Infinity uncap limits and
 * strings/booleans/fractions define arbitrary counts (#5285, #5288, #5335,
 * #5361, #5363).
 */

function analysisFixture() {
  const count = 20;
  const funcs = Array.from({ length: count }, (_, index) => ({ addr: 0x3000n + BigInt(index * 0x100), name: `fn${index}` }));
  const symbols = {
    functionCount: count, funcs, functionList: () => funcs,
    nameAt: () => null, symbolCount: 0, addrs: [], names: [],
  };
  const program = {
    callCount: 1, refCount: 1,
    functionsReferencing: (addr) => [{ addr: BigInt(addr) + 0x1000n, site: addr, kind: 'call', users: 1, complete: true }],
    functionRange: (addr) => ({ start: addr, end: addr + 0x100n }),
    statsOf: () => ({ total: 10, numeric: 5, mul: 1, div: 0, fmul: 0, farith: 0, store: 1, load: 1, cmp: 3, covered: true }),
    callCountOf: () => 3, calleesOf: () => [], callersOf: () => [],
  };
  const strings = ['a', 'b', 'c', 'd', 'e', 'f'].map((s, index) => ({ text: `https://${s}.example/${index}`, addr: 0x1000n + BigInt(index * 0x10) }));
  return { strings, program, symbols };
}

async function deepCount(deepLimit) {
  const { strings, program, symbols } = analysisFixture();
  const report = await autoAnalyze({ strings, program, symbols, analyze: async () => ({}), deepLimit });
  return report.deep.length;
}

test('#5285/#5288 deepLimit honors explicit integer counts and zero', async () => {
  assert.equal(await deepCount(undefined), 12, 'unspecified keeps the default');
  assert.equal(await deepCount(0), 0, 'explicit zero disables deep analysis');
  assert.equal(await deepCount(2), 2);
});

test('#5285/#5288 deepLimit rejects non-integer counts instead of coercing', async () => {
  // 14 targets are available, so the default cap of 12 is observable.
  assert.equal(await deepCount(Infinity), 12, 'Infinity must not uncap the target list');
  assert.equal(await deepCount(true), 12, 'booleans must not define counts');
  assert.equal(await deepCount('2'), 12, 'numeric strings must not define counts');
  assert.equal(await deepCount([2]), 12, 'arrays must not define counts');
  assert.equal(await deepCount(1.5), 12, 'fractions must not define counts');
});

test('#5335 KnowledgeDB.page integerizes fractional limits', async () => {
  const db = new KnowledgeDB({
    indexedDB: null,
    memory: new Map([['a', { id: 'a' }], ['b', { id: 'b' }], ['c', { id: 'c' }]]),
    negativeMemory: new Map(),
  });
  const first = await db.page({ limit: 1.5 });
  assert.equal(first.records.length, 1);
  assert.equal(first.nextCursor, 'a', 'remaining records must stay reachable');
  const second = await db.page({ limit: 1.5, after: first.nextCursor });
  assert.equal(second.records.length, 1);
  assert.equal(second.nextCursor, 'b');
});

test('#5361 StringCollectionBudget honors an explicit zero result limit', () => {
  const budget = new StringCollectionBudget({ inputBytes: 1024, resultLimit: 0, estimatedHeapBytes: 1024 });
  assert.equal(budget.requestLimit(), 0);
  assert.equal(budget.accept('x'), false);
  assert.equal(budget.results, 0);
  const normal = new StringCollectionBudget({ inputBytes: 1024, resultLimit: 2, estimatedHeapBytes: 1024 });
  assert.equal(normal.accept('x'), true);
});

test('#5363 LRU accepts only primitive non-negative safe integers', () => {
  assert.equal(new LRU(0).limit, 0);
  assert.equal(new LRU(64).limit, 64);
  for (const bad of [1.9, '2', ['3'], true, NaN, Infinity, -1, null, undefined, {}]) {
    assert.throws(() => new LRU(bad), RangeError, `${String(bad)} must be rejected`);
  }
});
