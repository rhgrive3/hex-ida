import assert from 'node:assert/strict';
import test from 'node:test';

import { PassManager } from '../../../js/decompiler/passes/manager.js';
import { recoverHighVariables } from '../../../js/decompiler/types/high-variables.js';

test('rollback immutability proof caches the whole proven frozen closure', () => {
  const count = 160;
  let next = null;
  const nodes = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    next = Object.freeze({ index, next });
    nodes.push(next);
  }
  const state = { refs: nodes, opts: { deterministicTransforms: true } };
  const frozen = new WeakSet(nodes);
  const realDescriptors = Object.getOwnPropertyDescriptors;
  let frozenDescriptorReads = 0;
  try {
    Object.getOwnPropertyDescriptors = (value) => {
      if (frozen.has(value)) frozenDescriptorReads += 1;
      return realDescriptors(value);
    };
    new PassManager([{ name: 'noop', run(current) { current.done = true; } }], { timeBudgetMs: 100000 }).run(state);
  } finally {
    Object.getOwnPropertyDescriptors = realDescriptors;
  }
  assert.equal(state.done, true);
  assert.ok(
    frozenDescriptorReads <= count + 4,
    `deep-frozen closure was re-walked instead of cached: ${frozenDescriptorReads} descriptor reads`,
  );
});

test('high-variable address-taken recovery indexes stack address bases once', () => {
  const count = 192;
  const values = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    kind: 'local',
    reg: `x${index % 29}`,
    uses: [],
  }));
  let addressReads = 0;
  const instructions = Array.from({ length: count }, (_, index) => {
    const address = { stack: index % 11 === 0, base: values[(index * 17) % count] };
    return Object.defineProperty({ op: 'load' }, 'addr', {
      enumerable: true,
      configurable: true,
      get() { addressReads += 1; return address; },
    });
  });
  const result = recoverHighVariables({ values, instructions }, { values: new Map() });
  assert.equal(result.groups.length, count);
  assert.ok(addressReads <= count + 4, `instruction address scan was repeated per SSA value: ${addressReads}`);
});
