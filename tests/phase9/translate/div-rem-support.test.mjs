import assert from 'node:assert/strict';
import test from 'node:test';

import { OP } from '../../../js/ir-base.js';
import { BV_BINARY_OP } from '../../../js/symbolic/expr/kinds.js';
import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';
import { classifyOpSupport, TRANSLATION_STATUS } from '../../../js/symbolic/translate/support-matrix.js';

const expected = new Map([
  ['udiv', BV_BINARY_OP.UDIV],
  ['sdiv', BV_BINARY_OP.SDIV],
  ['urem', BV_BINARY_OP.UREM],
  ['srem', BV_BINARY_OP.SREM],
]);

test('implemented div/rem operations are classified and translated as exact', () => {
  for (const [subOp, exprOp] of expected) {
    assert.equal(classifyOpSupport(OP.BIN, { subOp }), TRANSLATION_STATUS.EXACT);

    const inst = {
      id: `i-${subOp}`,
      op: OP.BIN,
      subOp,
      args: [
        { value: { id: `lhs-${subOp}`, const: 9n, bits: 64 } },
        { value: { id: `rhs-${subOp}`, const: 2n, bits: 64 } },
      ],
    };
    const value = { id: `v-${subOp}`, def: inst, bits: 64 };
    const translated = translateSemanticIR(value, { bitWidth: 64 });

    assert.equal(translated.status, TRANSLATION_STATUS.EXACT, `${subOp} must reach the implemented translator path`);
    assert.equal(translated.expression.op, exprOp);
  }
});
