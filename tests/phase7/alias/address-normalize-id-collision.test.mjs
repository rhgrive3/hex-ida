import assert from 'node:assert/strict';
import { normalizeAddressProofIr } from '../../../js/analysis/alias/address-ir-normalize-v2.js';

const ir = {
  functionId: 'f',
  values: [
    { id: 'a', kind: 'entry', definitionNodeId: null },
    { id: 'b', kind: 'entry', definitionNodeId: null },
    { id: 'zero', kind: 'const', definitionNodeId: 'c0', metadata: { constant: 0 } },
    { id: 'sum', kind: 'normal', definitionNodeId: 'adc' },
    { id: 'other', kind: 'const', definitionNodeId: 'adc:canonical-address-result', metadata: { constant: 123 } },
  ],
  nodes: [
    { id: 'c0', kind: 'const', inputs: [], outputs: ['zero'], attributes: { constant: 0 } },
    { id: 'adc', kind: 'intrinsic', operator: 'add-with-carry', inputs: ['a', 'b', 'zero'], outputs: ['sum'] },
    { id: 'adc:canonical-address-result', kind: 'const', inputs: [], outputs: ['other'], attributes: { constant: 123 } },
  ],
};

const normalized = normalizeAddressProofIr(ir);
const ids = normalized.nodes.map((node) => String(node.id));
assert.equal(new Set(ids).size, ids.length, 'normalization must not create duplicate node IDs');
assert.equal(normalized.values.find((value) => value.id === 'other').definitionNodeId, 'adc:canonical-address-result');
assert.equal(normalized.values.find((value) => value.id === 'sum').definitionNodeId, 'adc:canonical-address-result:1');
assert.equal(normalizeAddressProofIr(ir).values.find((value) => value.id === 'sum').definitionNodeId, 'adc:canonical-address-result:1');

console.log('phase7 canonical-address synthetic id collision regression: PASS');
