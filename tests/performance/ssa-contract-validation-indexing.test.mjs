import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { buildSemanticSsa } from '../../js/semantics/ssa/build.js';
import { createSemanticSsaContract } from '../../js/semantics/ssa/contract.js';
import { validateSemanticSsa } from '../../js/semantics/ssa/validate.js';

const origin = { instructionIds: ['instruction_fixture'] };

// Regression: PHI contract validation used to rescan cfg.blocks once to pick the
// virtual-entry name and again to find the PHI block for every PHI definition.
// A function with many SSA variables joining in the same block therefore did
// Θ(phi definitions × CFG blocks) array work even though the CFG is immutable.
test('SSA PHI contract reuses immutable CFG predecessor facts instead of rescanning every PHI', () => {
  const paddingBlocks = 300;
  const phiCount = 100;
  const cfg = createSemanticCfg({ functionId: 'function_fixture', entryBlockId: 'entry', blocks: [
    { id: 'entry', successors: [{ to: 'left', kind: 'conditional-true' }, { to: 'right', kind: 'conditional-false' }] },
    { id: 'left', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'right', successors: [{ to: 'join', kind: 'branch' }] },
    ...Array.from({ length: paddingBlocks }, (_, index) => ({ id: `pad_${String(index).padStart(5, '0')}`, successors: [] })),
    { id: 'join', successors: [] },
  ] });

  let indexedReads = 0;
  const blocks = new Proxy(cfg.blocks, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  Object.freeze(blocks);
  const observedCfg = Object.freeze({ ...cfg, blocks });
  const definitions = [
    { definitionId: 'def_left', valueId: 'value_left', kind: 'definition', blockId: null, sourceEntityId: 'entity_left', origin },
    { definitionId: 'def_right', valueId: 'value_right', kind: 'definition', blockId: null, sourceEntityId: 'entity_right', origin },
    ...Array.from({ length: phiCount }, (_, index) => ({
      definitionId: `def_phi_${index}`,
      valueId: `value_phi_${index}`,
      kind: 'phi',
      blockId: 'join',
      sourceEntityId: `entity_phi_${index}`,
      incoming: [
        { predecessorBlockId: 'left', valueId: 'value_left' },
        { predecessorBlockId: 'right', valueId: 'value_right' },
      ],
      origin,
    })),
  ];

  const ssa = createSemanticSsaContract({ functionId: 'function_fixture', definitions, uses: [] }, { cfg: observedCfg });
  assert.equal(ssa.definitions.length, phiCount + 2);
  // The old implementation performs >33k indexed cfg.blocks reads here; the
  // indexed path stays linear in CFG size plus one dominance analysis.
  assert.ok(indexedReads < 6000, `PHI validation performed ${indexedReads} indexed cfg.blocks reads`);
});

function manyVariableFixture(count) {
  const bit32 = { kind: 'bitvector', widthBits: 32 };
  const opOrigin = (id) => ({ operationIds: [id] });
  const variable = (key) => ({ key, kind: 'logical-state', scope: 'function' });
  const values = [];
  const nodes = [];
  for (let index = 0; index < count; index++) {
    const sourceId = `source_${index}`;
    const readId = `read_${index}`;
    const readValueId = `read_value_${index}`;
    const key = `state.variable.${String(index).padStart(5, '0')}`;
    values.push(
      { id: sourceId, kind: 'entry', machineType: bit32, sourceEntityId: `entity:${sourceId}`, origin: opOrigin(`value:${sourceId}`) },
      { id: readValueId, kind: 'definition', machineType: bit32, definitionNodeId: readId, sourceEntityId: `entity:${readValueId}`, origin: opOrigin(`value:${readValueId}`) },
    );
    nodes.push(
      { id: `write_${index}`, kind: 'state-write', blockId: 'entry', inputs: [sourceId], outputs: [], variable: variable(key), origin: opOrigin(`node:write_${index}`) },
      { id: readId, kind: 'state-read', blockId: 'entry', inputs: [], outputs: [readValueId], variable: variable(key), origin: opOrigin(`node:${readId}`) },
    );
  }
  nodes.push({ id: 'return', kind: 'return', blockId: 'entry', inputs: [], outputs: [], origin: opOrigin('node:return') });
  const ir = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'function_fixture',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: nodes.map((node) => node.id), origin: opOrigin('block:entry') }],
    nodes,
    values,
    completeness: 'complete',
    unknowns: [],
    origin: opOrigin('function:fixture'),
  };
  const cfg = { functionId: 'function_fixture', entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [] }] };
  return { ir, cfg };
}

// Regression: validateSemanticSsa() filtered the complete definition array
// three times per variable key (placement, actual PHIs, type collision), making
// independent-variable validation quadratic. Grouping once preserves the exact
// checks while keeping full-array filtering constant.
test('SSA validator groups definitions once instead of filtering the full contract per variable', () => {
  const { ir, cfg } = manyVariableFixture(120);
  const ssa = buildSemanticSsa(ir, cfg);
  const definitionCount = ssa.definitions.length;
  let fullDefinitionFilters = 0;
  const originalFilter = Array.prototype.filter;
  Array.prototype.filter = function (...args) {
    if (this.length === definitionCount) fullDefinitionFilters++;
    return originalFilter.apply(this, args);
  };
  try {
    const validated = validateSemanticSsa(ssa, ir, cfg);
    assert.equal(validated.definitions.length, definitionCount);
  } finally {
    Array.prototype.filter = originalFilter;
  }
  // The old validator performs 362 full-definition filters for this fixture.
  assert.ok(fullDefinitionFilters <= 4,
    `SSA validation filtered the ${definitionCount}-definition array ${fullDefinitionFilters} times`);
});
