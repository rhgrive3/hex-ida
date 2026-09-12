import test from 'node:test';
import assert from 'node:assert/strict';

import { FACT, factsOfKind, semanticFacts } from '../js/semantic.js';
import { VK } from '../js/ir.js';

function argumentFact(startAddress) {
  const ir = {
    startAddress,
    instructions: [],
    blocks: [{ startRow:0 }],
    values: [{ id:1, kind:VK.ARG, reg:'x0', bits:64, def:null, uses:[] }],
  };
  const facts = semanticFacts(ir);
  const args = factsOfKind(facts, FACT.ARGUMENT);
  assert.equal(args.length, 1);
  return args[0];
}

test('#3839 preserves zero as argument address/function identity', () => {
  const fact = argumentFact(0n);
  assert.equal(fact.address, 0n);
  assert.equal(fact.function, 0n);
});

test('#3839 preserves null as unknown argument identity', () => {
  const fact = argumentFact(null);
  assert.equal(fact.address, null);
  assert.equal(fact.function, null);
});

test('#3839 preserves nonzero bigint argument identity', () => {
  const fact = argumentFact(0x1000n);
  assert.equal(fact.address, 0x1000n);
  assert.equal(fact.function, 0x1000n);
});
