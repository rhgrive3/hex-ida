import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';

const origin = { instructionIds: ['issue-4533'] };
const machineType = { kind: 'bitvector', widthBits: 64 };

function functionFor(node, ids) {
  const outputIds = new Set(node.outputs);
  const values = [...new Set(ids)].map((id) => outputIds.has(id)
    ? { id, kind: 'definition', definitionNodeId: node.id, machineType, origin }
    : { id, kind: 'entry', machineType, origin });
  return createSemanticIrFunction({
    functionId: 'issue-4533',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: [node.id], origin }],
    values,
    nodes: [node],
    completeness: 'complete',
    unknowns: [],
    origin,
  });
}

function callSummary({ targetValueIds = [], targetEntityIds = ['callee'], arguments: args = ['argA'], returns = ['retA'] } = {}) {
  return {
    targetValueIds,
    targetEntityIds,
    arguments: args,
    returns,
    stateReads: [],
    stateWrites: [],
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'deterministic',
    noreturn: false,
    mayThrow: false,
    summarySource: 'issue-4533-test',
    completeness: 'complete',
  };
}

function callFunction({ inputs, outputs = ['retA'], targetValueIds, targetEntityIds, arguments: args, returns } = {}) {
  const node = {
    id: 'call0',
    kind: 'call',
    blockId: 'entry',
    inputs,
    outputs,
    call: callSummary({ targetValueIds, targetEntityIds, arguments: args, returns }),
    origin,
  };
  return functionFor(node, [...inputs, ...outputs, ...(targetValueIds ?? []), ...(args ?? []), ...(returns ?? [])]);
}

function intrinsicFunction({ inputs = [], outputs = [], summaryInputs = inputs, summaryOutputs = outputs } = {}) {
  const node = {
    id: 'intrinsic0',
    kind: 'intrinsic',
    blockId: 'entry',
    inputs,
    outputs,
    intrinsic: {
      inputs: summaryInputs,
      outputs: summaryOutputs,
      stateReads: [],
      stateWrites: [],
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      controlEffects: [],
      determinism: 'deterministic',
      symbolicDetail: 'summary-only',
    },
    origin,
  };
  return functionFor(node, [...inputs, ...outputs, ...summaryInputs, ...summaryOutputs]);
}

test('#4533 rejects call argument and return mappings that disagree with node I/O', () => {
  assert.throws(
    () => callFunction({ inputs: ['argA'], outputs: ['retA'], arguments: ['argB'], returns: ['retA'] }),
    /semantic-ir-call-input-mismatch/,
  );
  assert.throws(
    () => callFunction({ inputs: ['argA'], outputs: ['retA'], arguments: ['argA'], returns: ['retB'] }),
    /semantic-ir-call-output-mismatch/,
  );
  assert.throws(
    () => callFunction({ inputs: ['target'], targetValueIds: ['target'], arguments: ['argA'] }),
    /semantic-ir-call-input-mismatch/,
  );
});

test('#4533 accepts both documented indirect-call input contracts', () => {
  assert.doesNotThrow(() => callFunction({
    inputs: ['argA'], targetValueIds: ['target'], arguments: ['argA'], returns: ['retA'],
  }));
  assert.doesNotThrow(() => callFunction({
    inputs: ['target', 'argA'], targetValueIds: ['target'], arguments: ['argA'], returns: ['retA'],
  }));
  assert.doesNotThrow(() => callFunction({
    inputs: ['argA', 'argB'], arguments: ['argA', 'argB'], returns: ['retA'],
  }));
  assert.doesNotThrow(() => callFunction({
    inputs: ['opaque'], outputs: [], targetEntityIds: [], targetValueIds: [], arguments: [], returns: [],
  }));
});

test('#4533 requires intrinsic summary inputs and outputs to match node I/O', () => {
  assert.throws(
    () => intrinsicFunction({ inputs: ['argA'], summaryInputs: ['argB'] }),
    /semantic-ir-intrinsic-input-mismatch/,
  );
  assert.throws(
    () => intrinsicFunction({ outputs: ['retA'], summaryOutputs: ['retB'] }),
    /semantic-ir-intrinsic-output-mismatch/,
  );
  assert.doesNotThrow(() => intrinsicFunction({ inputs: ['argA'], outputs: ['retA'] }));
});

console.log('issue #4533 Semantic IR I/O consistency: PASS');
