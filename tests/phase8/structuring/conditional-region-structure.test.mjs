import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../helpers/ir-fixtures.mjs';
import { identity } from '../helpers/proof-fixtures.mjs';
import { decompileSemantic, readSemanticConditionalRegions } from '../../../js/decompiler/semantic-core.js';
import { prepareConditionalRegionStructure, readConditionalRegionStructure } from '../../../js/decompiler/phase8/conditional-region-structure.js';
import { discoverPhase8Tests } from '../run.mjs';

function example(kind = 'diamond', mutate = () => {}, options = {}) {
  const f = fixture('structure'); f.block(0);
  const condition = f.opaque(1); condition.reg = 'x0';
  if (kind === 'empty') {
    f.conditionalBranch(condition, 2, 1); f.block(1); f.store(f.constant(4n, 8)); f.branch(2); f.block(2); f.ret();
  } else if (kind === 'nested') {
    f.conditionalBranch(condition, 1, 4); f.block(1); f.conditionalBranch(condition, 2, 3);
    f.block(2); f.store(f.constant(2n, 8)); f.branch(5);
    f.block(3); f.store(f.constant(3n, 8)); f.branch(5);
    f.block(4); f.store(f.constant(4n, 8)); f.branch(5); f.block(5); f.ret();
  } else if (kind === 'cycle') {
    f.conditionalBranch(condition, 1, 3);
    f.block(1); f.conditionalBranch(condition, 2, 3); f.block(2); f.branch(1); f.block(3); f.ret();
  } else {
    f.conditionalBranch(condition, 1, 2);
    f.block(1); const a = f.constant(1n, 8); f.store(a); f.branch(3);
    f.block(2); const b = f.constant(2n, 8); f.store(b); f.branch(3);
    f.block(3); if (kind !== 'join-foreign') f.phi([[1, a], [2, b]], 8);
    if (kind === 'join-effects') f.store(f.constant(9n, 8));
    f.ret();
    if (kind === 'foreign') { f.block(4); f.branch(1); }
    if (kind === 'join-foreign') { f.block(4); f.branch(3); f.blocks[4].successorEdges[0].kind = 'unwind'; }
  }
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => [...block.phis, ...block.insts]);
  ir.instructions.forEach((inst, index) => {
    inst.id = `structure_${index}`; inst.row = index; inst.address = 0x1000n + BigInt(index * 4);
    if (inst.op === 'cbr') inst.extra = { ...inst.extra, targetBlock:ir.blocks[inst.block].succ[0] };
  });
  for (const block of ir.blocks) { block.startRow = block.insts[0].row; block.endRow = block.insts.at(-1).row; }
  mutate(ir);
  const seed = decompileSemantic({ name:'structure', instructions:ir.instructions, calls:[] },
    { ir, deterministicTransforms:true, phase8PrepareRegionProof:true, ...options });
  const region = readSemanticConditionalRegions(seed)?.regions.find(item => item.selection.header === 0);
  return { ir, seed, region, run:extra => prepareConditionalRegionStructure(region?.record, ir, { identity, timeoutMs:5000, ...extra }) };
}

test('actual diamond census covers all arm edges, instructions and exact PHI predecessors', () => {
  const f = example(), result = f.run();
  assert.equal(result.status, 'complete', result.reason);
  assert.equal(readConditionalRegionStructure(result, f.ir, identity), result);
  assert.equal(result.transformAuthorization, false); assert.equal(result.semanticValidation, 'required');
  assert.deepEqual(result.arms.map(arm => arm.members.map(block => block.index)), [[1], [2]]);
  assert.deepEqual(result.edges.map(edge => [edge.from, edge.to]), [[0, 1], [0, 2], [1, 3], [2, 3]]);
  assert.deepEqual(result.joinIncomingEdges.map(edge => edge.from), [1, 2]);
  assert.deepEqual(result.phis[0].incoming.map(input => [input.predecessor.index, input.role]), [[1, 'yes'], [2, 'no']]);
  assert.equal(result.phis[0].phi, f.ir.blocks[3].phis[0]);
  assert.equal(result.phis[0].incoming[0].operand, f.ir.blocks[3].phis[0].incoming[0]);
  assert.equal(result.instructions.filter(inst => inst.op === 'store').length, 2);
  assert.ok(result.instructions.every(inst => f.ir.instructions.includes(inst)));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.phis[0].incoming));
});

