import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSemanticIrV2ToLegacyV1, SEMANTIC_IR_V2_V1_COMPAT } from '../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { createSemanticNode } from '../js/semantics/ir/nodes.js';
import { createSemanticIrFunction } from '../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../js/semantics/ssa/index.js';

// A node-local `unknown` payload is explicit evidence of an unresolved
// semantic dimension. The constructor only enforced "partial requires
// unknown", never the reverse, so an ordinary node could claim
// completeness while carrying unknown detail — and the function validator
// did not look at node.unknown either (#5390).

const STATE_UNKNOWN = Object.freeze({
  reason: 'state-effect-not-recovered',
  categories: ['state'],
});

const value = (id, variableKey) => ({
  id,
  kind: 'entry',
  machineType: { kind: 'bitvector', widthBits: 32 },
  variableKey,
  origin: { instructionIds: [`${id}-origin`] },
});

const definitionValue = () => ({
  id: 'y',
  kind: 'definition',
  machineType: { kind: 'bitvector', widthBits: 32 },
  definitionNodeId: 'n1',
  variableKey: 'y',
  origin: { instructionIds: ['y-origin'] },
});

const copyNode = (overrides = {}) => ({
  id: 'n1',
  kind: 'copy',
  blockId: 'entry',
  inputs: ['x'],
  outputs: ['y'],
  completeness: 'complete',
  origin: { instructionIds: ['i1'] },
  ...overrides,
});

const functionInput = ({ node = copyNode(), completeness = 'complete', unknowns = [] } = {}) => ({
  functionId: 'f',
  entryBlockId: 'entry',
  blocks: [{ id: 'entry', nodeIds: ['n1'], origin: {} }],
  values: [value('x', 'x'), definitionValue()],
  nodes: [node],
  completeness,
  unknowns,
  origin: { instructionIds: ['i1'] },
});

const partialFunction = () => createSemanticIrFunction(functionInput({
  node: copyNode({ completeness: 'partial', unknown: STATE_UNKNOWN }),
  completeness: 'partial',
  unknowns: [STATE_UNKNOWN],
}));

test('#5390: an ordinary complete node cannot carry an unknown payload', () => {
  assert.throws(
    () => createSemanticNode(copyNode({ unknown: STATE_UNKNOWN })),
    /semantic-ir-unknown-detail-on-complete-node/,
  );
});

test('#5390: ordinary complete node and function without unknown evidence stay valid', () => {
  const node = createSemanticNode(copyNode());
  assert.equal(node.completeness, 'complete');
  assert.equal(node.unknown, null);

  const ir = createSemanticIrFunction(functionInput());
  assert.equal(ir.completeness, 'complete');
  assert.equal(ir.nodes[0].completeness, 'complete');
  assert.equal(ir.nodes[0].unknown, null);
});

test('#5390: ordinary partial node without unknown detail stays rejected', () => {
  assert.throws(
    () => createSemanticNode(copyNode({ completeness: 'partial' })),
    /semantic-ir-partial-node-requires-unknown-detail/,
  );
});

test('#5390: ordinary partial node with unknown detail stays valid', () => {
  const node = createSemanticNode(copyNode({
    completeness: 'partial',
    unknown: STATE_UNKNOWN,
  }));
  assert.equal(node.completeness, 'partial');
  assert.equal(node.unknown.reason, STATE_UNKNOWN.reason);
});

test('#5390: partial function with partial node and explicit unknown detail stays valid', () => {
  const ir = partialFunction();
  assert.equal(ir.completeness, 'partial');
  assert.equal(ir.nodes[0].completeness, 'partial');
  assert.equal(ir.nodes[0].unknown.reason, STATE_UNKNOWN.reason);
  assert.deepEqual(ir.unknowns[0].categories, ['state']);
});

test('#5390: a function containing a node-local unknown cannot claim complete', () => {
  assert.throws(
    () => createSemanticIrFunction(functionInput({
      node: copyNode({
        completeness: 'partial',
        unknown: STATE_UNKNOWN,
      }),
    })),
    /semantic-ir-completeness-conflict/,
    'the function-level complete guard must see node-local unknown payloads',
  );
});

test('#5390: SSA and v2-to-v1 projection both stay conservative for valid partial state unknowns', () => {
  const ir = partialFunction();
  const cfg = {
    functionId: ir.functionId,
    entryBlockId: ir.entryBlockId,
    blocks: [{ id: 'entry', successors: [] }],
  };
  const ssa = buildSemanticSsa(ir, cfg);
  const stateUnknown = ssa.definitions.find((definition) =>
    definition.kind === 'unknown'
      && definition.sourceEntityId === 'n1'
      && definition.proof?.kind === 'unknown-state-definition'
      && definition.proof?.broadUnknown === true);
  assert.ok(stateUnknown, 'SSA must conservatively clobber state for node-local state unknown evidence');

  const projected = projectSemanticIrV2ToLegacyV1(ir, { ssa });
  const compatUnknown = projected.instructions.find((instruction) => instruction.extra?.functionUnknown === true);
  assert.equal(projected.truncated, true);
  assert.ok(compatUnknown, 'v2-to-v1 projection must expose partial function uncertainty');
  assert.equal(compatUnknown.op, SEMANTIC_IR_V2_V1_COMPAT.legacyOps.UNKNOWN);
  assert.deepEqual(compatUnknown.extra.unknownCategories, ['state']);
});
