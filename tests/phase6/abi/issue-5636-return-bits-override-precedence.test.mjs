import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyMicrosoftX64ReturnDecision, classifyMicrosoftX64CallReturn } from '../../../js/targets/abi/microsoft-x64.js';
import { classifySysVAMD64CallReturn } from '../../../js/targets/abi/sysv-amd64.js';
import { classifyAAPCS64FunctionReturn, AAPCS64_ABI } from '../../../js/targets/abi/aapcs64.js';
import { DARWIN_ARM64_ABI } from '../../../js/targets/abi/darwin-arm64.js';
import { SYSV_AMD64_ABI } from '../../../js/targets/abi/sysv-amd64.js';

/* Issue #5636: a call-site `options.returnBits` is a return-width override
 * with the same authority as `options.returnType`/`options.returnClass`.  The
 * scalar return paths evaluated it after the prototype's own width metadata,
 * so a stale/coarser prototype width silently won.  Aggregate return paths
 * already used the override-first order; this fixes the scalar paths and the
 * AAPCS64 FunctionReturn ordering (Darwin arm64 inherits the shared helper). */

test('#5636: Microsoft x64 scalar return honors options.returnBits over prototype width', () => {
  const overridden = classifyMicrosoftX64ReturnDecision(
    { returnType:'int64', returnBits:64, returnsValue:true }, { returnBits:32 });
  assert.equal(overridden.kind, 'direct');
  assert.equal(overridden.reg, 'rax');
  assert.equal(overridden.bits, 32);

  const widened = classifyMicrosoftX64ReturnDecision(
    { returnType:'int32', returnBits:32, returnsValue:true }, { returnBits:64 });
  assert.equal(widened.bits, 64);

  const untouched = classifyMicrosoftX64ReturnDecision(
    { returnType:'int64', returnBits:64, returnsValue:true });
  assert.equal(untouched.bits, 64);
});

test('#5636: SysV AMD64 scalar return honors options.returnBits over prototype width', () => {
  const overridden = classifySysVAMD64CallReturn(
    { callPrototype:{ returnType:'int64', returnBits:64, returnsValue:true } }, { returnBits:32 });
  assert.equal(overridden.reg, 'rax');
  assert.equal(overridden.bits, 32);

  const widened = classifySysVAMD64CallReturn(
    { callPrototype:{ returnType:'int32', returnBits:32, returnsValue:true } }, { returnBits:64 });
  assert.equal(widened.bits, 64);

  const untouched = classifySysVAMD64CallReturn(
    { callPrototype:{ returnType:'int64', returnBits:64, returnsValue:true } });
  assert.equal(untouched.bits, 64);
});

test('#5636: an explicit zero-width override is not replaced by prototype metadata', () => {
  const result = classifySysVAMD64CallReturn(
    { callPrototype:{ returnType:'int32', returnBits:32, returnsValue:true } },
    { returnBits:0 },
  );
  assert.equal(result.reg, 'rax');
  assert.equal(result.bits, 64, 'invalid explicit zero falls back conservatively instead of using prototype width');
});

test('#5636: AAPCS64 function return honors opts.returnBits over prototype width', () => {
  const overridden = classifyAAPCS64FunctionReturn(
    { functionPrototype:{ returnType:'int64', returnBits:64, returnsValue:true }, returnBits:32 });
  assert.equal(overridden.reg, 'x0');
  assert.equal(overridden.bits, 32);

  const widened = classifyAAPCS64FunctionReturn(
    { functionPrototype:{ returnType:'int32', returnBits:32, returnsValue:true }, returnBits:64 });
  assert.equal(widened.bits, 64);

  const untouched = classifyAAPCS64FunctionReturn(
    { functionPrototype:{ returnType:'int64', returnBits:64, returnsValue:true } });
  assert.equal(untouched.bits, 64);
});

test('#5636: Darwin arm64 inherits the override through the shared function return', () => {
  const overridden = DARWIN_ARM64_ABI.classifyFunctionReturn(
    { functionPrototype:{ returnType:'int64', returnBits:64, returnsValue:true }, returnBits:32 });
  assert.equal(overridden.reg, 'x0');
  assert.equal(overridden.bits, 32);
});

test('#5636: aggregate return validation is not bypassed by the override', () => {
  const unproven = classifyAAPCS64FunctionReturn(
    { functionPrototype:{ returnType:'struct Big', aggregate:true, returnsValue:true }, returnBits:64 });
  assert.equal(unproven.aggregate, true);
  assert.equal(unproven.partial, true);

  const sysvMalformed = SYSV_AMD64_ABI.classifyFunctionReturn({
    returnType:'struct S', aggregate:true, returnBits:192, bits:96,
    members:[{ bits:64, bytes:8, byteOffset:0 }, { bits:64, bytes:8, byteOffset:8 }, { bits:64, bytes:8, byteOffset:16 }],
  }, { returnBits:64 });
  assert.equal(sysvMalformed.partial, true, 'conflicting widths must stay fail-closed');
});

test('#5636: plugin surfaces agree with the fixed precedence', () => {
  const sysv = SYSV_AMD64_ABI.classifyCallReturn(
    { callPrototype:{ returnType:'int64', returnBits:64, returnsValue:true } }, { returnBits:32 });
  assert.equal(sysv.bits, 32);
  const msx = classifyMicrosoftX64CallReturn(
    { callPrototype:{ returnType:'int64', returnBits:64, returnsValue:true } }, { returnBits:32 });
  assert.equal(msx.bits, 32);
  const aapcs = AAPCS64_ABI.classifyFunctionReturn(
    { functionPrototype:{ returnType:'int64', returnBits:64, returnsValue:true }, returnBits:32 });
  assert.equal(aapcs.bits, 32);
});
