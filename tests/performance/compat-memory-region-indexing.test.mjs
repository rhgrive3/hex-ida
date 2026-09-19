import assert from 'node:assert/strict';
import test from 'node:test';

import { attachMemorySsa } from '../../js/semantics/compat/semantic-ir-v2-to-v1-memory.js';

function observedArray(values, counter, key) {
  return new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) counter[key]++;
      return Reflect.get(target, property, receiver);
    },
  });
}

function fixture(count) {
  const reads = { definitions: 0, uses: 0 };
  const regions = Array.from({ length: count }, (_, index) => ({
    id: `region_${index}`,
    kind: 'stack-fixed',
    functionId: 'function_fixture',
    offset: String(index * 8),
    widthBits: 64,
    origin: null,
  }));
  const definitions = observedArray(Array.from({ length: count }, (_, index) => ({
    id: `definition_${index}`,
    kind: 'memory-def',
    regionId: `region_${index}`,
    sourceEntityId: `store_${index}`,
    blockId: 'block',
    previousDefinitionIds: [],
    incoming: [],
    aliasRelation: 'must',
    origin: null,
  })), reads, 'definitions');
  const uses = observedArray(Array.from({ length: count }, (_, index) => ({
    id: `use_${index}`,
    regionId: `region_${index}`,
    sourceEntityId: `load_${index}`,
    reachingDefinitionId: `definition_${index}`,
    aliasRelation: 'must',
  })), reads, 'uses');
  const memorySsa = { functionId: 'function_fixture', regions, definitions, uses };
  const projected = {
    functionId: 'function_fixture',
    locations: new Map(),
    blocks: [{ memPhis: [] }],
    instructions: [],
    compat: {},
  };
  const valuesById = new Map();
  const instructionBySemanticId = new Map();
  for (let index = 0; index < count; index++) {
    const base = { id: 10000 + index, kind: 'arg', const: null };
    const store = {
      id: index * 2,
      op: 'store',
      block: 0,
      row: index * 2,
      args: [{ value: { id: 20000 + index } }],
      addr: { precise: true, base, index: null, disp: BigInt(index * 8), size: 8 },
    };
    const load = {
      id: index * 2 + 1,
      op: 'load',
      block: 0,
      row: index * 2 + 1,
      args: [],
      dst: { id: 30000 + index, uses: [] },
      addr: { precise: true, base, index: null, disp: BigInt(index * 8), size: 8 },
    };
    projected.instructions.push(store, load);
    instructionBySemanticId.set(`store_${index}`, store);
    instructionBySemanticId.set(`load_${index}`, load);
  }
  return { reads, memorySsa, projected, valuesById, instructionBySemanticId };
}

test('compat MemorySSA projection indexes representative region addresses once', () => {
  const count = 240;
  const f = fixture(count);
  attachMemorySsa(
    f.projected,
    f.memorySsa,
    f.valuesById,
    f.instructionBySemanticId,
    new Map([['block', 0]]),
  );

  assert.equal(f.projected.locations.size, count);
  assert.equal(f.projected.locations.get('stack:0')?.disp, 0n);
  assert.equal(f.projected.locations.get(`stack:${String((count - 1) * 8)}`)?.disp, BigInt((count - 1) * 8));
  // The legacy helper rescans definitions from the beginning once per region,
  // producing >29k indexed reads for this fixture. The indexed path remains
  // linear in definitions + uses + the later attachment passes.
  assert.ok(f.reads.definitions < count * 6,
    `compat region projection performed ${f.reads.definitions} definition reads`);
  assert.ok(f.reads.uses < count * 4,
    `compat region projection performed ${f.reads.uses} use reads`);
});
