import assert from 'node:assert/strict';
import { createMemorySsaContract } from '../js/semantics/memoryssa/contract.js';

// Issue #5756: canonical MemorySSA contract ordering (regions/definitions/uses,
// memory-phi incoming, reachingDefinitionLinks) used default
// String.prototype.localeCompare, whose collation flips for non-ASCII ids
// across ICU locales. Canonical serialization must use a fixed code-unit
// order. On this host 'A'.localeCompare('a') === 1 while code-unit order is
// 'A' < 'a', so the old comparator produced ['a','A'] — environment drift.

const region = (id, offset) => ({ id, kind: 'stack-fixed', functionId: 'f', offset });
const origin = { instructionIds: ['i1'] };

// regions: code-unit order is A(65) < z(122) < ä(228).
{
  const contract = createMemorySsaContract({
    functionId: 'f',
    regions: [region('z', 0n), region('ä', 8n), region('A', 16n)],
    definitions: [],
    uses: [],
  });
  assert.deepEqual(contract.regions.map((r) => r.id), ['A', 'z', 'ä'],
    `canonical id order must be code-unit order, got ${contract.regions.map((r) => r.id).join(',')}`);
}

// insertion order does not matter (same canonical representation either way)
{
  const one = createMemorySsaContract({
    functionId: 'f',
    regions: [region('z', 0n), region('ä', 8n), region('A', 16n)],
    definitions: [],
    uses: [],
  });
  const two = createMemorySsaContract({
    functionId: 'f',
    regions: [region('A', 16n), region('ä', 8n), region('z', 0n)],
    definitions: [],
    uses: [],
  });
  assert.deepEqual(one.regions.map((r) => r.id), two.regions.map((r) => r.id));
}

// definitions and uses: same comparator discipline via normalized records.
{
  const contract = createMemorySsaContract({
    functionId: 'f',
    regions: [region('r1', 0n), region('r2', 8n)],
    definitions: [
      { id: 'd_z', kind: 'memory-def', regionId: 'r1', blockId: 'b0', sourceEntityId: 's1', origin },
      { id: 'd_A', kind: 'memory-def', regionId: 'r2', blockId: 'b0', sourceEntityId: 's1', origin },
    ],
    uses: [
      { id: 'u_z', regionId: 'r1', reachingDefinitionId: 'd_z', sourceEntityId: 's2', origin },
      { id: 'u_A', regionId: 'r2', reachingDefinitionId: 'd_A', sourceEntityId: 's2', origin },
    ],
  });
  assert.deepEqual(contract.definitions.map((d) => d.id), ['d_A', 'd_z']);
  assert.deepEqual(contract.uses.map((u) => u.id), ['u_A', 'u_z']);
  assert.deepEqual(contract.reachingDefinitionLinks.map((l) => l.useId), ['u_A', 'u_z']);
}

console.log('issue-5756 memory-ssa canonical ordering is locale-invariant: ok');
