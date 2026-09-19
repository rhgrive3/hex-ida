import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticSsa } from '../../js/semantics/ssa/build.js';
import {
  getDefinitionsForVariable, getSsaDefinition, getSsaDefinitionById, getSsaUse,
  getUsesForValue, getSsaDefinitionForSemanticValue, getSsaUseForSemanticValue,
} from '../../js/semantics/ssa/queries.js';

function canonicalFixture(count = 128) {
  const bit32 = { kind: 'bitvector', widthBits: 32 };
  const origin = (id) => ({ operationIds: [id] });
  const variable = (key) => ({ key, kind: 'logical-state', scope: 'function' });
  const values = [];
  const nodes = [];
  for (let index = 0; index < count; index += 1) {
    const sourceId = `source_${index}`;
    const readId = `read_${index}`;
    const readValueId = `read_value_${index}`;
    const key = `state.variable.${String(index % 16).padStart(2, '0')}`;
    values.push(
      { id: sourceId, kind: 'entry', machineType: bit32, sourceEntityId: `entity:${sourceId}`, origin: origin(`value:${sourceId}`) },
      { id: readValueId, kind: 'definition', machineType: bit32, definitionNodeId: readId, sourceEntityId: `entity:${readValueId}`, origin: origin(`value:${readValueId}`) },
    );
    nodes.push(
      { id: `write_${index}`, kind: 'state-write', blockId: 'entry', inputs: [sourceId], outputs: [], variable: variable(key), origin: origin(`node:write_${index}`) },
      { id: readId, kind: 'state-read', blockId: 'entry', inputs: [], outputs: [readValueId], variable: variable(key), origin: origin(`node:${readId}`) },
    );
  }
  nodes.push({ id: 'return', kind: 'return', blockId: 'entry', inputs: [], outputs: [], origin: origin('node:return') });
  const ir = {
    schemaVersion: 2, contractVersion: '2.0.0', functionId: 'function_query_fixture', entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: nodes.map((node) => node.id), origin: origin('block:entry') }],
    nodes, values, completeness: 'complete', unknowns: [], origin: origin('function:fixture'),
  };
  const cfg = { functionId: ir.functionId, entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [] }] };
  return buildSemanticSsa(ir, cfg);
}

test('canonical SSA query helpers reuse one index instead of repeated linear find/filter scans', () => {
  const ssa = canonicalFixture();
  const expectedDefinitionBySemantic = new Map();
  const expectedUseBySemantic = new Map();
  for (const definition of ssa.definitions) {
    const id = definition.proof?.sourceSemanticValueId;
    if (id != null && !expectedDefinitionBySemantic.has(id)) expectedDefinitionBySemantic.set(id, definition);
  }
  for (const use of ssa.uses) {
    const id = use.proof?.sourceSemanticValueId;
    if (id != null && !expectedUseBySemantic.has(id)) expectedUseBySemantic.set(id, use);
  }
  const originalFind = Array.prototype.find;
  const originalFilter = Array.prototype.filter;
  let findCalls = 0;
  let filterCalls = 0;
  Array.prototype.find = function patchedFind(...args) {
    if (this === ssa.definitions || this === ssa.uses) findCalls += 1;
    return Reflect.apply(originalFind, this, args);
  };
  Array.prototype.filter = function patchedFilter(...args) {
    if (this === ssa.definitions || this === ssa.uses) filterCalls += 1;
    return Reflect.apply(originalFilter, this, args);
  };
  try {
    for (const definition of ssa.definitions) {
      assert.equal(getSsaDefinition(ssa, definition.valueId), definition);
      assert.equal(getSsaDefinitionById(ssa, definition.definitionId), definition);
      const semanticValueId = definition.proof?.sourceSemanticValueId;
      if (semanticValueId) assert.equal(getSsaDefinitionForSemanticValue(ssa, semanticValueId), expectedDefinitionBySemantic.get(semanticValueId));
    }
    for (const use of ssa.uses) {
      assert.equal(getSsaUse(ssa, use.useId), use);
      assert.ok(getUsesForValue(ssa, use.valueId).includes(use));
      const semanticValueId = use.proof?.sourceSemanticValueId;
      if (semanticValueId) assert.equal(getSsaUseForSemanticValue(ssa, semanticValueId), expectedUseBySemantic.get(semanticValueId));
    }
    for (let index = 0; index < 16; index += 1) {
      const key = `state.variable.${String(index).padStart(2, '0')}`;
      assert.ok(getDefinitionsForVariable(ssa, key).length > 0);
    }
    for (let index = 0; index < 64; index += 1) {
      assert.equal(getSsaDefinition(ssa, `missing_value_${index}`), null);
      assert.equal(getSsaDefinitionById(ssa, `missing_definition_${index}`), null);
      assert.equal(getSsaUse(ssa, `missing_use_${index}`), null);
      assert.deepEqual(getDefinitionsForVariable(ssa, `missing_variable_${index}`), []);
      assert.equal(getSsaDefinitionForSemanticValue(ssa, `missing_semantic_definition_${index}`), null);
      assert.equal(getSsaUseForSemanticValue(ssa, `missing_semantic_use_${index}`), null);
    }
  } finally {
    Array.prototype.find = originalFind;
    Array.prototype.filter = originalFilter;
  }
  assert.equal(findCalls, 0, `canonical SSA queries fell back to ${findCalls} full find scans`);
  assert.equal(filterCalls, 0, `canonical SSA queries fell back to ${filterCalls} full filter scans`);
});

test('mutable and merely-frozen unbranded SSA inputs retain live observation semantics', () => {
  const definition = { definitionId:'definition_0', valueId:'before', variableKey:'variable', kind:'definition', blockId:'block' };
  const mutable = { definitions:[definition], uses:[] };
  assert.equal(getSsaDefinition(mutable, 'before'), definition);
  definition.valueId = 'after';
  assert.equal(getSsaDefinition(mutable, 'before'), null);
  assert.equal(getSsaDefinition(mutable, 'after'), definition);

  const frozenDefinition = Object.freeze({ definitionId:'definition_frozen', valueId:'frozen', variableKey:'variable', kind:'definition', blockId:'block' });
  const definitions = Object.freeze([frozenDefinition]);
  const uses = Object.freeze([]);
  let definitionsReads = 0;
  const frozenExternal = {};
  Object.defineProperties(frozenExternal, {
    definitions: { enumerable:true, get() { definitionsReads += 1; return definitions; } },
    uses: { enumerable:true, get() { return uses; } },
  });
  Object.freeze(frozenExternal);
  assert.equal(getSsaDefinition(frozenExternal, 'frozen'), frozenDefinition);
  const afterFirst = definitionsReads;
  assert.equal(getSsaDefinition(frozenExternal, 'frozen'), frozenDefinition);
  assert.ok(definitionsReads > afterFirst, 'unbranded frozen accessor input was unexpectedly cached');
});
