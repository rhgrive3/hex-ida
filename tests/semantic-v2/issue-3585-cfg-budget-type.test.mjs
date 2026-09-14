import assert from 'node:assert/strict';
import {
  createSemanticCfg,
  reachableBlocks,
} from '../../js/semantics/cfg/index.js';

const baseGraph = () => ({
  functionId:'issue-3585',
  entryBlockId:'b0',
  blocks:[
    { id:'b0', successors:[{ to:'b1', kind:'fallthrough' }] },
    { id:'b1', successors:[] },
  ],
});

function assertInvalidBudget(key, value, operation) {
  assert.throws(
    operation,
    (error) => error instanceof TypeError
      && error.message === `semantic-cfg-invalid-budget-${key}`,
    `${key} must reject ${Object.prototype.toString.call(value)}`,
  );
}

for (const [key, validValue, run] of [
  ['maxBlocks', 2, (value) => createSemanticCfg(baseGraph(), { budget:{ maxBlocks:value } })],
  ['maxEdges', 1, (value) => createSemanticCfg(baseGraph(), { budget:{ maxEdges:value } })],
  ['maxWorkItems', 2, (value) => {
    const cfg = createSemanticCfg(baseGraph());
    return reachableBlocks(cfg, cfg.entryBlockId, { budget:{ maxWorkItems:value } });
  }],
]) {
  assert.doesNotThrow(() => run(validValue), `${key} accepts a primitive positive safe integer`);
  assertInvalidBudget(key, String(validValue), () => run(String(validValue)));
  assertInvalidBudget(key, [validValue], () => run([validValue]));
  assertInvalidBudget(key, true, () => run(true));

  let coercions = 0;
  const coercible = {
    valueOf() {
      coercions += 1;
      return validValue;
    },
  };
  assertInvalidBudget(key, coercible, () => run(coercible));
  assert.equal(coercions, 0, `${key} must not execute user-controlled numeric coercion`);
}

assert.doesNotThrow(() => createSemanticCfg(baseGraph(), {
  budget:{ maxBlocks:null, maxEdges:undefined },
}), 'nullish create-time limits retain defaults');

const defaultCfg = createSemanticCfg(baseGraph());
assert.deepEqual(
  reachableBlocks(defaultCfg, defaultCfg.entryBlockId, { budget:{ maxWorkItems:null } }),
  ['b0', 'b1'],
  'nullish traversal limit retains the default budget',
);

for (const [key, value, run] of [
  ['maxBlocks', 0, (v) => createSemanticCfg(baseGraph(), { budget:{ maxBlocks:v } })],
  ['maxEdges', 1.5, (v) => createSemanticCfg(baseGraph(), { budget:{ maxEdges:v } })],
  ['maxWorkItems', Number.NaN, (v) => reachableBlocks(defaultCfg, defaultCfg.entryBlockId, { budget:{ maxWorkItems:v } })],
]) {
  assertInvalidBudget(key, value, () => run(value));
}

console.log('issue #3585 semantic CFG strict budget types: PASS');
