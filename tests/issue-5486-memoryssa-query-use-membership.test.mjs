import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getMemoryDefinition,
  getMemoryUse,
  reachingConcreteStore,
  reachingMemoryDefinition,
} from '../js/semantics/memoryssa/queries.js';

test('#5486: reachingConcreteStore does not accept forged aliasRelation on cloned use object', () => {
  const memorySsa = {
    definitions: [
      { id: 'd1', kind: 'memory-def' },
    ],
    uses: [
      {
        id: 'u1',
        reachingDefinitionId: 'd1',
        aliasRelation: 'may',
      },
    ],
  };

  const actual = memorySsa.uses[0];
  assert.equal(reachingConcreteStore(memorySsa, actual), null, 'may-alias use has no concrete store');

  const forged = {
    ...actual,
    aliasRelation: 'must',
  };

  const result = reachingConcreteStore(memorySsa, forged);
  assert.equal(result, null, 'forged must-alias use MUST NOT return concrete store (#5486)');
});

test('#5486: reachingMemoryDefinition resolves to canonical record, not fabricated reachingDefinitionId', () => {
  const memorySsa = {
    definitions: [
      { id: 'd1', kind: 'memory-def', label: 'correct-def' },
      { id: 'd2', kind: 'memory-def', label: 'fabricated-def' },
    ],
    uses: [
      {
        id: 'u1',
        reachingDefinitionId: 'd1',
        aliasRelation: 'may',
      },
    ],
  };

  const actual = memorySsa.uses[0];
  const fabricated = {
    ...actual,
    reachingDefinitionId: 'd2',
  };

  const def = reachingMemoryDefinition(memorySsa, fabricated);
  assert.equal(def.id, 'd1', 'fabricated reachingDefinitionId must not divert to d2 (#5486)');
});

test('#5486: old artifact use object cannot replay stale aliasRelation on current artifact', () => {
  const memorySsaOld = {
    definitions: [
      { id: 'd1', kind: 'memory-def' },
    ],
    uses: [
      {
        id: 'u1',
        reachingDefinitionId: 'd1',
        aliasRelation: 'must',
      },
    ],
  };

  const memorySsaCurrent = {
    definitions: [
      { id: 'd1', kind: 'memory-def' },
    ],
    uses: [
      {
        id: 'u1',
        reachingDefinitionId: 'd1',
        aliasRelation: 'may',
      },
    ],
  };

  const oldUse = memorySsaOld.uses[0];
  const result = reachingConcreteStore(memorySsaCurrent, oldUse);
  assert.equal(result, null, 'stale old use object replayed on current artifact MUST NOT return concrete store (#5486)');
});

test('#5486: strict ID contract rejects malformed and structured IDs', () => {
  const memorySsa = {
    definitions: [
      { id: 'd1', kind: 'memory-def' },
    ],
    uses: [
      {
        id: 'u1',
        reachingDefinitionId: 'd1',
        aliasRelation: 'must',
      },
    ],
  };

  // Structured IDs or non-string IDs must throw TypeError
  assert.throws(() => getMemoryDefinition(memorySsa, ['d1']), TypeError);
  assert.throws(() => getMemoryDefinition(memorySsa, ''), TypeError);
  assert.throws(() => getMemoryDefinition(memorySsa, 123), TypeError);
  assert.throws(() => getMemoryDefinition(memorySsa, null), TypeError);

  assert.throws(() => getMemoryUse(memorySsa, ['u1']), TypeError);
  assert.throws(() => getMemoryUse(memorySsa, ''), TypeError);
  assert.throws(() => getMemoryUse(memorySsa, 123), TypeError);
  assert.throws(() => getMemoryUse(memorySsa, null), TypeError);

  assert.throws(() => reachingMemoryDefinition(memorySsa, ['u1']), TypeError);
  assert.throws(() => reachingMemoryDefinition(memorySsa, ''), TypeError);
  assert.throws(() => reachingMemoryDefinition(memorySsa, { id: '' }), TypeError);
  assert.throws(() => reachingMemoryDefinition(memorySsa, { id: ['u1'] }), TypeError);
  assert.throws(() => reachingMemoryDefinition(memorySsa, null), TypeError);

  // Canonical valid lookups succeed
  assert.equal(getMemoryDefinition(memorySsa, 'd1')?.id, 'd1');
  assert.equal(getMemoryDefinition(memorySsa, 'non-existent'), null);
  assert.equal(getMemoryUse(memorySsa, 'u1')?.id, 'u1');
  assert.equal(getMemoryUse(memorySsa, 'non-existent'), null);
  assert.equal(reachingMemoryDefinition(memorySsa, 'u1')?.id, 'd1');
  assert.equal(reachingMemoryDefinition(memorySsa, memorySsa.uses[0])?.id, 'd1');
  assert.equal(reachingConcreteStore(memorySsa, 'u1')?.id, 'd1');
  assert.equal(reachingConcreteStore(memorySsa, memorySsa.uses[0])?.id, 'd1');
});
