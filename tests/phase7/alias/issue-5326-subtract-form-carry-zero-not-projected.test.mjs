// Regression for #5326: a subtract-form add-with-carry whose carry-in is
// exactly 0 must NOT be normalized into a plain `binary/add` canonical-address
// projection. `canonical-address-v2-core.js::deriveAddWithCarry` deliberately
// keeps subtract-form with carry 0 unknown (only carry 1 is a canonical
// subtraction), so projecting the carry-0 subtract case to `add` here would let
// the regions-v2 path promote an operation the canonical authority refuses into
// a strong canonical address proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeAddressProofIr } from '../../../js/analysis/alias/address-ir-normalize-v2.js';

const origin = (id) => ({ instructionIds: [id] });

function irFor({ subtract }) {
  return {
    functionId: 'fn_5326',
    values: [
      { id: 'a', kind: 'definition', definitionNodeId: 'p_a', machineType: { kind: 'address', widthBits: 64 } },
      { id: 'b', kind: 'definition', definitionNodeId: 'p_b', machineType: { kind: 'integer', widthBits: 64 } },
      {
        id: 'cin',
        kind: 'definition',
        definitionNodeId: 'c0',
        machineType: { kind: 'integer', widthBits: 1 },
        metadata: { constant: { kind: 'integer', value: '0' } },
      },
      { id: 'sum', kind: 'definition', definitionNodeId: 'adc', machineType: { kind: 'address', widthBits: 64 } },
    ],
    nodes: [
      { id: 'p_a', kind: 'param', outputs: ['a'], origin: origin('p_a') },
      { id: 'p_b', kind: 'param', outputs: ['b'], origin: origin('p_b') },
      { id: 'c0', kind: 'const', inputs: [], outputs: ['cin'], attributes: { constant: { kind: 'integer', value: '0' } }, origin: origin('c0') },
      {
        id: 'adc',
        kind: 'intrinsic',
        operator: 'add-with-carry',
        inputs: ['a', 'b', 'cin'],
        outputs: ['sum'],
        origin: origin('adc'),
        attributes: { machineEffects: { operationMetadata: { subtract } } },
      },
    ],
  };
}

test('#5326 subtract-form add-with-carry with carry 0 is not laundered into an add proof', () => {
  const normalized = normalizeAddressProofIr(irFor({ subtract: true }));
  const projected = normalized.nodes.find((node) => node.attributes?.canonicalAddressProjection);
  assert.equal(projected, undefined, 'subtract-form carry-0 must not mint a canonical-address add projection');
  const intrinsic = normalized.nodes.find((node) => String(node.operator ?? '').toLowerCase() === 'add-with-carry');
  assert.ok(intrinsic, 'the subtract-form add-with-carry intrinsic must be left for the canonical core to answer unknown');
  assert.equal(intrinsic.id, 'adc');
});

test('#5326 non-subtract add-with-carry with carry 0 still projects to exact add', () => {
  const normalized = normalizeAddressProofIr(irFor({ subtract: false }));
  const projected = normalized.nodes.find((node) => node.attributes?.canonicalAddressProjection);
  assert.ok(projected, 'a genuine carry-0 addition still projects to exact add');
  assert.equal(projected.operator, 'add');
  assert.equal(projected.attributes.canonicalAddressProjection.proof, 'carry-in-exact-zero');
});

test('#5326 a missing operationMetadata.subtract flag is treated as an addition and still projects', () => {
  const noMetadata = irFor({ subtract: false });
  noMetadata.nodes[3] = { ...noMetadata.nodes[3], attributes: {} };
  const normalized = normalizeAddressProofIr(noMetadata);
  const projected = normalized.nodes.find((node) => node.attributes?.canonicalAddressProjection);
  assert.ok(projected, 'absence of subtract metadata must not block the proven addition projection');
});
