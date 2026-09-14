// Regression for #5795: the patch assembler must validate operand arity per
// mnemonic, never silently drop surplus operands, and must encode `ret xN`
// with the requested register instead of the x30 default.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../../js/patch.js';

function hex(result) {
  return [...result.bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

test('#5795 ret x0 encodes RET X0 (0xD65F0000), not the x30 default', () => {
  const out = assemble('ret x0', 0n);
  assert.equal(out.error, undefined);
  assert.equal(hex(out), '00 00 5f d6');
});

test('#5795 bare ret keeps the canonical x30 default encoding', () => {
  const out = assemble('ret', 0n);
  assert.equal(out.error, undefined);
  assert.equal(hex(out), 'c0 03 5f d6');
});

test('#5795 ret x30 keeps the x30 encoding', () => {
  const out = assemble('ret x30', 0n);
  assert.equal(out.error, undefined);
  assert.equal(hex(out), 'c0 03 5f d6');
});

test('#5795 ret rejects non-X registers and arity > 1', () => {
  assert.match(assemble('ret w0', 0n).error, /ret/);
  assert.match(assemble('ret sp', 0n).error, /ret/);
  assert.match(assemble('ret x0, x1', 0n).error, /ret/);
});

test('#5795 surplus operands fail closed per mnemonic', () => {
  for (const text of ['nop x0', 'brk #1, #2', 'b 0x100, x0', 'bl 0x100, x0', 'mov x0, #1, #2', 'b.eq 0x100, x0', 'movz x0, #1, #2']) {
    const out = assemble(text, 0n);
    assert.ok(out.error, `${text} must be rejected`);
  }
});

test('#5795 valid encodings are unchanged', () => {
  assert.equal(hex(assemble('nop', 0n)), '1f 20 03 d5');
  assert.equal(hex(assemble('brk #1', 0n)), '20 00 20 d4');
  assert.equal(hex(assemble('mov x0, #1', 0n)), '20 00 80 d2');
  assert.equal(hex(assemble('mov x0, x1', 0n)), 'e0 03 01 aa');
  assert.equal(hex(assemble('b 0x100', 0n)), '40 00 00 14');
  assert.equal(hex(assemble('b.eq 0x100', 0n)), '00 08 00 54');
});
