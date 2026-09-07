import test from 'node:test';
import assert from 'node:assert/strict';

import { DARWIN_ARM64_ABI, classifyDarwinArm64Arguments } from '../../../js/targets/abi/darwin-arm64.js';
import { classifyAAPCS64FunctionReturn } from '../../../js/targets/abi/aapcs64.js';

/* Issue #5603: Apple arm64 defines `long double` as IEEE754 binary64,
 * identical to `double`.  The Darwin classifier routed the type through the
 * integer lane (x0/xN); it must classify as a 64-bit FP argument/return
 * (v0 low 64 bits) while generic AAPCS64 keeps its own quad-precision
 * semantics. */

test('#5603: Darwin long double argument occupies the FP lane', () => {
  const arg = classifyDarwinArm64Arguments({ callPrototype:{ args:[{ type:'long double' }] } }).arguments[0];
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'v0');
  assert.equal(arg.abiClass, 'fp');
  assert.equal(arg.bits, 64);
});

test('#5603: mixed argument sequence keeps independent gp/fp counters', () => {
  const args = classifyDarwinArm64Arguments({
    callPrototype:{ args:[{ type:'int' }, { type:'long double' }, { type:'int' }] },
  }).arguments;
  assert.deepEqual(args.map((entry) => entry.reg), ['x0', 'v0', 'x1']);
  assert.equal(args[1].abiClass, 'fp');
});

test('#5603: Darwin long double return uses v0', () => {
  const fnReturn = DARWIN_ARM64_ABI.classifyFunctionReturn(
    { functionPrototype:{ returnType:'long double', returnsValue:true } });
  assert.equal(fnReturn.reg, 'v0');
  assert.equal(fnReturn.bits, 64);

  const callReturn = DARWIN_ARM64_ABI.classifyCallReturn(
    { callPrototype:{ returnType:'long double', returnsValue:true } });
  assert.equal(callReturn.reg, 'v0');
  assert.equal(callReturn.bits, 64);
});

test('#5603: Darwin long double matches the double classification physically', () => {
  const longDouble = classifyDarwinArm64Arguments({ callPrototype:{ args:[{ type:'long double' }] } }).arguments[0];
  const doubleArg = classifyDarwinArm64Arguments({ callPrototype:{ args:[{ type:'double' }] } }).arguments[0];
  assert.deepEqual(
    { reg:longDouble.reg, abiClass:longDouble.abiClass, bits:longDouble.bits, bytes:longDouble.bytes },
    { reg:doubleArg.reg, abiClass:doubleArg.abiClass, bits:doubleArg.bits, bytes:doubleArg.bytes },
  );
});

test('#5603: generic AAPCS64 does not adopt the Apple narrowing', () => {
  const generic = classifyAAPCS64FunctionReturn({ functionPrototype:{ returnType:'long double', returnsValue:true } });
  assert.equal(generic.reg, 'x0', 'generic AAPCS64 keeps its own long double semantics');
});

test('#5603: explicit contradictory width evidence fails closed instead of being re-typed', () => {
  const arg = classifyDarwinArm64Arguments({ callPrototype:{ args:[{ type:'long double', bits:128 }] } }).arguments[0];
  assert.equal(arg.location, 'unknown');
  assert.equal(arg.partial, true);
  assert.equal(arg.reason, 'darwin-arm64-long-double-width-conflicts-with-apple-binary64');

  const fnReturn = DARWIN_ARM64_ABI.classifyFunctionReturn(
    { functionPrototype:{ returnType:'long double', returnBits:128, returnsValue:true } });
  assert.equal(fnReturn.reg, null);
  assert.equal(fnReturn.partial, true);
  assert.equal(fnReturn.unsupported, true);
  assert.equal(fnReturn.reason, 'darwin-arm64-long-double-width-conflicts-with-apple-binary64');

  const callReturn = DARWIN_ARM64_ABI.classifyCallReturn(
    { callPrototype:{ returnType:'long double', returnBits:128, returnsValue:true } });
  assert.equal(callReturn.reg, null);
  assert.equal(callReturn.unsupported, true);
});
