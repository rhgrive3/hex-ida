import assert from 'node:assert/strict';
import test from 'node:test';

import { assemble } from '../js/patch.js';

const hex = (r) => '0x' + [...r.bytes].map((b) => b.toString(16).padStart(2, '0')).reverse().join('');

test('#5798 movz rejects a register source instead of encoding a mov alias', () => {
  for (const text of ['movz x0, x1', 'movz w0, w1']) {
    const bad = assemble(text, 0n);
    assert.ok(bad.error, 'movz with a register source must be an explicit error');
    assert.ok(!bad.bytes, 'no bytes may be produced');
  }
});

test('#5798 movz immediate form and mov register alias are unchanged', () => {
  assert.equal(hex(assemble('movz w0, #42', 0n)), '0x52800540');
  assert.equal(hex(assemble('mov w0, w1', 0n)), '0x2a0103e0');
  const movz = assemble('movz x0, #42', 0n);
  assert.equal(hex(movz), '0xd2800540');
  const mov = assemble('mov x0, x1', 0n);
  assert.equal(hex(mov), '0xaa0103e0', 'register mov alias keeps the ORR encoding');
});
