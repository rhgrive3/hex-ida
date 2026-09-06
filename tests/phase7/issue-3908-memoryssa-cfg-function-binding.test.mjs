import test from 'node:test';
import assert from 'node:assert/strict';

import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import {
  createMemoryRegionRef,
  createMemorySsaContract,
  validateMemorySsa,
} from '../../js/semantics/memoryssa/index.js';

const origin = { instructionIds: ['i'] };

function makeCfg(functionId, { rightFallsIntoJoin = true } = {}) {
  return createSemanticCfg({
    functionId,
    entryBlockId: 'entry',
    blocks: [
      {
        id: 'entry',
        successors: [
          { to: 'left', kind: 'conditional-true' },
          { to: 'right', kind: 'conditional-false' },
        ],
      },
      { id: 'left', successors: [{ to: 'join', kind: 'branch' }] },
      {
        id: 'right',
        successors: rightFallsIntoJoin ? [{ to: 'join', kind: 'branch' }] : [],
      },
      { id: 'join', successors: [] },
    ],
  });
}

function contractInput() {
  const region = createMemoryRegionRef({
    id: 'r',
    kind: 'rooted-offset',
    functionId: 'owner-function',
    rootEntityId: 'obj',
    offset: 0,
    widthBits: 64,
  });

  return {
    functionId: 'owner-function',
    regions: [region],
    definitions: [
      {
        id: 'e',
        kind: 'entry',
        regionId: 'r',
        blockId: 'entry',
        sourceEntityId: 'se',
        origin,
      },
      {
        id: 'l',
        kind: 'memory-def',
        regionId: 'r',
        blockId: 'left',
        previousDefinitionIds: ['e'],
        sourceEntityId: 'sl',
        origin,
      },
      {
        id: 'rr',
        kind: 'memory-def',
        regionId: 'r',
        blockId: 'right',
        previousDefinitionIds: ['e'],
        sourceEntityId: 'sr',
        origin,
      },
      {
        id: 'p',
        kind: 'memory-phi',
        regionId: 'r',
        blockId: 'join',
        incoming: [
          { predecessorBlockId: 'left', definitionId: 'l' },
          { predecessorBlockId: 'right', definitionId: 'rr' },
        ],
        sourceEntityId: 'sp',
        origin,
      },
    ],
    uses: [],
  };
}

test('MemorySSA contract rejects a foreign-function CFG before using its block graph', () => {
  const foreignCfg = makeCfg('foreign-function');
  assert.throws(
    () => createMemorySsaContract(contractInput(), { cfg: foreignCfg }),
    /memory-ssa-cfg-function-mismatch/,
  );
});

test('MemorySSA contract preserves same-function CFG validation', () => {
  const ownerCfg = makeCfg('owner-function');
  const contract = createMemorySsaContract(contractInput(), { cfg: ownerCfg });
  assert.equal(contract.functionId, 'owner-function');
  assert.equal(contract.definitions.find((definition) => definition.id === 'p')?.incoming.length, 2);
});

test('MemorySSA contract rejects malformed CFG function identity', () => {
  const ownerCfg = makeCfg('owner-function');
  const malformedCfg = { ...ownerCfg, functionId: ['owner-function'] };
  assert.throws(
    () => createMemorySsaContract(contractInput(), { cfg: malformedCfg }),
    /memory-ssa-cfg-function-mismatch/,
  );
});

test('validateMemorySsa inherits the same cross-function CFG gate', () => {
  const ownerCfg = makeCfg('owner-function');
  const foreignCfg = makeCfg('foreign-function');
  const contract = createMemorySsaContract(contractInput(), { cfg: ownerCfg });
  assert.throws(
    () => validateMemorySsa(contract, { cfg: foreignCfg }),
    /memory-ssa-cfg-function-mismatch/,
  );
});

test('same-function CFG still rejects an incomplete memory-phi predecessor set', () => {
  const incompleteCfg = makeCfg('owner-function', { rightFallsIntoJoin: false });
  assert.throws(
    () => createMemorySsaContract(contractInput(), { cfg: incompleteCfg }),
    /memory-ssa-phi-predecessor-not-in-cfg|memory-ssa-phi-predecessor-set-incomplete/,
  );
});