test('nested arms are recounted transitively and empty inverted arms stay explicit', () => {
  const nested = example('nested').run();
  assert.equal(nested.status, 'complete', nested.reason);
  assert.deepEqual(nested.arms.map(arm => arm.members.map(block => block.index).sort()), [[1, 2, 3], [4]]);
  assert.equal(nested.edges.length, 7);
  const empty = example('empty').run();
  assert.equal(empty.status, 'complete', empty.reason);
  assert.equal(empty.region.selection.invert, true);
  assert.deepEqual(empty.arms.map(arm => arm.members.map(block => block.index)), [[], [1]]);
});

test('join effects and memory PHIs remain explicit unresolved semantic obligations', () => {
  const f = example('join-effects', ir => { ir.blocks[3].memPhis = [{ kind:'phi', id:'memory-join', incoming:[] }]; });
  const result = f.run(); assert.equal(result.status, 'complete', result.reason);
  assert.ok(f.ir.blocks[3].insts.every(inst => result.instructions.includes(inst)));
  assert.equal(result.instructions.filter(inst => inst.op === 'store').length, 3);
  assert.equal(result.memoryPhis[0].phi, f.ir.blocks[3].memPhis[0]);
  assert.equal(result.memoryPhis[0].validation, 'required');
  assert.equal(result.semanticValidation, 'required'); assert.equal(result.transformAuthorization, false);
  f.ir.blocks[3].memPhis[0].incoming.push({ from:1, value:'changed' });
  assert.equal(readConditionalRegionStructure(result, f.ir, identity), null);
});

test('false and fallthrough labels count once while retaining both original edge kinds', () => {
  const f = example('diamond', ir => ir.blocks[0].successorEdges.push({ to:2, kind:'fallthrough' }));
  const result = f.run(); assert.equal(result.status, 'complete', result.reason);
  assert.equal(result.edges.length, 4);
  assert.deepEqual(result.edges.find(edge => edge.from === 0 && edge.to === 2).kinds, ['conditional-false', 'fallthrough']);
});

test('an external incoming edge is rejected even when its source was not emitted', () => {
  const f = example('foreign'); assert.ok(f.region);
  assert.ok(!f.region.arms.flatMap(arm => arm.emittedBlocks).includes(f.ir.blocks[4]));
  const result = f.run();
  assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'foreign-region-entry');
});

test('an external unwind edge to the join is rejected even when there are no PHIs', () => {
  const f = example('join-foreign'); assert.ok(f.region); assert.equal(f.region.joinPhis.length, 0);
  const result = f.run();
  assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'nonordinary-join-entry');
});

test('a cyclic arm cannot be accepted by its finite emitted block inventory', () => {
  const f = example('cycle'); assert.ok(f.region);
  const result = f.run();
  assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'cyclic-region');
});

