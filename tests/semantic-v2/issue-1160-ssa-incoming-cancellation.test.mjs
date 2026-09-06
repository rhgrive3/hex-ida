import assert from 'node:assert/strict';
import { createSemanticSsaContract } from '../../js/semantics/ssa/contract.js';

const origin = Object.freeze({ instructionIds:['issue-1160'] });
const controller = new AbortController();
const incoming = new Array(2);
let poisonReads = 0;

Object.defineProperties(incoming, {
  0: {
    enumerable:true,
    configurable:true,
    get() {
      controller.abort();
      return { predecessorBlockId:'p0', valueId:'v0' };
    },
  },
  1: {
    enumerable:true,
    configurable:true,
    get() {
      poisonReads += 1;
      throw new Error('phi-incoming-read-after-abort');
    },
  },
});

assert.throws(
  () => createSemanticSsaContract({
    functionId:'f-incoming-cancel',
    definitions:[
      {
        definitionId:'d0',
        valueId:'v0',
        kind:'entry',
        blockId:null,
        variableKey:null,
        sourceEntityId:'entry',
        origin,
      },
      {
        definitionId:'dphi',
        valueId:'vphi',
        kind:'phi',
        blockId:null,
        variableKey:null,
        sourceEntityId:'phi',
        incoming,
        origin,
      },
    ],
    uses:[],
  }, {
    signal:controller.signal,
    budget:{ maxDefinitions:2, maxUses:1, maxLinks:2 },
  }),
  (error) => error?.name === 'AbortError' && /semantic-ssa-cancelled/.test(error.message),
  'PHI incoming snapshot ingestion must stop before reading the next entry after cancellation',
);

assert.equal(poisonReads, 0, 'no PHI incoming entry after cancellation may be observed');

console.log('issue-1160 semantic SSA incoming cancellation: PASS');
