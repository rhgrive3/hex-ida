// Regression for #5947: the add-with-carry carry-in is a machine integer —
// a constant payload of a different semantic kind (float) must not be unwrapped
// into an exact integer 0 and mint a carry-in-exact-zero proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeAddressProofIr } from '../../js/analysis/alias/address-ir-normalize-v2.js';

const origin = (id) => ({ instructionIds: [id] });

function irFor(constant, machineKind = constant.kind === 'float' ? 'float' : constant.kind ?? 'bitvector') {
  return {
    functionId: 'fn_5947',
    values: [
      { id: 'a' },
      { id: 'b' },
      {
        id: 'cin',
        kind: 'definition',
        definitionNodeId: 'c0',
        machineType: { kind: machineKind, widthBits: 32 },
        metadata: { constant: { ...constant } },
      },
      { id: 'sum', kind: 'definition', definitionNodeId: 'adc' },
    ],
    nodes: [
      { id: 'c0', kind: 'const', inputs: [], outputs: ['cin'], attributes: { constant: { ...constant } }, origin: origin('c0') },
      {
        id: 'adc',
        kind: 'intrinsic',
        operator: 'add-with-carry',
        inputs: ['a', 'b', 'cin'],
        outputs: ['sum'],
        origin: origin('adc'),
      },
    ],
  };
}

test('#5947 a float-typed zero carry-in does not mint a carry-in-exact-zero proof', () => {
  const normalized = normalizeAddressProofIr(irFor({ kind: 'float', value: '0' }));
  const projection = normalized.nodes.find((node) => node.attributes?.canonicalAddressProjection);
  assert.equal(projection, undefined, 'non-integer constant must not project add-with-carry to add');
  assert.ok(normalized.nodes.some((node) => String(node.operator ?? '').toLowerCase() === 'add-with-carry'));
});

test('#5947 a bitvector-typed zero carry-in still projects to exact add', () => {
  const normalized = normalizeAddressProofIr(irFor({ kind: 'bitvector', value: '0' }));
  const projection = normalized.nodes.find((node) => node.attributes?.canonicalAddressProjection);
  assert.ok(projection, 'exact integer-zero carry-in must project');
  assert.equal(projection.attributes.canonicalAddressProjection.proof, 'carry-in-exact-zero');
  assert.equal(projection.operator, 'add');
});

test('#5947 an integer-typed zero carry-in still projects to exact add', () => {
  const normalized = normalizeAddressProofIr(irFor({ kind: 'integer', value: '0' }));
  const projection = normalized.nodes.find((node) => node.attributes?.canonicalAddressProjection);
  assert.ok(projection, 'exact integer-zero carry-in must project');
});

test('#5947 a float machine type cannot be relabeled as an integer zero', () => {
  const normalized = normalizeAddressProofIr(irFor({ kind: 'bitvector', value: '0' }, 'float'));
  const projection = normalized.nodes.find((node) => node.attributes?.canonicalAddressProjection);
  assert.equal(projection, undefined, 'machine type must agree with the integer constant domain');
});

test('#5947 a malformed structured integer payload does not mint an exact proof', () => {
  const normalized = normalizeAddressProofIr(irFor({ kind: 'bitvector', value: 'not-an-integer' }));
  const projection = normalized.nodes.find((node) => node.attributes?.canonicalAddressProjection);
  assert.equal(projection, undefined, 'an unparseable structured constant is not exact evidence');
});
