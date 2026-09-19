import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

const bit64 = { kind:'bitvector', widthBits:64 };
const bit1 = { kind:'predicate', widthBits:1 };
const origin = (id) => ({ instructionIds:[`instruction_${id}`], operationIds:[`operation_${id}`],
  virtualRanges:[{ start:0x1000n, end:0x1004n }], parentEntityIds:[`parent_${id}`] });

function fixture(count = 64) {
  const values = [
    { id:'lhs', kind:'entry', machineType:bit64, sourceEntityId:'function', origin:origin('lhs') },
    { id:'rhs', kind:'entry', machineType:bit64, sourceEntityId:'function', origin:origin('rhs') },
    { id:'flag', kind:'entry', machineType:bit1, sourceEntityId:'function', origin:origin('flag') },
  ];
  const nodes = [];
  const variable = { key:'flag:z', kind:'physical-state', scope:'function', physicalIdentity:{ kind:'flag', flagId:'z' } };
  for (let index = 0; index < count; index += 1) {
    const result = `result_${index}`;
    values.push({ id:result, kind:'definition', machineType:bit64, definitionNodeId:`binary_${index}`,
      sourceEntityId:`binary_${index}`, origin:origin(`pair_${index}`) });
    nodes.push(
      { id:`binary_${index}`, kind:'binary', blockId:'entry', inputs:['lhs','rhs'], outputs:[result], operator:'add', origin:origin(`pair_${index}`) },
      { id:`flag_write_${index}`, kind:'state-write', blockId:'entry', inputs:['flag'], outputs:[], variable, origin:origin(`pair_${index}`) },
    );
  }
  return { schemaVersion:2, contractVersion:'2.0.0', functionId:'compat_index_fixture', entryBlockId:'entry',
    blocks:[{ id:'entry', nodeIds:nodes.map((node) => node.id), origin:origin('entry') }], values, nodes,
    completeness:'complete', unknowns:[], origin:origin('function') };
}

test('compat projection indexes consumer/state-write facts instead of rescanning all IR nodes per arithmetic node', () => {
  const ir = fixture();
  const nodeCount = ir.nodes.length;
  const originalSome = Array.prototype.some;
  let fullNodeScans = 0;
  Array.prototype.some = function patchedSome(...args) {
    if (this.length === nodeCount) fullNodeScans += 1;
    return Reflect.apply(originalSome, this, args);
  };
  let projected;
  try {
    projected = projectSemanticIrV2ToLegacyV1(ir);
  } finally {
    Array.prototype.some = originalSome;
  }
  assert.equal(projected.instructions.length, nodeCount);
  assert.ok(fullNodeScans <= 2, `projection performed ${fullNodeScans} full-node Array#some scans`);
});
