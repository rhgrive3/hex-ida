import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMicrosoftVectorcallFunctionReturn } from '../js/targets/abi/microsoft-vectorcall.js';

const ret = (functionPrototype) => classifyMicrosoftVectorcallFunctionReturn({ functionPrototype });

test('6064: double with 256 bits is rejected', () => {
  const result = ret({ callingConvention: 'vectorcall', returnType: 'double', returnBits: 256, returnsValue: true });
  assert.equal(result?.reg, null);
  assert.equal(result?.partial, true);
});

test('6064: float with 64 bits is rejected', () => {
  const result = ret({ callingConvention: 'vectorcall', returnType: 'float', returnBits: 64, returnsValue: true });
  assert.equal(result?.reg, null);
  assert.equal(result?.partial, true);
});

test('6064: canonical scalar widths still resolve to XMM0', () => {
  assert.deepEqual(
    ret({ callingConvention: 'vectorcall', returnType: 'float', returnsValue: true }),
    { reg: 'xmm0', bits: 32, abiClass: 'fp' },
  );
  assert.deepEqual(
    ret({ callingConvention: 'vectorcall', returnType: 'double', returnsValue: true }),
    { reg: 'xmm0', bits: 64, abiClass: 'fp' },
  );
});

test('6064: matching explicit width is accepted', () => {
  const result = ret({ callingConvention: 'vectorcall', returnType: 'double', returnBits: 64, returnsValue: true });
  assert.equal(result?.reg, 'xmm0');
  assert.equal(result?.bits, 64);
});
