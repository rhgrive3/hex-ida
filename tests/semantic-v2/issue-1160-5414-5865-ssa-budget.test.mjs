import assert from 'node:assert/strict';
import { createSemanticSsaContract } from '../../js/semantics/ssa/contract.js';

const origin = { instructionIds:['i'] };
const entry = (definitionId, valueId, extra = {}) => ({
  definitionId,
  valueId,
  kind:'entry',
  blockId:null,
  variableKey:'state:v',
  sourceEntityId:null,
  origin,
  ...extra,
});
const use = (useId, valueId) => ({
  useId,
  valueId,
  blockId:null,
  sourceEntityId:`entity:${useId}`,
  origin,
});

{
  const input = {
    functionId:'f',
    definitions:[entry('d0','v0'), { malformed:true }],
    uses:[],
  };
  assert.throws(
    () => createSemanticSsaContract(input, { budget:{ maxDefinitions:1 } }),
    /semantic-ssa-budget-exceeded-maxDefinitions/,
    'raw definition cardinality must fail before normalizing an oversized tail',
  );
}

{
  const input = {
    functionId:'f',
    definitions:[entry('d0','v0')],
    uses:[use('u0','v0'), { malformed:true }],
  };
  assert.throws(
    () => createSemanticSsaContract(input, { budget:{ maxUses:1 } }),
    /semantic-ssa-budget-exceeded-maxUses/,
    'raw use cardinality must fail before normalizing an oversized tail',
  );
}

const phiInput = {
  functionId:'f',
  definitions:[
    entry('d0','v0'),
    {
      definitionId:'phi',
      valueId:'vp',
      kind:'phi',
      blockId:'join',
      variableKey:'state:v',
      sourceEntityId:'join',
      incoming:[
        { predecessorBlockId:'p0', valueId:'v0' },
        { predecessorBlockId:'p1', valueId:'v0' },
      ],
      origin,
    },
  ],
  uses:[],
};
const cfg = {
  blocks:[
    { id:'p0', predecessors:[] },
    { id:'p1', predecessors:[] },
    { id:'join', predecessors:['p0','p1'] },
  ],
};

for (const options of [
  { budget:{ maxLinks:1 } },
  { budget:{ maxLinks:1 }, cfg },
]) {
  assert.throws(
    () => createSemanticSsaContract(phiInput, options),
    /semantic-ssa-budget-exceeded-maxLinks/,
    'phi incoming relations must consume maxLinks with or without CFG validation',
  );
}

assert.doesNotThrow(() => createSemanticSsaContract({
  functionId:'f',
  definitions:[entry('d0','v0')],
  uses:[use('u0','v0')],
}, { budget:{ maxLinks:1 } }), 'one use-def relation must fit maxLinks=1');

assert.throws(() => createSemanticSsaContract({
  functionId:'f',
  definitions:[
    entry('d0','v0'),
    {
      definitionId:'phi',
      valueId:'vp',
      kind:'phi',
      blockId:'join',
      variableKey:'state:v',
      sourceEntityId:'join',
      incoming:[{ predecessorBlockId:'p0', valueId:'v0' }],
      origin,
    },
  ],
  uses:[use('u0','v0')],
}, { budget:{ maxLinks:1 } }), /semantic-ssa-budget-exceeded-maxLinks/,
'use-def and phi incoming relations must share one cumulative link budget');

assert.doesNotThrow(() => createSemanticSsaContract({
  functionId:'f',
  definitions:[entry('d0','v0')],
  uses:[use('u0','v0')],
}, { budget:{ maxDefinitions:1, maxUses:1, maxLinks:1 } }),
'exactly-at-budget artifacts must remain accepted');

console.log('issues 1160/5414/5865 semantic SSA budgets: PASS');
