// Issue #5413 regression: createSemanticSsaContract() accepted a phi incoming
// whose valueId exists but whose definition is branch-local to the OPPOSITE
// predecessor edge. Canonical SSA binds every phi argument to the definition
// produced on its own edge; a swapped assignment must fail closed.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticSsaContract } from '../../js/semantics/ssa/contract.js';

const origin = { instructionIds: ['instruction_fixture'] };

function diamondCfg() {
  return createSemanticCfg({ functionId: 'function_fixture', entryBlockId: 'entry', blocks: [
    { id: 'entry', successors: [{ to: 'left', kind: 'conditional-true' }, { to: 'right', kind: 'conditional-false' }] },
    { id: 'left', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'right', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'join', successors: [] },
  ] });
}

test('#5413 a phi argument defined in its own predecessor block stays canonical', () => {
  const cfg = diamondCfg();
  const ssa = createSemanticSsaContract({ functionId: 'function_fixture', definitions: [
    { definitionId: 'def_left', valueId: 'value_left', kind: 'definition', blockId: 'left', variableKey: 'state:v', sourceEntityId: 'entity_left', origin },
    { definitionId: 'def_right', valueId: 'value_right', kind: 'definition', blockId: 'right', variableKey: 'state:v', sourceEntityId: 'entity_right', origin },
    { definitionId: 'def_phi', valueId: 'value_phi', kind: 'phi', blockId: 'join', variableKey: 'state:v', sourceEntityId: 'entity_phi', incoming: [
      { predecessorBlockId: 'left', valueId: 'value_left' },
      { predecessorBlockId: 'right', valueId: 'value_right' },
    ], origin, proof: { kind: 'dominance-frontier' } },
  ], uses: [{ useId: 'use_phi', valueId: 'value_phi', blockId: 'join', sourceEntityId: 'entity_return', origin }] }, { cfg });
  assert.equal(ssa.useDefLinks[0].definitionId, 'def_phi');
});

test('#5413 a phi argument attributed to the opposite edge is rejected', () => {
  const cfg = diamondCfg();
  assert.throws(() => createSemanticSsaContract({ functionId: 'function_fixture', definitions: [
    { definitionId: 'def_left', valueId: 'value_left', kind: 'definition', blockId: 'left', variableKey: 'state:v', sourceEntityId: 'entity_left', origin },
    { definitionId: 'def_right', valueId: 'value_right', kind: 'definition', blockId: 'right', variableKey: 'state:v', sourceEntityId: 'entity_right', origin },
    { definitionId: 'def_phi', valueId: 'value_phi', kind: 'phi', blockId: 'join', variableKey: 'state:v', sourceEntityId: 'entity_phi', incoming: [
      { predecessorBlockId: 'left', valueId: 'value_right' },
      { predecessorBlockId: 'right', valueId: 'value_left' },
    ], origin, proof: { kind: 'dominance-frontier' } },
  ], uses: [{ useId: 'use_phi', valueId: 'value_phi', blockId: 'join', sourceEntityId: 'entity_return', origin }] }, { cfg }),
  (error) => error?.message === 'semantic-ssa-phi-incoming-edge-mismatch');
});

test('#5413 a definition without a block id stays unpinned to its edge', () => {
  const cfg = diamondCfg();
  const ssa = createSemanticSsaContract({ functionId: 'function_fixture', definitions: [
    { definitionId: 'def_entry', valueId: 'value_entry', kind: 'entry', blockId: null, variableKey: 'state:v', sourceEntityId: 'entity_entry', origin },
    { definitionId: 'def_phi', valueId: 'value_phi', kind: 'phi', blockId: 'join', variableKey: 'state:v', sourceEntityId: 'entity_phi', incoming: [
      { predecessorBlockId: 'left', valueId: 'value_entry' },
      { predecessorBlockId: 'right', valueId: 'value_entry' },
    ], origin, proof: { kind: 'dominance-frontier' } },
  ], uses: [{ useId: 'use_phi', valueId: 'value_phi', blockId: 'join', sourceEntityId: 'entity_return', origin }] }, { cfg });
  assert.equal(ssa.useDefLinks[0].definitionId, 'def_phi');
});
