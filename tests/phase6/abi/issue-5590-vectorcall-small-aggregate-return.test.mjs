import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyMicrosoftVectorcallFunctionReturn,
  classifyMicrosoftVectorcallCallReturn,
} from '../../../js/targets/abi/microsoft-vectorcall.js';

/* Microsoft x64 __vectorcall inherits the standard x64 integer-return rule:
 * "Results of integer type, including structs or unions of 8 bytes or less,
 * are returned by value in RAX." A proven trivial small aggregate with a
 * canonical layout must classify direct instead of unconditionally partial
 * (#5590). */

const smallStruct = (bits) => ({
  callingConvention:'vectorcall',
  returnType:'struct S',
  aggregate:true,
  returnBits:bits,
  returnTrivialForCalls:true,
  layout:{ bits, bytes:Math.max(1, Math.ceil(bits / 8)), members:[{ bits, bytes:Math.max(1, Math.ceil(bits / 8)), byteOffset:0 }] },
});

test('trivial 8-byte struct return is direct in RAX', () => {
  const result = classifyMicrosoftVectorcallFunctionReturn({ functionPrototype:smallStruct(64) });
  assert.equal(result.reg, 'rax');
  assert.equal(result.bits, 64);
  assert.equal(result.aggregate, true);
  assert.equal(result.partial, undefined);
  assert.equal(result.reason, undefined);
});

test('trivial 8/16/32-bit integer-type struct returns are direct in RAX', () => {
  for (const bits of [8, 16, 32]) {
    const result = classifyMicrosoftVectorcallFunctionReturn({ functionPrototype:smallStruct(bits) });
    assert.equal(result.reg, 'rax', `${bits}-bit struct`);
    assert.equal(result.bits, bits, `${bits}-bit struct`);
    assert.equal(result.aggregate, true, `${bits}-bit struct`);
  }
});

test('trivial 8-byte aggregate without canonical physical layout stays partial', () => {
  const result = classifyMicrosoftVectorcallFunctionReturn({ functionPrototype:{
    callingConvention:'vectorcall',
    returnType:'struct S',
    aggregate:true,
    returnBits:64,
    returnTrivialForCalls:true,
  } });
  assert.equal(result.reg, null);
  assert.equal(result.partial, true);
  assert.equal(result.aggregate, true);
  assert.equal(result.reason, 'microsoft-vectorcall-non-hva-aggregate-return-requires-layout-proof');
});

test('HVA return rules stay unchanged', () => {
  const result = classifyMicrosoftVectorcallFunctionReturn({ prototype:{
    callingConvention:'vectorcall', hva:true, bits:256, bytes:32,
    members:[
      { bits:128, bytes:16, byteOffset:0 },
      { bits:128, bytes:16, byteOffset:16 },
    ],
  } });
  assert.equal(result.reg, 'xmm0');
  assert.equal(result.abiClass, 'hva');
  assert.deepEqual(result.regs, ['xmm0', 'xmm1']);
});

test('vector return rules stay unchanged', () => {
  const result = classifyMicrosoftVectorcallCallReturn({ callPrototype:{
    callingConvention:'vectorcall', returnType:'__m256', returnBits:256,
  } });
  assert.equal(result.reg, 'ymm0');
  assert.equal(result.bits, 256);
});

test('a proven 16-byte non-HVA aggregate follows the standard indirect-result path', () => {
  const result = classifyMicrosoftVectorcallFunctionReturn({ functionPrototype:smallStruct(128) });
  assert.equal(result.indirect, true);
  assert.equal(result.reg, 'rax');
  assert.equal(result.pointeeBits, 128);
  assert.deepEqual(result.hiddenResultPointer, { input:'rcx', returned:'rax', callerAllocated:true });
});

test('a nontrivial small aggregate with proven layout takes the hidden-result path', () => {
  const prototype = {
    callingConvention:'vectorcall', returnType:'struct S', aggregate:true,
    returnBits:64, returnNonTrivialForCalls:true,
    layout:{ bits:64, bytes:8, members:[{ bits:64, bytes:8, byteOffset:0 }] },
  };
  const result = classifyMicrosoftVectorcallFunctionReturn({ functionPrototype:prototype });
  assert.equal(result.indirect, true);
  assert.equal(result.reg, 'rax');
  assert.equal(result.pointeeBits, 64);
});

test('a >8-byte aggregate without a physical layout stays partial', () => {
  const result = classifyMicrosoftVectorcallFunctionReturn({ functionPrototype:{
    callingConvention:'vectorcall', returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true,
  } });
  assert.equal(result.reg, null);
  assert.equal(result.partial, true);
  assert.equal(result.hiddenResultPossible, true);
});

test('a padded small aggregate is not laundered into a direct return', () => {
  const prototype = {
    callingConvention:'vectorcall', returnType:'struct S', aggregate:true,
    returnBits:64, returnTrivialForCalls:true,
    layout:{
      bits:64, bytes:16,
      members:[{ bits:64, bytes:8, byteOffset:0 }],
      padding:[{ byteOffset:8, bytes:8 }],
    },
  };
  const result = classifyMicrosoftVectorcallFunctionReturn({ functionPrototype:prototype });
  assert.equal(result.reg, null);
  assert.equal(result.partial, true);
});
