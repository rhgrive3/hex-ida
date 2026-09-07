import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

const origin = { instructionIds: ['undefined-result-node-kind'] };
const descriptor = () => ({
  widthBits: 8,
  mask: '0xff',
  class: 'fully',
  reason: 'node-kind-boundary',
});

function functionIr(nodes, values = []) {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'undefined-result-node-kind-function',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: nodes.map((node) => node.id) }],
    values,
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin,
  };
}

function entryValue(id, machineType) {
  return { id, kind: 'entry', machineType, origin };
}

function storeNode() {
  return {
    id: 'store-with-undefined-result',
    kind: 'store',
    blockId: 'entry',
    inputs: ['address', 'stored'],
    outputs: [],
    memory: {
      addressSpace: 'memory',
      addressExpr: { valueId: 'address' },
      widthBits: 8,
      endian: 'little',
      alignment: null,
      volatility: false,
      atomic: false,
      ordering: 'unknown',
      faults: [],
    },
    attributes: { machineEffects: { undefinedResult: descriptor() } },
    completeness: 'complete',
    origin,
  };
}

function callNode() {
  return {
    id: 'call-with-undefined-result',
    kind: 'call',
    blockId: 'entry',
    inputs: [],
    outputs: [],
    call: {
      targetValueIds: [],
      targetEntityIds: [],
      arguments: [],
      returns: [],
      stateReads: [],
      stateWrites: [],
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'all', addressSpaces: ['memory'] },
      controlEffects: [],
      determinism: 'deterministic',
      noreturn: false,
      mayThrow: false,
      summarySource: 'undefined-result-node-kind-test',
      completeness: 'complete',
      unknownEffects: null,
    },
    attributes: { machineEffects: { undefinedResult: descriptor() } },
    completeness: 'complete',
    origin,
  };
}

test('undefined-result descriptors on stores and calls are rejected before projection', () => {
  const values = [
    entryValue('address', { kind: 'address', widthBits: 64, addressSpace: 'memory' }),
    entryValue('stored', { kind: 'bitvector', widthBits: 8 }),
  ];
  for (const node of [storeNode(), callNode()]) {
    assert.throws(
      () => projectSemanticIrV2ToLegacyV1(functionIr([node], values)),
      (error) => error?.message === 'semantic-undefined-result-node-kind',
      node.kind,
    );
  }
});

test('undefined-result node-kind validation does not invoke a hostile kind accessor', () => {
  const node = storeNode();
  Object.defineProperty(node, 'kind', {
    enumerable: true,
    get() { throw new Error('kind getter must not run'); },
  });
  assert.throws(
    () => projectSemanticIrV2ToLegacyV1(functionIr([node], [
      entryValue('address', { kind: 'address', widthBits: 64, addressSpace: 'memory' }),
      entryValue('stored', { kind: 'bitvector', widthBits: 8 }),
    ])),
    (error) => error?.message === 'semantic-undefined-result-accessor',
  );
});

test('legal load and intrinsic undefined-result attachments remain conservative and transported', () => {
  const address = entryValue('address', { kind: 'address', widthBits: 64, addressSpace: 'memory' });
  const loaded = { id: 'loaded', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 8 }, definitionNodeId: 'load', origin };
  const load = {
    id: 'load',
    kind: 'load',
    blockId: 'entry',
    inputs: ['address'],
    outputs: ['loaded'],
    memory: {
      addressSpace: 'memory',
      addressExpr: { valueId: 'address' },
      widthBits: 8,
      endian: 'little',
      alignment: null,
      volatility: false,
      atomic: false,
      ordering: 'unknown',
      faults: [],
    },
    attributes: { machineEffects: { undefinedResult: descriptor() } },
    completeness: 'complete',
    origin,
  };
  const loadInstruction = projectSemanticIrV2ToLegacyV1(functionIr([load], [address, loaded])).instructions[0];
  assert.equal(loadInstruction.op, 'unknown');
  assert.ok(loadInstruction.extra.unknownCategories.includes('memory'));
  assert.equal(loadInstruction.memoryBarrier, true);

  const output = { id: 'intrinsic-output', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 8 }, definitionNodeId: 'intrinsic', origin };
  const intrinsic = {
    id: 'intrinsic',
    kind: 'intrinsic',
    blockId: 'entry',
    inputs: [],
    outputs: ['intrinsic-output'],
    operator: 'opaque-intrinsic',
    intrinsic: {
      inputs: [],
      outputs: ['intrinsic-output'],
      stateReads: [],
      stateWrites: [],
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      controlEffects: [],
      determinism: 'deterministic',
      symbolicDetail: 'summary-only',
    },
    attributes: { machineEffects: { undefinedResult: descriptor() } },
    completeness: 'complete',
    origin,
  };
  const intrinsicInstruction = projectSemanticIrV2ToLegacyV1(functionIr([intrinsic], [output])).instructions[0];
  assert.equal(intrinsicInstruction.op, 'clobber');
  assert.equal(intrinsicInstruction.extra.undefinedResult.reason, 'node-kind-boundary');
});

test('a lowered unknown memory read keeps its undefined-result barrier', () => {
  const unknown = {
    id: 'unknown-memory',
    kind: 'unknown-memory-effect',
    blockId: 'entry',
    inputs: [],
    outputs: [],
    unknown: { reason: 'address-not-representable', categories: ['memory'] },
    attributes: { machineEffects: { undefinedResult: descriptor() } },
    completeness: 'unknown',
    origin,
  };
  const ir = functionIr([unknown]);
  ir.completeness = 'unknown';
  ir.unknowns = [{ reason: 'address-not-representable', categories: ['memory'] }];
  const instruction = projectSemanticIrV2ToLegacyV1(ir).instructions[0];
  assert.equal(instruction.op, 'unknown');
  assert.ok(instruction.extra.unknownCategories.includes('memory'));
  assert.equal(instruction.memoryBarrier, true);
});
