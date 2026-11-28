import test from 'node:test';
import assert from 'node:assert/strict';
import { findEntryPaths, entryKindOf } from '../js/analysis/entry-paths.js';

function program(edges, { incomplete = false } = {}) {
  // edges: [caller, callee]
  return {
    callersOf(target, limit) {
      const out = edges.filter(([, to]) => to === target).slice(0, limit).map(([from]) => ({ addr: from }));
      if (incomplete) out.complete = false;
      return out;
    },
  };
}
const names = new Map([
  [0x100n, '-[AppDelegate application:didFinishLaunchingWithOptions:]'],
  [0x200n, '-[ShopViewController viewDidLoad]'],
  [0x300n, 'sub_300'],
  [0x400n, 'sub_400'],
  [0x500n, 'sub_500'],
  [0x600n, '-[GameScene touchesBegan:withEvent:]'],
]);
const nameOf = (a) => names.get(a) || null;

test('entry kinds are recognised by name only', () => {
  assert.equal(entryKindOf('-[GameScene touchesBegan:withEvent:]').kind, 'touch');
  assert.equal(entryKindOf('_main').kind, 'launch');
  assert.equal(entryKindOf('-[X viewDidLoad]').kind, 'screen');
  assert.equal(entryKindOf('sub_1000'), null);
  assert.equal(entryKindOf('updateScore'), null);
});

test('shortest chains from entries are returned, entry first', () => {
  const p = program([[0x200n, 0x300n], [0x300n, 0x400n], [0x100n, 0x500n], [0x500n, 0x300n], [0x600n, 0x400n]]);
  const r = findEntryPaths(p, nameOf, 0x400n);
  assert.equal(r.complete, true);
  assert.deepEqual(r.paths.map((x) => [x.kind, x.nodes]), [
    ['touch', [0x600n, 0x400n]],
    ['screen', [0x200n, 0x300n, 0x400n]],
    ['launch', [0x100n, 0x500n, 0x300n, 0x400n]],
  ]);
});

test('without entries, chains end at functions that have no direct caller', () => {
  const r = findEntryPaths(program([[0x300n, 0x400n], [0x500n, 0x300n]]), nameOf, 0x400n);
  assert.deepEqual(r.paths, [{ kind: 'root', ja: '呼び出し元なし', en: 'No direct caller', nodes: [0x500n, 0x300n, 0x400n] }]);
});

test('cycles terminate and budgets mark the search partial', () => {
  const cyc = program([[0x300n, 0x400n], [0x400n, 0x300n]]);
  assert.deepEqual(findEntryPaths(cyc, nameOf, 0x400n).paths, []);
  const chain = [];
  for (let i = 0; i < 20; i++) chain.push([BigInt(0x1000 + i + 1), BigInt(0x1000 + i)]);
  const deep = findEntryPaths(program(chain), () => null, 0x1000n, { maxDepth: 5 });
  assert.equal(deep.complete, false);
  assert.equal(findEntryPaths(program([[0x200n, 0x400n]], { incomplete: true }), nameOf, 0x400n).complete, false);
});
