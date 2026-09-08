import assert from 'node:assert/strict';
import { createSemanticSsaContract } from '../../js/semantics/ssa/contract.js';

const origin = { instructionIds:['i'] };
const originalLocaleCompare = String.prototype.localeCompare;
String.prototype.localeCompare = function forbiddenLocaleCompare() {
  throw new Error('canonical SSA ordering must not depend on localeCompare');
};

try {
  const ssa = createSemanticSsaContract({
    functionId:'f',
    definitions:[
      { definitionId:'d-a', valueId:'ä', kind:'entry', blockId:null, variableKey:'state:v', sourceEntityId:null, origin },
      { definitionId:'d-z', valueId:'z', kind:'entry', blockId:null, variableKey:'state:v', sourceEntityId:null, origin },
      {
        definitionId:'d-phi', valueId:'φ', kind:'phi', blockId:'join', variableKey:'state:v', sourceEntityId:'join', origin,
        incoming:[
          { predecessorBlockId:'ä', valueId:'ä' },
          { predecessorBlockId:'z', valueId:'z' },
        ],
      },
    ],
    uses:[
      { useId:'ä-use', valueId:'ä', blockId:null, sourceEntityId:'entity-a', origin },
      { useId:'z-use', valueId:'z', blockId:null, sourceEntityId:'entity-z', origin },
    ],
  });

  assert.deepEqual(ssa.definitions.map((definition) => definition.valueId), ['z','ä','φ']);
  assert.deepEqual(
    ssa.definitions.find((definition) => definition.kind === 'phi').incoming.map((incoming) => incoming.predecessorBlockId),
    ['z','ä'],
  );
  assert.deepEqual(ssa.uses.map((use) => use.useId), ['z-use','ä-use']);
  assert.deepEqual(ssa.useDefLinks.map((link) => link.useId), ['z-use','ä-use']);
} finally {
  String.prototype.localeCompare = originalLocaleCompare;
}

console.log('issue 5850 semantic SSA locale-independent ordering: PASS');
