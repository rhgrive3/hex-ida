import assert from 'node:assert/strict';
import test from 'node:test';

import { predecessorsOf, successorsOf } from '../../js/semantics/cfg/index.js';

function observedFrozenBlocks(count, counter) {
  const target = Array.from({ length: count }, (_, index) => Object.freeze({
    id: `block_${index}`,
    predecessors: Object.freeze(index > 0 ? [`block_${index - 1}`] : []),
    successors: Object.freeze(index + 1 < count
      ? [Object.freeze({ to: `block_${index + 1}`, kind: 'branch' })]
      : []),
  }));
  const proxy = new Proxy(target, {
    get(array, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) counter.reads++;
      return Reflect.get(array, property, receiver);
    },
  });
  Object.freeze(proxy);
  return proxy;
}

test('canonical CFG queries reuse one immutable block index', () => {
  const count = 400;
  const counter = { reads: 0 };
  const cfg = Object.freeze({
    contractVersion: '1.0.0',
    functionId: 'function_fixture',
    entryBlockId: 'block_0',
    blocks: observedFrozenBlocks(count, counter),
  });

  for (let round = 0; round < 2; round++) {
    for (let index = 0; index < count; index++) {
      const successors = successorsOf(cfg, `block_${index}`);
      const predecessors = predecessorsOf(cfg, `block_${index}`);
      assert.equal(successors.length, index + 1 < count ? 1 : 0);
      assert.equal(predecessors.length, index > 0 ? 1 : 0);
    }
  }

  // The legacy implementation rebuilt a Map from all blocks per query and
  // performs 640k indexed reads for this fixture. The canonical immutable path
  // should enumerate blocks once and answer subsequent queries from the index.
  assert.ok(counter.reads < count * 3,
    `CFG queries performed ${counter.reads} indexed block reads`);
});

test('CFG query indexing does not cache mutable caller graphs', () => {
  const first = { id: 'entry', predecessors: [], successors: [{ to: 'old', kind: 'branch' }] };
  const oldTarget = { id: 'old', predecessors: ['entry'], successors: [] };
  const nextTarget = { id: 'next', predecessors: ['entry'], successors: [] };
  const cfg = { functionId: 'f', entryBlockId: 'entry', blocks: [first, oldTarget] };
  assert.deepEqual(successorsOf(cfg, 'entry'), ['old']);
  first.successors[0].to = 'next';
  cfg.blocks[1] = nextTarget;
  assert.deepEqual(successorsOf(cfg, 'entry'), ['next']);
  assert.deepEqual(predecessorsOf(cfg, 'next'), ['entry']);
  assert.deepEqual(predecessorsOf(cfg, 'old'), []);
});
