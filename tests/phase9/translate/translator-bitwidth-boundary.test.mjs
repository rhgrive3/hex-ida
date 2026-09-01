import assert from 'node:assert/strict';
import test from 'node:test';

import { VK } from '../../../js/ir-base.js';
import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';

const arg = { kind: VK.ARG, id: 'v0', reg: 'x0', origin: '0x1000' };

function translatedWidth(bitWidth) {
  return translateSemanticIR(arg, { bitWidth }).expression.bits;
}

test('translator accepts primitive numeric bitWidth without structured coercion', () => {
  assert.equal(translatedWidth(32), 32, 'primitive number behavior must be preserved');
  assert.equal(translatedWidth('32'), 64, 'string bitWidth must fall back to 64');
  assert.equal(translatedWidth(['32']), 64, 'array bitWidth must fall back to 64');
  assert.equal(translatedWidth({ valueOf: () => 32 }), 64, 'object bitWidth must fall back to 64');
});
