import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMicrosoftX64Arguments } from '../../../js/targets/abi/microsoft-x64.js';

/* Issue #6022: under the default Microsoft x64 convention a vector argument
 * is passed by reference to a caller-allocated temporary. That temporary must
 * respect the vector's own alignment (__m128 -> 16, __m256 -> 32); the
 * classifier pinned it to 16 and understated the requirement for 256-bit
 * values (clang -target x86_64-pc-windows-msvc aligns the temporary to 32). */

test('#6022: __m256 by-reference temporary requires 32-byte alignment', () => {
  const result = classifyMicrosoftX64Arguments({ callPrototype:{ args:[{ type:'__m256' }] } });
  const arg = result.arguments[0];
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'rcx');
  assert.equal(arg.abiClass, 'vector-indirect');
  assert.equal(arg.pointer, true);
  assert.equal(arg.pointeeBits, 256);
  assert.equal(arg.requiredTemporaryAlignment, 32);
});

test('#6022: __m128 by-reference temporary keeps 16-byte alignment', () => {
  const result = classifyMicrosoftX64Arguments({ callPrototype:{ args:[{ type:'__m128' }] } });
  const arg = result.arguments[0];
  assert.equal(arg.reg, 'rcx');
  assert.equal(arg.pointeeBits, 128);
  assert.equal(arg.requiredTemporaryAlignment, 16);
});

test('#6022: proven explicit vector width is not silently clamped for the temporary', () => {
  const result = classifyMicrosoftX64Arguments({
    callPrototype:{ args:[{ type:'__m256', vector:true, bits:256 }] },
  });
  const arg = result.arguments[0];
  assert.equal(arg.requiredTemporaryAlignment, 32);
});

test('#6022: stack-passed __m256 pointer slot keeps the position rule and 32-byte temporary alignment', () => {
  const result = classifyMicrosoftX64Arguments({
    callPrototype:{ args:[
      { type:'long long' }, { type:'long long' }, { type:'long long' }, { type:'long long' },
      { type:'__m256' },
    ] },
  });
  const arg = result.arguments[4];
  assert.equal(arg.location, 'stack');
  assert.equal(arg.offset, 32);
  assert.equal(arg.pointer, true);
  assert.equal(arg.pointeeBits, 256);
  assert.equal(arg.requiredTemporaryAlignment, 32);
});

test('#6022: scalar and non-indirect aggregates keep their existing metadata', () => {
  const scalar = classifyMicrosoftX64Arguments({ callPrototype:{ args:[{ type:'int' }] } }).arguments[0];
  assert.equal(scalar.requiredTemporaryAlignment, undefined);
  const small = classifyMicrosoftX64Arguments({
    callPrototype:{ args:[{ type:'struct S', aggregate:true, bits:64, bytes:8, trivialForCalls:true }] },
  }).arguments[0];
  assert.equal(small.requiredTemporaryAlignment, undefined);
  assert.equal(small.abiClass, 'integer-aggregate');
});
