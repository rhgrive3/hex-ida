import assert from 'node:assert/strict';
import test from 'node:test';

import { assemble } from '../js/patch.js';

const hex = (r) => '0x' + [...r.bytes].map((b) => b.toString(16).padStart(2, '0')).reverse().join('');
const le = (r) => [...r.bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();

test('#3974 movz without a shift keeps the LSL #0 encoding', () => {
  assert.equal(le(assemble('movz x0, #1', 0n)), '20 00 80 D2');
  assert.equal(hex(assemble('movz x0, #1', 0n)), '0xd2800020');
});

test('#3974 movz X form encodes LSL #16/#32/#48', () => {
  assert.equal(le(assemble('movz x0, #1, lsl #16', 0n)), '20 00 A0 D2');
  assert.equal(hex(assemble('movz x0, #1, lsl #16', 0n)), '0xd2a00020');
  assert.equal(hex(assemble('movz x0, #1, lsl #32', 0n)), '0xd2c00020');
  assert.equal(hex(assemble('movz x0, #1, lsl #48', 0n)), '0xd2e00020');
  assert.equal(hex(assemble('movz x9, #0x1234, lsl #32', 0n)), '0xd2c24689');
});

test('#3974 movz W form encodes LSL #16', () => {
  assert.equal(hex(assemble('movz w0, #1, lsl #16', 0n)), '0x52a00020');
});

test('#3974 movz W form rejects LSL #32/#48', () => {
  for (const text of ['movz w0, #1, lsl #32', 'movz w0, #1, lsl #48']) {
    const bad = assemble(text, 0n);
    assert.ok(bad.error, `${text} must be an explicit error`);
    assert.ok(!bad.bytes, `${text} may not produce bytes`);
  }
});

test('#3974 movz rejects a shift that is not a valid move-wide amount', () => {
  for (const text of ['movz x0, #1, lsl #8', 'movz x0, #1, lsl #64', 'movz x0, #1, lsl', 'movz x0, #1, lsl #0']) {
    const bad = assemble(text, 0n);
    if (text.endsWith('lsl #0')) {
      assert.ok(!bad.error, 'LSL #0 is the canonical no-shift spelling');
      assert.equal(hex(bad), '0xd2800020');
      continue;
    }
    assert.ok(bad.error, `${text} must be an explicit error`);
    assert.ok(!bad.bytes, `${text} may not produce bytes`);
  }
});

test('#3974 movz rejects a non-LSL shifter and surplus operands', () => {
  for (const text of ['movz x0, #1, msl #16', 'movz x0, #1, lsr #16', 'movz x0, #1, #2', 'movz x0, x1, lsl #16']) {
    const bad = assemble(text, 0n);
    assert.ok(bad.error, `${text} must be an explicit error`);
    assert.ok(!bad.bytes, `${text} may not produce bytes`);
  }
});

test('#3974 mov keeps its register and immediate alias shapes', () => {
  assert.equal(hex(assemble('mov x0, x1', 0n)), '0xaa0103e0');
  assert.equal(hex(assemble('mov w0, w1', 0n)), '0x2a0103e0');
  assert.equal(hex(assemble('mov sp, x0', 0n)), '0x9100001f');
  assert.equal(hex(assemble('mov x0, sp', 0n)), '0x910003e0');
  assert.equal(hex(assemble('mov x0, #1', 0n)), '0xd2800020');
  assert.equal(hex(assemble('mov xzr, x1', 0n)), '0xaa0103ff');
  for (const text of ['mov x0, x1, lsl #16', 'mov x0, #1, lsl #16', 'mov x0, x1, x2']) {
    const bad = assemble(text, 0n);
    assert.ok(bad.error, `${text} must not silently drop an operand`);
    assert.ok(!bad.bytes, `${text} may not produce bytes`);
  }
});
