import assert from 'node:assert/strict';
import test from 'node:test';

import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';
import { TRANSLATION_STATUS } from '../../../js/symbolic/translate/support-matrix.js';

test('#4690 id-less values do not alias through one anonymous memo key', () => {
  const out = translateSemanticIR({
    id: 'add-anon',
    op: 'bin',
    subOp: 'add',
    args: [
      { value: { const: 1n } },
      { value: { const: 2n } },
    ],
  }, { bitWidth: 8 });

  assert.equal(out.status, TRANSLATION_STATUS.EXACT);
  assert.equal(out.semanticUnknowns, 0);
  assert.notEqual(out.expression.left, out.expression.right, 'id-less operands must never share memo identity');
  assert.equal(out.expression.left.value, 1n);
  assert.equal(out.expression.right.value, 2n);
});
