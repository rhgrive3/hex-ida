import assert from 'node:assert/strict';
import { createSemanticSsaContract } from '../../js/semantics/ssa/contract.js';

const origin = { instructionIds:['i'] };
const definition = (definitionId, valueId, variableKey) => ({
  definitionId,
  valueId,
  kind:'entry',
  blockId:null,
  variableKey,
  sourceEntityId:null,
  origin,
});
const phi = (variableKey, incoming) => ({
  definitionId:'phi',
  valueId:'vphi',
  kind:'phi',
  blockId:'join',
  variableKey,
  sourceEntityId:'join',
  incoming,
  origin,
});

assert.doesNotThrow(() => createSemanticSsaContract({
  functionId:'f',
  definitions:[
    definition('dx','vx','state:x'),
    phi('state:x', [{ predecessorBlockId:'p0', valueId:'vx' }]),
  ],
  uses:[],
}), 'same-variable phi incoming must remain valid');

assert.throws(() => createSemanticSsaContract({
  functionId:'f',
  definitions:[
    definition('dy','vy','state:y'),
    phi('state:x', [{ predecessorBlockId:'p0', valueId:'vy' }]),
  ],
  uses:[],
}), /semantic-ssa-phi-variable-key-mismatch/,
'cross-variable phi incoming must fail closed');

assert.throws(() => createSemanticSsaContract({
  functionId:'f',
  definitions:[
    definition('dscalar','vscalar',null),
    phi('state:x', [{ predecessorBlockId:'p0', valueId:'vscalar' }]),
  ],
  uses:[],
}), /semantic-ssa-phi-variable-key-mismatch/,
'state-variable phi must not accept a scalar incoming definition');

assert.throws(() => createSemanticSsaContract({
  functionId:'f',
  definitions:[
    definition('dx','vx','state:x'),
    definition('dy','vy','state:y'),
    phi('state:x', [
      { predecessorBlockId:'p0', valueId:'vx' },
      { predecessorBlockId:'p1', valueId:'vy' },
    ]),
  ],
  uses:[],
}), /semantic-ssa-phi-variable-key-mismatch/,
'one mismatched predecessor must invalidate the whole state phi');

assert.doesNotThrow(() => createSemanticSsaContract({
  functionId:'f',
  definitions:[
    definition('dscalar','vscalar',null),
    phi(null, [{ predecessorBlockId:'p0', valueId:'vscalar' }]),
  ],
  uses:[],
}), 'scalar phi representation must remain compatible');

console.log('issue 5762 semantic SSA phi variable identity: PASS');
