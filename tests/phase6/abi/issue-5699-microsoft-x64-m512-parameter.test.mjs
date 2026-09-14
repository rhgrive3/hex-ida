import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMicrosoftX64Arguments } from '../../../js/targets/abi/microsoft-x64.js';

/* Microsoft x64 AVX-512: `__m512` is an intrinsic vector type just like
 * `__m128`/`__m256`. A 512-bit value never travels inside a 64-bit integer
 * register; it passes as a reference to a caller-allocated temporary in the
 * position's integer register (#5699). */

test('__m512 parameter with proven 512-bit width passes by reference in RCX', () => {
  const result = classifyMicrosoftX64Arguments({ callPrototype:{
    args:[{ type:'__m512', bits:512 }],
  } });
  assert.equal(result.partial, false);
  const entry = result.arguments[0];
  assert.equal(entry.location, 'register');
  assert.equal(entry.reg, 'rcx');
  assert.equal(entry.abiClass, 'vector-indirect');
  assert.equal(entry.pointer, true);
  assert.equal(entry.bits, 64, 'the register carries a 64-bit pointer, not the 512-bit value');
  assert.equal(entry.pointeeBits, 512);
});

test('__m512 parameter without declared bits keeps its 512-bit intrinsic width', () => {
  const result = classifyMicrosoftX64Arguments({ callPrototype:{
    args:[{ type:'__m512' }],
  } });
  const entry = result.arguments[0];
  assert.equal(entry.location, 'register');
  assert.equal(entry.reg, 'rcx');
  assert.equal(entry.pointer, true);
  assert.equal(entry.pointeeBits, 512, 'the intrinsic spelling must not collapse to a 64-bit integer');
});

test('__m512 beyond the first four positions passes a stack pointer slot', () => {
  const result = classifyMicrosoftX64Arguments({ callPrototype:{
    args:[
      { type:'uint64_t', bits:64 },
      { type:'uint64_t', bits:64 },
      { type:'uint64_t', bits:64 },
      { type:'uint64_t', bits:64 },
      { type:'__m512', bits:512 },
    ],
  } });
  const entry = result.arguments[4];
  assert.equal(entry.location, 'stack');
  assert.equal(entry.offset, 32);
  assert.equal(entry.abiClass, 'vector-indirect');
  assert.equal(entry.pointer, true);
  assert.equal(entry.bits, 64);
  assert.equal(entry.pointeeBits, 512);
});

test('__m512 with a contradictory declared width fails closed', () => {
  const result = classifyMicrosoftX64Arguments({ callPrototype:{
    args:[{ type:'__m512', bits:128 }],
  } });
  assert.equal(result.partial, true);
  const entry = result.arguments[0];
  assert.equal(entry.location, 'unknown', 'a conflicting width must not publish an exact placement');
});

test('__m128 and __m256 controls keep their existing indirect classification', () => {
  const result = classifyMicrosoftX64Arguments({ callPrototype:{
    args:[{ type:'__m128', bits:128 }, { type:'__m256', bits:256 }],
  } });
  assert.equal(result.arguments[0].reg, 'rcx');
  assert.equal(result.arguments[0].abiClass, 'vector-indirect');
  assert.equal(result.arguments[0].pointeeBits, 128);
  assert.equal(result.arguments[1].reg, 'rdx');
  assert.equal(result.arguments[1].abiClass, 'vector-indirect');
  assert.equal(result.arguments[1].pointeeBits, 256);
});


test('__m512 with invalid present declared widths stays unknown', () => {
  for (const bits of [0, -1, '512', {}, []]) {
    const result = classifyMicrosoftX64Arguments({ callPrototype:{ args:[{ type:'__m512', bits }] } });
    assert.equal(result.partial, true, `declared width ${String(bits)}`);
    assert.equal(result.arguments[0].location, 'unknown', `declared width ${String(bits)}`);
  }
});
