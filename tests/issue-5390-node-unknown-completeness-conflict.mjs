import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticNode } from '../js/semantics/ir/nodes.js';
import { createSemanticIrFunction } from '../js/semantics/ir/function.js';

// A node-local `unknown` payload is explicit evidence of an unresolved
// semantic dimension. The constructor only enforced "partial requires
// unknown", never the reverse, so an ordinary node could claim
// completeness while carrying unknown detail — and the function validator
// did not look at node.unknown either (#5390).

const value = (id, variableKey) => ({
  id,
  kind: 'entry',
  machineType: { kind: 'bitvector', widthBits: 32 },
  variableKey,
  origin: { instructionIds: [`${id}-origin`] },
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

test('#5390: an ordinary complete node cannot carry an unknown payload', () => {
  assert.throws(
    () => createSemanticNode(copyNode({
      unknown: { reason: 'state-effect-not-recovered', categories: ['state'] },
    })),
    /semantic-ir-unknown-detail-on-complete-node/,
  );
});

test('#5390: ordinary partial node with unknown detail stays valid', () => {
  const node = createSemanticNode(copyNode({
    completeness: 'partial',
    unknown: { reason: 'state-effect-not-recovered', categories: ['state'] },
  }));
  assert.equal(node.completeness, 'partial');
  assert.equal(node.unknown.reason, 'state-effect-not-recovered');
});

test('#5390: a function containing a node-local unknown cannot claim complete', () => {
  assert.throws(
    () => createSemanticIrFunction({
      functionId: 'f',
      entryBlockId: 'entry',
      blocks: [{ id: 'entry', nodeIds: ['n1'], origin: {} }],
      values: [value('x', 'x'), {
        id: 'y',
        kind: 'definition',
        machineType: { kind: 'bitvector', widthBits: 32 },
        definitionNodeId: 'n1',
        variableKey: 'y',
        origin: { instructionIds: ['y-origin'] },
      }],
      nodes: [copyNode({
        completeness: 'partial',
        unknown: { reason: 'state-effect-not-recovered', categories: ['state'] },
      })],
      completeness: 'complete',
      unknowns: [],
      origin: { instructionIds: ['i1'] },
    }),
    /semantic-ir-completeness-conflict/,
    'the function-level complete guard must see node-local unknown payloads',
  );
});
