import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticSsa } from '../js/semantics/ssa/build.js';
import { getDefinitionForUse } from '../js/semantics/ssa/queries.js';
import { validateSemanticSsa } from '../js/semantics/ssa/validate.js';

const bit64 = Object.freeze({ kind: 'bitvector', widthBits: 64 });
const origin = (id) => ({ operationIds: [id] });
const variableR = Object.freeze({
  key: 'R',
  kind: 'physical-state',
  scope: 'function',
  physicalIdentity: { kind: 'register', registerId: 'x0' },
});

function entryValue(id, variableKey) {
  return { id, kind: 'entry', variableKey, machineType: bit64, origin: origin(`value:${id}`) };
}

function definitionValue(id, definitionNodeId) {
  return { id, kind: 'definition', definitionNodeId, machineType: bit64, origin: origin(`value:${id}`) };
}

function stateRead(id, outputId) {
  return {
    id, kind: 'state-read', blockId: 'b0', inputs: [], outputs: [outputId],
    variable: variableR, completeness: 'complete', origin: origin(`node:${id}`),
  };
}

function unknownStateWrite(id) {
  return {
    id, kind: 'unknown-state-write', blockId: 'b0', inputs: [], outputs: [],
    unknown: { reason: 'state effect unavailable', categories: ['state'] },
    completeness: 'unknown', origin: origin(`node:${id}`),
  };
}

function returnNode(id) {
  return { id, kind: 'return', blockId: 'b0', inputs: [], outputs: [], completeness: 'complete', origin: origin(`node:${id}`) };
}

function singleBlockIr({ nodes, values, completeness, unknowns }) {
  return {
    functionId: 'function_5239',
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map((node) => node.id), origin: origin('block:b0') }],
    values,
    nodes,
    ...(completeness === undefined ? {} : { completeness }),
    ...(unknowns === undefined ? {} : { unknowns }),
    origin: origin('function:function_5239'),
  };
}

const cfg = { functionId: 'function_5239', entryBlockId: 'b0', blocks: [{ id: 'b0', successors: [] }] };

const counterexample = ({ completeness, unknowns }) => singleBlockIr({
  nodes: [stateRead('read-R', 'read-value')],
  values: [entryValue('r-entry', 'R'), definitionValue('read-value', 'read-R')],
  completeness,
  unknowns,
});

function reachingStateUse(ssa, sourceNodeId) {
  const stateUses = ssa.uses.filter((item) =>
    item.proof?.kind === 'renamed-use' && item.sourceEntityId === sourceNodeId);
  assert.equal(stateUses.length, 1, `exactly one renamed state use is expected for ${sourceNodeId}`);
  return stateUses[0];
}

function definitionFor(ssa, use) {
  return getDefinitionForUse(ssa, use);
}

test('#5239 complete IR keeps the exact entry reaching definition', () => {
  const ir = counterexample({});
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const reaching = definitionFor(ssa, reachingStateUse(ssa, 'read-R'));
  assert.equal(reaching.kind, 'entry');
  assert.equal(reaching.sourceEntityId, 'r-entry');
});

