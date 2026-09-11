import assert from 'node:assert/strict';
import { createMemorySsaContract } from '../../js/semantics/memoryssa/contract.js';

const origin = Object.freeze({ instructionIds: ['issue-4497'] });

function region(id) {
  return {
    id,
    kind: 'stack-fixed',
    functionId: 'f',
    offset: 0,
  };
}

function definition(id, regionId) {
  return {
    id,
    kind: 'entry',
    regionId,
    blockId: null,
    sourceEntityId: `entity-${id}`,
    origin,
  };
}

function use(id, definitionId, regionId) {
  return {
    id,
    regionId,
    reachingDefinitionId: definitionId,
    blockId: null,
    sourceEntityId: `entity-${id}`,
    origin,
  };
}

function assertBudgetError(run, code) {
  assert.throws(run, (error) => error?.code === code && error?.status === 'budget-limited');
}

{
  let normalized = 0;
  const poison = {
    id: 'poison-region',
    get kind() {
      normalized += 1;
      throw new Error('region-normalized-before-cardinality');
    },
  };
  assertBudgetError(
    () => createMemorySsaContract({
      functionId: 'f',
      regions: [poison, poison],
      definitions: [],
      uses: [],
    }, { budget: { maxRegions: 1, maxWorkItems: 100 } }),
    'memory-ssa-budget-exceeded-maxRegions',
  );
  assert.equal(normalized, 0, 'region cardinality must be checked before region normalization');
}

{
  let normalized = 0;
  const poison = {
    id: 'poison-definition',
    get kind() {
      normalized += 1;
      throw new Error('definition-normalized-before-cardinality');
    },
    regionId: 'r0',
    origin,
  };
  assertBudgetError(
    () => createMemorySsaContract({
      functionId: 'f',
      regions: [region('r0')],
      definitions: [poison, poison],
      uses: [],
    }, { budget: { maxDefinitions: 1, maxWorkItems: 100 } }),
    'memory-ssa-budget-exceeded-maxDefinitions',
  );
  assert.equal(normalized, 0, 'definition cardinality must be checked before definition normalization');
}

{
  let normalized = 0;
  const poison = {
    get id() {
      normalized += 1;
      throw new Error('use-normalized-before-cardinality');
    },
    regionId: 'r0',
    reachingDefinitionId: 'd0',
    sourceEntityId: 'entity-poison-use',
    origin,
  };
  assertBudgetError(
    () => createMemorySsaContract({
      functionId: 'f',
      regions: [region('r0')],
      definitions: [definition('d0', 'r0')],
      uses: [poison, poison],
    }, { budget: { maxUses: 1, maxWorkItems: 100 } }),
    'memory-ssa-budget-exceeded-maxUses',
  );
  assert.equal(normalized, 0, 'use cardinality must be checked before use normalization');
}

{
  const artifact = createMemorySsaContract({
    functionId: 'f',
    regions: [region('r-z'), region('r-a')],
    definitions: [definition('d-z', 'r-z'), definition('d-a', 'r-a')],
    uses: [use('u-z', 'd-z', 'r-z')],
  }, {
    budget: {
      maxRegions: 2,
      maxDefinitions: 2,
      maxUses: 1,
      maxWorkItems: 100,
    },
  });
  assert.deepEqual(artifact.regions.map((item) => item.id), ['r-a', 'r-z']);
  assert.deepEqual(artifact.definitions.map((item) => item.id), ['d-a', 'd-z']);
  assert.deepEqual(artifact.uses.map((item) => item.id), ['u-z']);
}

console.log('issue-4497 MemorySSA cardinality preflight: PASS');
