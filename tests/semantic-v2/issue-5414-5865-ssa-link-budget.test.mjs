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

{
  let incomingReads = 0;
  const oneIncoming = [{ predecessorBlockId:'p0', valueId:'v0' }];
  const overBudgetIncoming = [
    { predecessorBlockId:'p0', valueId:'v0' },
    { predecessorBlockId:'p1', valueId:'v0' },
  ];
  const phi = {
    definitionId:'phi-snapshot',
    valueId:'vp-snapshot',
    kind:'phi',
    blockId:'join',
    variableKey:'state:v',
    sourceEntityId:'join',
    get incoming() {
      incomingReads++;
      return incomingReads === 1 ? oneIncoming : overBudgetIncoming;
    },
    origin,
  };

  const contract = createSemanticSsaContract({
    functionId:'f-snapshot',
    definitions:[entry('d0','v0'), phi],
    uses:[],
  }, { budget:{ maxLinks:1 } });

  assert.equal(incomingReads, 1, 'PHI incoming accessor must not be re-read after maxLinks preflight');
  const normalizedPhi = contract.definitions.find((definition) => definition.definitionId === 'phi-snapshot');
  assert.ok(normalizedPhi);
  assert.equal(normalizedPhi.incoming.length, 1, 'normalized PHI must use the exact incoming snapshot charged by preflight');
  assert.equal(normalizedPhi.incoming[0].predecessorBlockId, 'p0');
}

{
  const incoming = [{ predecessorBlockId:'p0', valueId:'v0' }];
  let kindReads = 0;
  const phi = {
    definitionId:'phi-array-snapshot',
    valueId:'vp-array-snapshot',
    get kind() {
      kindReads++;
      incoming.push({ predecessorBlockId:'p1', valueId:'v0' });
      return 'phi';
    },
    blockId:'join',
    variableKey:'state:v',
    sourceEntityId:'join',
    incoming,
    origin,
  };

  const contract = createSemanticSsaContract({
    functionId:'f-array-snapshot',
    definitions:[entry('d0','v0'), phi],
    uses:[],
  }, { budget:{ maxLinks:1 } });

  assert.equal(kindReads, 1);
  assert.equal(incoming.length, 2, 'counterexample must mutate the caller-owned array after preflight');
  const normalizedPhi = contract.definitions.find((definition) => definition.definitionId === 'phi-array-snapshot');
  assert.ok(normalizedPhi);
  assert.equal(normalizedPhi.incoming.length, 1, 'normalization must retain only the bounded incoming snapshot charged by maxLinks');
  assert.equal(normalizedPhi.incoming[0].predecessorBlockId, 'p0');
}

console.log('issues 5414/5865 semantic SSA link budget: PASS');
