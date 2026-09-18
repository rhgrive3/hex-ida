import assert from 'node:assert/strict';
import test from 'node:test';
import { ALIAS_QUERIES, ALIAS_QUERIES_V2, buildFixture } from '../corpus/fixtures.mjs';

// Concrete witnesses are independent of the alias solver. The fixture reads
// incoming SP and x0 without a fresh allocation or a disjointness precondition.
test('C1 frame truth admits both overlapping and disjoint incoming addresses', () => {
  const { ir } = buildFixture('frame-non-escaping');
  const nodes = new Map(ir.nodes.map(node => [node.id, node]));
  assert.equal(nodes.get('node_sp').variable.key, 'state:sp');
  assert.equal(nodes.get('node_arg').variable.key, 'state:x0');
  assert.equal(nodes.get('node_c0').attributes.constant.value, '0');
  assert.equal(nodes.get('node_slot').operator, 'add');
  assert.deepEqual(nodes.get('node_slot').inputs, ['sp', 'c0']);
  assert.deepEqual([...nodes.keys()].sort(), [
    'node_arg', 'node_c0', 'node_r', 'node_slot', 'node_sp', 'node_st_arg', 'node_st_slot',
  ]);
  for (const [id, address] of [['node_st_slot', 'slot'], ['node_st_arg', 'arg']]) {
    assert.equal(nodes.get(id).kind, 'store');
    assert.equal(nodes.get(id).memory.addressExpr.valueId, address);
    assert.equal(nodes.get(id).memory.widthBits, 32);
    assert.equal(nodes.get(id).memory.endian, 'little');
  }
  for (const [arg, overlaps] of [[64, true], [66, true], [128, false]]) {
    const memory = new DataView(new ArrayBuffer(256));
    const slot = 64 + 0;
    memory.setUint32(slot, 0x11223344, true);
    memory.setUint32(arg, 0xaabbccdd, true);
    assert.equal(memory.getUint32(slot, true) !== 0x11223344, overlaps);
  }
  const v1 = ALIAS_QUERIES.find(query => query.id === 'q-frame-non-escaping');
  const v2 = ALIAS_QUERIES_V2.find(query => query.id === 'v2-frame-non-escaping');
  assert.equal(v1.truth, 'may-or-weaker');
  assert.equal(v1.expectStrong, false);
  assert.equal(v2.truth, 'may');
  assert.equal(ALIAS_QUERIES_V2.length, 30, 'truth correction cannot remove a query');
});

for (const [id, fixture, left, right] of [
  ['v2-callee-ret', 'callee-returned-pointer', 'node_st_callee_slot', 'node_st_callee_ret'],
  ['v2-tls-vs-stack', 'tls-vs-stack', 'node_st_tls_root', 'node_st_sp_root'],
]) {
  test(`C1 ${id} cannot exclude coincident incoming addresses`, () => {
    const f = buildFixture(fixture);
    const nodes = new Map(f.ir.nodes.map(node => [node.id, node]));
    for (const nodeId of [left, right]) {
      assert.equal(nodes.get(nodeId).memory.addressSpace, 'memory');
      assert.equal(nodes.get(nodeId).memory.widthBits, 32);
    }
    if (id === 'v2-callee-ret') {
      const sequence = f.ir.blocks[0].nodeIds;
      assert.ok(sequence.indexOf('node_retVal') < sequence.indexOf('node_call_helper'));
      assert.equal(nodes.get('node_retVal').kind, 'state-read');
      assert.equal(nodes.get('node_retVal').variable.key, 'state:x0');
      assert.deepEqual(nodes.get('node_call_helper').call.returns, []);
    } else {
      assert.equal(nodes.get('node_tls').variable.key, 'state:tpidr_el0');
      assert.deepEqual(f.rootDescriptors['variable:state:sp'], {
        kind: 'stack-like', baseOffset: 0, addressSpace: 'memory', linearOffsets: true,
      });
    }
    // Same address space, unconstrained incoming bases, zero offsets, 4 bytes.
    for (const [other, overlaps] of [[64, true], [128, false]]) {
      const memory = new DataView(new ArrayBuffer(256));
      memory.setUint32(64, 1, true);
      memory.setUint32(other, 2, true);
      assert.equal(memory.getUint32(64, true) === 2, overlaps);
    }
    assert.equal(ALIAS_QUERIES_V2.find(query => query.id === id).truth, 'may');
  });
}

test('conditional corpus branches keep an unconstrained canonical predicate', () => {
  const { ir } = buildFixture('phi-same-root-merge');
  const branch = ir.nodes.find(node => node.kind === 'conditional-branch');
  assert.equal(branch.inputs.length, 1);
  const predicate = ir.values.find(value => value.id === branch.inputs[0]);
  assert.equal(predicate.kind, 'entry');
  assert.deepEqual(predicate.machineType, { kind: 'predicate', widthBits: 1 });
  assert.equal(branch.targets.length, 2);
});