test('#5239 partial IR with a state function-level unknown must not connect the entry definition exactly to the read', () => {
  const ir = counterexample({
    completeness: 'partial',
    unknowns: [{ reason: 'function-region-not-lowered', categories: ['state'] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const reaching = definitionFor(ssa, reachingStateUse(ssa, 'read-R'));
  assert.notEqual(reaching.sourceEntityId, 'r-entry');
  assert.equal(reaching.kind, 'unknown');
  const seed = ssa.definitions.find((definition) => definition.kind === 'entry' && definition.sourceEntityId === 'r-entry');
  assert.ok(seed);
  assert.equal(
    ssa.uses.some((item) => item.valueId === seed.valueId),
    false,
    'no use may resolve to the entry seed across a function-level state unknown',
  );
});

test('#5239 declared non-state categories preserve exact state reaching (documented policy)', () => {
  for (const categories of [['memory'], ['control'], ['value'], ['faults']]) {
    const ir = counterexample({
      completeness: 'partial',
      unknowns: [{ reason: `region not lowered: ${categories[0]}`, categories }],
    });
    const ssa = buildSemanticSsa(ir, cfg);
    validateSemanticSsa(ssa, ir, cfg);
    const reaching = definitionFor(ssa, reachingStateUse(ssa, 'read-R'));
    assert.equal(reaching.kind, 'entry');
    assert.equal(reaching.sourceEntityId, 'r-entry');
  }
});

test('#5239 an empty function-level unknown category list fails closed to a conservative clobber', () => {
  const ir = counterexample({
    completeness: 'partial',
    unknowns: [{ reason: 'unspecified missing semantics', categories: [] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const reaching = definitionFor(ssa, reachingStateUse(ssa, 'read-R'));
  assert.equal(reaching.kind, 'unknown');
});

test('#5239 explicit node-local unknown-state-write broad clobber is not regressed', () => {
  const ir = singleBlockIr({
    nodes: [unknownStateWrite('unknown_write'), stateRead('read-R', 'read-value')],
    values: [entryValue('r-entry', 'R'), definitionValue('read-value', 'read-R')],
    completeness: 'partial',
    unknowns: [{ reason: 'state effect unavailable', categories: ['state'] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const reaching = definitionFor(ssa, reachingStateUse(ssa, 'read-R'));
  assert.equal(reaching.kind, 'unknown');
  assert.equal(reaching.sourceEntityId, 'unknown_write');
  assert.equal(reaching.proof.broadUnknown, true);
});

test('#5239 the partial-IR artifact exposes conservative unknown evidence to consumers', () => {
  const ir = counterexample({
    completeness: 'partial',
    unknowns: [{ reason: 'function-region-not-lowered', categories: ['state'] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const reaching = definitionFor(ssa, reachingStateUse(ssa, 'read-R'));
  assert.equal(reaching.proof.kind, 'unknown-state-definition');
  assert.equal(reaching.proof.transform.proofKind, 'conservative-state-clobber');
  assert.equal(reaching.proof.broadUnknown, true);
});

test('#5239 a function-level state unknown duplicating node-local evidence adds no synthetic clobber', () => {
  const ir = singleBlockIr({
    nodes: [
      stateRead('read-R', 'read-value'),
      {
        id: 'unknown_call', kind: 'call', blockId: 'b0', inputs: [], outputs: [], completeness: 'unknown',
        unknown: { reason: 'unresolved-call', categories: ['state'] },
        call: {
          targetValueIds: [], targetEntityIds: [], arguments: [], returns: [], stateReads: [], stateWrites: [],
          memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' }, determinism: 'unknown',
          summarySource: 'issue-5239-fixture',
          completeness: 'unknown', unknownEffects: { reason: 'unresolved-call', categories: ['state'] },
        },
        origin: origin('node:unknown_call'),
      },
    ],
    values: [entryValue('r-entry', 'R'), definitionValue('read-value', 'read-R')],
    completeness: 'partial',
    unknowns: [{ reason: 'unresolved-call', categories: ['state'] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const reaching = definitionFor(ssa, reachingStateUse(ssa, 'read-R'));
  assert.equal(reaching.kind, 'entry');
  assert.equal(reaching.sourceEntityId, 'r-entry');
  assert.equal(ssa.definitions.some((definition) => definition.sourceEntityId === '@function-level-state-unknown'), false);
});

test('#5239 a partial state-unknown function without state variables still yields a conservative unknown state definition', () => {
  const ir = singleBlockIr({
    nodes: [returnNode('return')],
    values: [],
    completeness: 'partial',
    unknowns: [{ reason: 'function-region-not-lowered', categories: ['state'] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  validateSemanticSsa(ssa, ir, cfg);
  const synthetic = ssa.definitions.find((definition) =>
    definition.kind === 'unknown' && definition.variableKey === '@unknown-state');
  assert.ok(synthetic, 'function-level state unknown must surface as a conservative unknown state definition');
});