for (const [name, mutate, reason] of [
  ['truncated IR', ir => { ir.truncated = true; }, 'truncated-ir'],
  ['missing label', ir => { ir.blocks[1].successorEdges = []; }, 'missing-edge-label'],
  ['ambiguous header labels', ir => { for (const edge of ir.blocks[0].successorEdges) edge.kind = 'branch'; }, 'conditional-polarity-unavailable'],
  ['reversed header polarity', ir => { ir.blocks[0].successorEdges[0].kind = 'conditional-false'; ir.blocks[0].successorEdges[1].kind = 'conditional-true'; }, 'conditional-polarity-unavailable'],
  ['unwind', ir => { ir.blocks[1].successorEdges[0].kind = 'unwind'; }, 'nonordinary-region-edge'],
  ['extra successor label', ir => { ir.blocks[1].successorEdges.push({ to:2, kind:'branch' }); }, 'invalid-edge-label-inventory'],
  ['missing predecessor', ir => { ir.blocks[1].pred = []; }, 'predecessor-inventory-mismatch'],
  ['missing PHI incoming', ir => { ir.blocks[3].phis[0].incoming.pop(); }, 'phi-inventory-mismatch'],
  ['duplicate PHI predecessor', ir => { ir.blocks[3].phis[0].incoming[1].from = 1; }, 'phi-inventory-mismatch'],
  ['unowned PHI value', ir => { ir.blocks[3].phis[0].incoming[0].value = { ...ir.blocks[3].phis[0].incoming[0].value }; }, 'phi-inventory-mismatch'],
  ['unlisted instruction', ir => { ir.instructions.splice(ir.instructions.indexOf(ir.blocks[1].insts[0]), 1); }, 'instruction-inventory-mismatch'],
  ['wrong instruction block', ir => { ir.blocks[1].insts.find(inst => inst.op === 'store').block = 2; }, 'instruction-inventory-mismatch'],
  ['wrong PHI block', ir => { ir.blocks[3].phis[0].block = 2; }, 'phi-inventory-mismatch'],
]) test(`incomplete structural data never issues a capability: ${name}`, () => {
  const f = example('diamond', mutate); assert.ok(f.region, 'real emitter must still issue the tested span');
  const result = f.run(); assert.equal(result.status, 'incomplete'); assert.equal(result.reason, reason);
  assert.equal(readConditionalRegionStructure(result, f.ir, identity), null);
});

test('clones, changed query identity and original mutations revoke structural capabilities', () => {
  for (const mutate of [
    f => { f.region.close.text = '// changed'; },
    f => { f.ir.blocks[1].successorEdges[0].kind = 'unwind'; },
    f => { f.ir.blocks[3].phis[0].incoming[0].from = 2; },
    f => { f.ir.blocks[3].phis = [{ ...f.ir.blocks[3].phis[0] }]; },
    f => { f.ir.blocks[1].insts.find(inst => inst.op === 'store').extra.memoryAccess.ordering = 'release'; },
  ]) {
    const f = example(), result = f.run(); assert.equal(result.status, 'complete');
    assert.equal(readConditionalRegionStructure({ ...result }, f.ir, identity), null);
    assert.equal(readConditionalRegionStructure(result, { ...f.ir }, identity), null);
    assert.equal(readConditionalRegionStructure(result, f.ir, { ...identity, snapshotId:'other' }), null);
    mutate(f); assert.equal(readConditionalRegionStructure(result, f.ir, identity), null);
    assert.equal(f.run().status, 'incomplete');
  }
});

test('limits and cancellation reject; a final callback mutation cannot race freshness', () => {
  for (const limits of [{ blocks:0 }, { edges:0 }, { workItems:0 }, { allocationUnits:0 }]) {
    const f = example(), result = f.run({ limits });
    assert.equal(result.status, 'incomplete'); assert.match(result.reason, /^budget:/);
  }
  const f = example(), controller = new AbortController(), result = f.run({ signal:controller.signal });
  assert.equal(result.status, 'complete'); controller.abort();
  assert.equal(readConditionalRegionStructure(result, f.ir, identity), null);
  let armed = false, original;
  const g = example('diamond', () => {}, { shouldAbort:() => {
    if (armed) original.ir.blocks[0].succ.reverse();
    return false;
  } }); original = g;
  const issued = g.run(); assert.equal(issued.status, 'complete'); armed = true;
  assert.equal(readConditionalRegionStructure(issued, g.ir, identity), null);
});

test('canonical Phase 8 discovery includes the region structure regression exactly once', () => {
  assert.equal(discoverPhase8Tests().filter(path => path.endsWith('/structuring/conditional-region-structure.test.mjs')).length, 1);
});
