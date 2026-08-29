import assert from 'node:assert/strict';
import { normalizeAddressProofIr } from '../../js/analysis/alias/address-ir-normalize-v2.js';

function validIr() {
  return {
    values: [
      { id: 'lhs', definitionNodeId: 'lhs-const' },
      { id: 'rhs', definitionNodeId: 'rhs-const' },
      { id: 'carry', definitionNodeId: 'carry-const', metadata: { constant: 0 } },
      { id: 'result', definitionNodeId: 'adc' },
    ],
    nodes: [
      { id: 'lhs-const', kind: 'const', attributes: { constant: 1 } },
      { id: 'rhs-const', kind: 'const', attributes: { constant: 2 } },
      { id: 'carry-const', kind: 'const', attributes: { constant: 0 } },
      { id: 'adc', kind: 'intrinsic', operator: 'add-with-carry', inputs: ['lhs', 'rhs', 'carry'], outputs: ['result'] },
    ],
  };
}

{
  const ir = validIr();
  const normalized = normalizeAddressProofIr(ir);
  const projected = normalized.nodes.find((node) => node.id === 'adc:canonical-address-result');
  assert.equal(projected?.kind, 'binary');
  assert.equal(projected?.operator, 'add');
  assert.equal(normalized.values.find((value) => value.id === 'result')?.definitionNodeId, projected.id);
}

{
  const actualCarryId = { source: 'actual-carry' };
  const unrelatedZeroId = { source: 'unrelated-zero' };
  const ir = validIr();
  ir.values[2] = { id: actualCarryId, definitionNodeId: 'carry-unknown' };
  ir.values.push({ id: unrelatedZeroId, definitionNodeId: 'carry-const', metadata: { constant: 0 } });
  ir.nodes[3] = { ...ir.nodes[3], inputs: ['lhs', 'rhs', actualCarryId] };
  ir.nodes.push({ id: 'carry-unknown', kind: 'unknown' });

  const normalized = normalizeAddressProofIr(ir);
  assert.equal(normalized, ir, 'malformed non-string IDs must fail closed without proof projection');
  assert.equal(normalized.nodes.some((node) => node.id === 'adc:canonical-address-result'), false);
}

{
  const ir = validIr();
  ir.values.push({ id: 'carry', definitionNodeId: 'rhs-const', metadata: { constant: 0 } });
  const normalized = normalizeAddressProofIr(ir);
  assert.equal(normalized, ir, 'duplicate canonical IDs must fail closed instead of silently overwriting evidence');
}

console.log('address-ir-normalize-v2 identity collision regression: PASS');
