import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySysVAMD64Arguments, classifySysVAMD64FunctionReturn } from '../../../js/targets/abi/sysv-amd64.js';

/* Issue #6049: parameterClass() clamped every declared width to 512 bits, so a
 * provider-proven 1024-bit vector was re-typed as an exact zmm0/512 argument
 * and its upper half silently disappeared. Declared widths must stay lossless;
 * the model's register ceiling is enforced by vectorRegisterView(), which
 * routes unrepresentable widths to the fail-closed unsupported path. */

test('#6049: a 1024-bit vector argument is never published as an exact 512-bit ZMM argument', () => {
  const result = classifySysVAMD64Arguments(
    { callPrototype:{ args:[{ type:'v1024', vector:true, bits:1024 }] } },
    { maxVectorRegisterBits:512 },
  );
  const arg = result.arguments[0];
  assert.equal(arg.bits, 1024, 'declared width must be preserved losslessly');
  assert.equal(arg.reg, undefined, 'no register may be minted for an unrepresentable width');
  assert.equal(arg.location, 'unknown');
  assert.equal(arg.partial, true);
  assert.equal(arg.unsupported, true);
  assert.equal(arg.exact, false);
  assert.equal(arg.reason, 'sysv-amd64-vector-width-outside-modeled-register-views');
  assert.equal(result.partial, true);
});

test('#6049: modeled widths keep their exact register placement', () => {
  const xmm = classifySysVAMD64Arguments(
    { callPrototype:{ args:[{ type:'v128', vector:true, bits:128 }] } },
    { maxVectorRegisterBits:512 },
  ).arguments[0];
  assert.equal(xmm.location, 'register');
  assert.equal(xmm.reg, 'xmm0');
  assert.equal(xmm.bits, 128);
  assert.equal(xmm.partial, undefined);

  const ymm = classifySysVAMD64Arguments(
    { callPrototype:{ args:[{ type:'v256', vector:true, bits:256 }] } },
    { maxVectorRegisterBits:256 },
  ).arguments[0];
  assert.equal(ymm.reg, 'ymm0');
  assert.equal(ymm.bits, 256);

  const zmm = classifySysVAMD64Arguments(
    { callPrototype:{ args:[{ type:'v512', vector:true, bits:512 }] } },
    { maxVectorRegisterBits:512 },
  ).arguments[0];
  assert.equal(zmm.reg, 'zmm0');
  assert.equal(zmm.bits, 512);
});

test('#6049: a following argument is not shifted by the unrepresentable vector cursor', () => {
  const result = classifySysVAMD64Arguments(
    { callPrototype:{ args:[
      { type:'v1024', vector:true, bits:1024 },
      { type:'v128', vector:true, bits:128 },
    ] } },
    { maxVectorRegisterBits:512 },
  );
  assert.equal(result.arguments[0].unsupported, true);
  const second = result.arguments[1];
  assert.equal(second.location, 'unknown');
  assert.ok(second.candidateRegisters.includes('xmm0'), 'the register cursor must not skip xmm0');
});

test('#6049: the return classifier already fails closed for unrepresentable widths', () => {
  const ret = classifySysVAMD64FunctionReturn(
    { returnType:'v1024', vector:true, returnBits:1024 },
    { maxVectorRegisterBits:512 },
  );
  assert.equal(ret.bits, 1024);
  assert.equal(ret.reg, null);
  assert.equal(ret.partial, true);
  assert.equal(ret.unsupported, true);
});
