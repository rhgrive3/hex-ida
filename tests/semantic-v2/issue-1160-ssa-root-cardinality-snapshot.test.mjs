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

{
  const controller = new AbortController();
  let poisonRead = false;
  const definitions = new Array(2);
  Object.defineProperty(definitions, 0, {
    enumerable:true,
    get() {
      controller.abort();
      return definition('d-abort', 'v-abort');
    },
  });
  Object.defineProperty(definitions, 1, {
    enumerable:true,
    get() {
      poisonRead = true;
      throw new Error('definition-root-poison-read');
    },
  });

  assert.throws(
    () => createSemanticSsaContract({
      functionId:'f-definition-root-cancel',
      definitions,
      uses:[],
    }, {
      signal:controller.signal,
      budget:{ maxDefinitions:2, maxUses:1, maxLinks:1 },
    }),
    (error) => error?.name === 'AbortError' && error?.message === 'semantic-ssa-cancelled',
  );
  assert.equal(poisonRead, false, 'definition snapshot must not read the next entry after cancellation');
}

{
  const controller = new AbortController();
  let poisonRead = false;
  const uses = new Array(2);
  Object.defineProperty(uses, 0, {
    enumerable:true,
    get() {
      controller.abort();
      return use('u-abort', 'v0');
    },
  });
  Object.defineProperty(uses, 1, {
    enumerable:true,
    get() {
      poisonRead = true;
      throw new Error('use-root-poison-read');
    },
  });

  assert.throws(
    () => createSemanticSsaContract({
      functionId:'f-use-root-cancel',
      definitions:[definition('d0', 'v0')],
      uses,
    }, {
      signal:controller.signal,
      budget:{ maxDefinitions:1, maxUses:2, maxLinks:2 },
    }),
    (error) => error?.name === 'AbortError' && error?.message === 'semantic-ssa-cancelled',
  );
  assert.equal(poisonRead, false, 'use snapshot must not read the next entry after cancellation');
}

console.log('issue-1160 semantic SSA root cardinality snapshot: PASS');
