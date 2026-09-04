import assert from 'node:assert/strict';
import { createSemanticSsaContract } from '../../js/semantics/ssa/contract.js';

const origin = Object.freeze({ instructionIds:['issue-1160-root-cardinality'] });

function definition(definitionId, valueId) {
  return {
    definitionId,
    valueId,
    kind:'entry',
    blockId:null,
    variableKey:null,
    sourceEntityId:`entity-${definitionId}`,
    origin,
  };
}

function use(useId, valueId) {
  return {
    useId,
    valueId,
    blockId:null,
    sourceEntityId:`entity-${useId}`,
    origin,
  };
}

const rawDefinitions = [];
const rawUses = [];
const tracked = {
  definitionId:'d0',
  valueId:'v0',
  blockId:null,
  variableKey:null,
  sourceEntityId:'entity-d0',
  origin,
};
Object.defineProperties(tracked, {
  incoming: {
    enumerable:true,
    get() {
      rawDefinitions.push(definition('d-late', 'v-late'));
      return [];
    },
  },
  kind: {
    enumerable:true,
    get() {
      rawUses.push(use('u-late-0', 'v0'), use('u-late-1', 'v0'));
      return 'entry';
    },
  },
});
rawDefinitions.push(tracked);

const ssa = createSemanticSsaContract({
  functionId:'f-root-snapshot',
  definitions:rawDefinitions,
  uses:rawUses,
}, {
  budget:{ maxDefinitions:1, maxUses:1, maxLinks:1 },
});

assert.equal(rawDefinitions.length, 2, 'counterexample must grow the caller-owned definitions after charging');
assert.equal(rawUses.length, 2, 'counterexample must grow the caller-owned uses after charging');
assert.deepEqual(ssa.definitions.map((item) => item.valueId), ['v0'], 'post-check definition growth must not escape maxDefinitions');
assert.equal(ssa.uses.length, 0, 'post-check use growth must not escape maxUses');
assert.equal(ssa.useDefLinks.length, 0, 'post-check use growth must not escape maxLinks');

console.log('issue-1160 semantic SSA root cardinality snapshot: PASS');
