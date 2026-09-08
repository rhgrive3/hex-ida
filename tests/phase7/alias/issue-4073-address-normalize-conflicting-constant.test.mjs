import assert from 'node:assert/strict';
import { normalizeAddressProofIr } from '../../../js/analysis/alias/address-ir-normalize-v2.js';

function makeIr({ valueConstant, attributeConstant, nodeConstant }) {
  const valueMetadata = valueConstant === undefined ? {} : { constant: valueConstant };
  const nodeAttributes = attributeConstant === undefined ? {} : { constant: attributeConstant };
  const nodeMetadata = nodeConstant === undefined ? {} : { constant: nodeConstant };
  return {
    functionId: 'f',
    values: [
      { id: 'a', kind: 'entry', definitionNodeId: null },
      { id: 'b', kind: 'entry', definitionNodeId: null },
      { id: 'carry', kind: 'const', definitionNodeId: 'c0', metadata: valueMetadata },
      { id: 'sum', kind: 'normal', definitionNodeId: 'adc' },
    ],
    nodes: [
      { id: 'c0', kind: 'const', inputs: [], outputs: ['carry'], attributes: nodeAttributes, metadata: nodeMetadata },
      { id: 'adc', kind: 'intrinsic', operator: 'add-with-carry', inputs: ['a', 'b', 'carry'], outputs: ['sum'] },
    ],
  };
}

function assertNotProjected(constants) {
  const ir = makeIr(constants);
  assert.equal(normalizeAddressProofIr(ir), ir, 'conflicting/non-zero carry evidence must not mint an exact add projection');
}

function assertProjected(constants) {
  const ir = makeIr(constants);
  const normalized = normalizeAddressProofIr(ir);
  assert.notEqual(normalized, ir, 'exact zero carry evidence should retain the existing projection');
  const sum = normalized.values.find((value) => value.id === 'sum');
  const projected = normalized.nodes.find((node) => node.id === sum.definitionNodeId);
  assert.equal(projected?.kind, 'binary');
  assert.equal(projected?.operator, 'add');
  assert.deepEqual(projected?.attributes?.canonicalAddressProjection, {
    sourceOperator: 'add-with-carry',
    proof: 'carry-in-exact-zero',
  });
}

assertNotProjected({ valueConstant: 0, attributeConstant: 1 });
assertNotProjected({ valueConstant: 1, attributeConstant: 0 });
assertNotProjected({ valueConstant: 0, nodeConstant: 1 });
assertNotProjected({ valueConstant: 1, attributeConstant: 1, nodeConstant: 1 });

assertProjected({ valueConstant: 0, attributeConstant: '0', nodeConstant: 0n });
assertProjected({ valueConstant: 0 });
assertProjected({ valueConstant: 0, attributeConstant: 'not-an-integer' });

console.log('phase7 issue-4073 conflicting constant authority regression: PASS');
