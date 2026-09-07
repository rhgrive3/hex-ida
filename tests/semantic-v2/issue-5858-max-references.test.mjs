import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticIrFunction } from '../../js/semantics/ir/index.js';

const origin = { instructionIds: ['issue-5858-instruction'] };
const addressValue = {
  id: 'address',
  kind: 'entry',
  machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' },
  origin,
};
const variableRef = { key: 'state:issue-5858', kind: 'logical-state', scope: 'function' };
const memoryAccess = {
  addressSpace: 'memory',
  addressValueId: 'address',
  widthBits: 8,
  endian: 'little',
};

function makeFunction(kind = 'call', summaryOverrides = {}, nodeOverrides = {}) {
  const summary = kind === 'call'
    ? {
      targetValueIds: [],
      targetEntityIds: [],
      arguments: [],
      returns: [],
      stateReads: [],
      stateWrites: [],
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      controlEffects: [],
      determinism: 'deterministic',
      noreturn: false,
      mayThrow: false,
      summarySource: 'issue-5858',
      completeness: 'complete',
      unknownEffects: null,
      ...summaryOverrides,
    }
    : {
      inputs: [],
      outputs: [],
      stateReads: [],
      stateWrites: [],
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      controlEffects: [],
      determinism: 'deterministic',
      symbolicDetail: 'available',
      ...summaryOverrides,
    };
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'function-5858-' + kind,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: ['node'], origin }],
    values: [addressValue],
    nodes: [{
      id: 'node',
      kind,
      blockId: 'entry',
      inputs: ['address'],
      outputs: [],
      [kind]: summary,
      origin,
      ...nodeOverrides,
    }],
    completeness: 'complete',
    unknowns: [],
    origin,
  };
}

test('#5858 a small nested summary still publishes', () => {
  const result = createSemanticIrFunction(makeFunction(), { budget: { maxReferences: 2 } });
  assert.equal(result.nodes[0].call.targetEntityIds.length, 0);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.nodes[0].call), true);
});

const callCollectionCases = [
  ['targetValueIds', ['address']],
  ['targetEntityIds', ['callee']],
  ['arguments', ['address']],
  ['returns', ['address']],
  ['stateReads', [variableRef]],
  ['stateWrites', [variableRef]],
  ['controlEffects', [{ kind: 'call' }]],
  ['memoryRead', { scope: 'accesses', accesses: [memoryAccess] }],
  ['memoryWrite', { scope: 'accesses', accesses: [memoryAccess] }],
  ['memoryRead-all-addressSpaces', { scope: 'all', addressSpaces: ['memory'] }],
];

for (const [field, value] of callCollectionCases) {
  test('#5858 call collection contributes to maxReferences: ' + field, () => {
    const overrides = field === 'memoryRead-all-addressSpaces'
      ? { memoryRead: value }
      : { [field]: value };
    assert.throws(
      () => createSemanticIrFunction(makeFunction('call', overrides), { budget: { maxReferences: 2 } }),
      /semantic-ir-budget-exceeded-maxReferences/
    );
  });
}

const intrinsicCollectionCases = [
  ['inputs', ['address']],
  ['outputs', ['address']],
  ['stateReads', [variableRef]],
  ['stateWrites', [variableRef]],
  ['controlEffects', [{ kind: 'intrinsic' }]],
  ['memoryRead', { scope: 'accesses', accesses: [memoryAccess] }],
  ['memoryWrite', { scope: 'accesses', accesses: [memoryAccess] }],
  ['memoryRead-all-addressSpaces', { scope: 'all', addressSpaces: ['memory'] }],
];

for (const [field, value] of intrinsicCollectionCases) {
  test('#5858 intrinsic collection contributes to maxReferences: ' + field, () => {
    const overrides = field === 'memoryRead-all-addressSpaces'
      ? { memoryRead: value }
      : { [field]: value };
    assert.throws(
      () => createSemanticIrFunction(makeFunction('intrinsic', overrides), { budget: { maxReferences: 2 } }),
      /semantic-ir-budget-exceeded-maxReferences/
    );
  });
}

test('#5858 unknown-effect categories contribute to maxReferences', () => {
  const result = makeFunction(
    'call',
    {
      completeness: 'partial',
      unknownEffects: { reason: 'unresolved', categories: ['state'] },
    },
    {
      completeness: 'partial',
      unknown: { reason: 'unresolved', categories: ['state'] },
    }
  );
  assert.throws(
    () => createSemanticIrFunction(result, { budget: { maxReferences: 2 } }),
    /semantic-ir-budget-exceeded-maxReferences/
  );
});

test('#5858 raw preflight includes existing node and value denominator collections', () => {
  const input = makeFunction('call', {}, {
    inputs: ['address', 'not-normalized'],
    targets: ['entry'],
    sourceEffectIds: ['effect'],
  });
  input.values.push({
    id: 'result',
    kind: 'definition',
    machineType: { kind: 'bitvector', widthBits: 8 },
    definitionNodeId: 'node',
    origin,
  });
  input.nodes[0].outputs = ['result'];
  assert.throws(
    () => createSemanticIrFunction(input, { budget: { maxReferences: 2 } }),
    /semantic-ir-budget-exceeded-maxReferences/
  );
});

test('#5858 raw preflight rejects a large ordinary nested array before reading its elements', () => {
  let normalized = false;
  const rawArguments = [];
  Object.defineProperty(rawArguments, '0', {
    enumerable: true,
    get() {
      normalized = true;
      return ['address'];
    },
  });
  rawArguments.length = 3;
  const input = makeFunction('call', { arguments: rawArguments });
  assert.throws(
    () => createSemanticIrFunction(input, { budget: { maxReferences: 2 } }),
    /semantic-ir-budget-exceeded-maxReferences/
  );
  assert.equal(normalized, false, 'preflight must reject before nested element normalization');
});


test('#5858 raw preflight uses captured top-level collections when input accessors change', () => {
  let topLevelReads = 0;
  let normalized = false;
  const rawArguments = [];
  Object.defineProperty(rawArguments, '0', {
    enumerable: true,
    get() {
      normalized = true;
      return ['address'];
    },
  });
  rawArguments.length = 3;
  const input = makeFunction('call', { arguments: rawArguments });
  const capturedNodes = input.nodes;
  Object.defineProperty(input, 'nodes', {
    configurable: true,
    enumerable: true,
    get() {
      topLevelReads += 1;
      return topLevelReads === 1 ? capturedNodes : [];
    },
  });
  assert.throws(
    () => createSemanticIrFunction(input, { budget: { maxReferences: 2 } }),
    /semantic-ir-budget-exceeded-maxReferences/
  );
  assert.equal(topLevelReads, 1, 'preflight must not reread accessor-backed top-level collections');
  assert.equal(normalized, false, 'preflight must reject before nested element normalization');
});

test('#5858 raw preflight remains conservative for duplicate inputs', () => {
  const input = makeFunction('call', { targetEntityIds: ['callee', 'callee'] });
  assert.throws(
    () => createSemanticIrFunction(input, { budget: { maxReferences: 2 } }),
    /semantic-ir-budget-exceeded-maxReferences/
  );
});
