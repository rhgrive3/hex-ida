import assert from 'node:assert/strict';
import { createSemanticSsaContract } from '../../js/semantics/ssa/contract.js';

const origin = Object.freeze({ instructionIds:['issue-1160'] });

function definition(definitionId, valueId, extra = {}) {
  return {
    definitionId,
    valueId,
    kind:'entry',
    blockId:null,
    variableKey:null,
    sourceEntityId:`entity-${definitionId}`,
    origin,
    ...extra,
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

{
  let normalized = 0;
  const poison = {
    definitionId:'poison',
    valueId:'poison',
    get kind() {
      normalized += 1;
      throw new Error('definition-normalized-before-budget-check');
    },
    origin,
  };
  assert.throws(
    () => createSemanticSsaContract({
      functionId:'f',
      definitions:[poison, poison],
      uses:[],
    }, { budget:{ maxDefinitions:1 } }),
    /semantic-ssa-budget-exceeded-maxDefinitions/,
  );
  assert.equal(normalized, 0, 'raw definition cardinality must fail before item normalization');
}

{
  let normalized = 0;
  const poisonIncoming = {};
  Object.defineProperties(poisonIncoming, {
    predecessorBlockId: {
      enumerable:true,
      get() {
        normalized += 1;
        throw new Error('phi-incoming-normalized-after-link-budget');
      },
    },
    valueId: { enumerable:true, value:'v0' },
  });
  assert.throws(
    () => createSemanticSsaContract({
      functionId:'f',
      definitions:[
        definition('d0', 'v0'),
        definition('dphi', 'vphi', {
          kind:'phi',
          incoming:[
            { predecessorBlockId:'p0', valueId:'v0' },
            poisonIncoming,
          ],
        }),
      ],
      uses:[],
    }, { budget:{ maxDefinitions:2, maxUses:1, maxLinks:1 } }),
    /semantic-ssa-budget-exceeded-maxLinks/,
  );
  assert.equal(normalized, 0, 'link budget must be charged before copying the over-budget incoming edge');
}

{
  let signalReads = 0;
  let normalized = 0;
  const signal = {
    get aborted() {
      signalReads += 1;
      return signalReads >= 3;
    },
  };
  const tracked = (id) => ({
    definitionId:`d${id}`,
    valueId:`v${id}`,
    get kind() {
      normalized += 1;
      return 'entry';
    },
    origin,
  });
  assert.throws(
    () => createSemanticSsaContract({
      functionId:'f',
      definitions:[tracked(0), tracked(1), tracked(2)],
      uses:[],
    }, {
      signal,
      budget:{ maxDefinitions:3, maxUses:1, maxLinks:1 },
    }),
    (error) => error?.name === 'AbortError' && /semantic-ssa-cancelled/.test(error.message),
  );
  assert.equal(normalized, 1, 'cancellation must be observed between definition normalizations');
}

{
  const ssa = createSemanticSsaContract({
    functionId:'f',
    definitions:[
      definition('d-z', 'v-z'),
      definition('d-a', 'v-a'),
    ],
    uses:[
      use('u-z', 'v-z'),
      use('u-a', 'v-a'),
    ],
  }, {
    budget:{ maxDefinitions:2, maxUses:2, maxLinks:2 },
  });
  assert.deepEqual(ssa.definitions.map((item) => item.valueId), ['v-a', 'v-z']);
  assert.deepEqual(ssa.uses.map((item) => item.useId), ['u-a', 'u-z']);
  assert.deepEqual(ssa.useDefLinks.map((item) => item.useId), ['u-a', 'u-z']);
}

{
  assert.doesNotThrow(() => createSemanticSsaContract({
    functionId:'f',
    definitions:[
      definition('d0', 'v0'),
      definition('dphi', 'vphi', {
        kind:'phi',
        incoming:[{ predecessorBlockId:'p0', valueId:'v0' }],
      }),
    ],
    uses:[use('u0', 'vphi')],
  }, {
    budget:{ maxDefinitions:2, maxUses:1, maxLinks:2 },
  }));
  assert.throws(() => createSemanticSsaContract({
    functionId:'f',
    definitions:[
      definition('d0', 'v0'),
      definition('dphi', 'vphi', {
        kind:'phi',
        incoming:[{ predecessorBlockId:'p0', valueId:'v0' }],
      }),
    ],
    uses:[use('u0', 'vphi')],
  }, {
    budget:{ maxDefinitions:2, maxUses:1, maxLinks:1 },
  }), /semantic-ssa-budget-exceeded-maxLinks/);
}

console.log('issue-1160 semantic SSA ingestion budgets: PASS');
