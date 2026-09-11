import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyMicrosoftVectorcallArguments } from '../../../js/targets/abi/microsoft-vectorcall.js';

/* Issue #5612: `hfa`/`hva` are boolean contract fields.  A present
 * non-boolean value (`hva:'yes'`, `hfa:0`, `hva:{}`) is malformed metadata,
 * not a canonical `false`; collapsing it let physically-valid aggregates
 * carry an unparseable homogeneous flag straight into exact classification. */
const HVA = (hva) => ({
  abiClass:'hva',
  aggregate:true,
  hva,
  bits:256,
  bytes:32,
  members:[
    { bits:128, bytes:16, byteOffset:0 },
    { bits:128, bytes:16, byteOffset:16 },
  ],
  padding:[],
});

test('#5612: non-boolean hva metadata fails closed instead of classifying exact', () => {
  for (const malformed of ['yes', 0, {}, 1, 'true']) {
    const result = classifyMicrosoftVectorcallArguments({ callPrototype:{ args:[HVA(malformed)] } });
    const arg = result.arguments[0];
    assert.equal(arg.location, 'unknown', `hva=${JSON.stringify(malformed)} must not classify`);
    assert.equal(arg.abiClass, 'aggregate-metadata-unproven');
    assert.equal(arg.partial, true);
    assert.equal(arg.exact, false);
  }
});

test('#5612: explicit boolean metadata keeps its meaning', () => {
  const truthy = classifyMicrosoftVectorcallArguments({ callPrototype:{ args:[HVA(true)] } }).arguments[0];
  assert.equal(truthy.abiClass, 'hva');
  assert.notEqual(truthy.location, 'unknown');

  const falsy = classifyMicrosoftVectorcallArguments({ callPrototype:{ args:[HVA(false)] } }).arguments[0];
  assert.notEqual(falsy.location, 'unknown');
  assert.notEqual(falsy.abiClass, 'aggregate-metadata-unproven');
});

test('#5612: conflicting boolean values across owners stay invalid', () => {
  const conflicting = { ...HVA(true), layout:{ ...HVA(true).layout, hva:false } };
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{ args:[conflicting] } });
  assert.equal(result.arguments[0].location, 'unknown');
});

test('#5612: absent hva metadata is unaffected', () => {
  const absent = {
    abiClass:'hva', aggregate:true, bits:256, bytes:32,
    members:[
      { bits:128, bytes:16, byteOffset:0 },
      { bits:128, bytes:16, byteOffset:16 },
    ],
    padding:[],
  };
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{ args:[absent] } });
  assert.notEqual(result.arguments[0].location, 'unknown');
});
