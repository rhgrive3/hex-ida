// Regression for #5718: __vectorcall uses a six-slot vector argument bank
// (xmm0..xmm5). Entry-register classification must recognise xmm4/xmm5 as
// argument registers instead of delegating to the 4-slot Microsoft x64 bank.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyMicrosoftVectorcallArguments, MICROSOFT_VECTORCALL_ABI } from '../../../js/targets/abi/microsoft-vectorcall.js';
import { MICROSOFT_X64_ABI } from '../../../js/targets/abi/microsoft-x64.js';

test('#5718 xmm4 and xmm5 are vectorcall argument registers', () => {
  for (const [reg, index] of [['xmm4', 4], ['xmm5', 5]]) {
    const cls = MICROSOFT_VECTORCALL_ABI.classifyEntryRegister(reg);
    assert.deepEqual(cls, { kind: 'argument', reg, index, abiClass: 'fp-or-vector' });
  }
});

test('#5718 the first four vector slots keep their standard classification', () => {
  for (let index = 0; index < 4; index++) {
    const cls = MICROSOFT_VECTORCALL_ABI.classifyEntryRegister(`xmm${index}`);
    assert.deepEqual(cls, { kind: 'argument', reg: `xmm${index}`, index, abiClass: 'fp-or-vector' });
  }
});

test('#5718 integer argument registers still classify through the Microsoft x64 bank', () => {
  assert.deepEqual(
    MICROSOFT_VECTORCALL_ABI.classifyEntryRegister('rcx'),
    MICROSOFT_X64_ABI.classifyEntryRegister('rcx'),
  );
  assert.deepEqual(
    MICROSOFT_VECTORCALL_ABI.classifyEntryRegister('r9'),
    MICROSOFT_X64_ABI.classifyEntryRegister('r9'),
  );
});

test('#5718 registers outside the vectorcall banks stay incoming state', () => {
  for (const reg of ['xmm6', 'xmm7', 'rsp']) {
    assert.equal(MICROSOFT_VECTORCALL_ABI.classifyEntryRegister(reg).kind, 'incoming-register-state');
  }
});


test('#5718 entry classification matches all six call-side vector slots', () => {
  const call = classifyMicrosoftVectorcallArguments({
    callPrototype: {
      callingConvention: '__vectorcall',
      args: Array.from({ length: 6 }, (_value, index) => ({ type:'__m128', vector:true, bits:128, index })),
    },
  });
  assert.deepEqual(call.arguments.map((entry) => entry.reg), ['xmm0','xmm1','xmm2','xmm3','xmm4','xmm5']);
  for (let index = 0; index < 6; index += 1) {
    assert.deepEqual(
      MICROSOFT_VECTORCALL_ABI.classifyEntryRegister(call.arguments[index].reg),
      { kind:'argument', reg:`xmm${index}`, index, abiClass:'fp-or-vector' },
    );
  }
});

test('#5718 HVA pieces may occupy xmm4 and xmm5', () => {
  const hva2 = {
    hva:true, bits:128, bytes:16,
    members:[
      { type:'double', bits:64, bytes:8, byteOffset:0 },
      { type:'double', bits:64, bytes:8, byteOffset:8 },
    ],
  };
  const result = classifyMicrosoftVectorcallArguments({
    callPrototype: {
      callingConvention:'__vectorcall',
      args:[...Array.from({ length:4 }, () => ({ type:'__m128', vector:true, bits:128 })), hva2],
    },
  });
  assert.deepEqual(result.arguments[4].regs, ['xmm4','xmm5']);
  assert.deepEqual(MICROSOFT_VECTORCALL_ABI.classifyEntryRegister('xmm4'),
    { kind:'argument', reg:'xmm4', index:4, abiClass:'fp-or-vector' });
  assert.deepEqual(MICROSOFT_VECTORCALL_ABI.classifyEntryRegister('xmm5'),
    { kind:'argument', reg:'xmm5', index:5, abiClass:'fp-or-vector' });
});

test('#5718 wide physical aliases never mint xmm argument authority', () => {
  for (const reg of ['ymm4','zmm5']) {
    assert.equal(MICROSOFT_VECTORCALL_ABI.classifyEntryRegister(reg).kind, 'incoming-register-state');
  }
});

test('#5718 invalid register identities fail closed', () => {
  for (const value of [['xmm4'], { name:'xmm4' }, 4, true, null]) {
    const cls = MICROSOFT_VECTORCALL_ABI.classifyEntryRegister(value);
    assert.equal(cls.kind, 'incoming-register-state');
    assert.equal(cls.reg, '');
  }
});
