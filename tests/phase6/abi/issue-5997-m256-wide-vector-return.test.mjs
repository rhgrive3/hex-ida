import assert from 'node:assert/strict';
import {
  classifyMicrosoftX64FunctionReturn,
  classifyMicrosoftX64CallReturn,
  classifyMicrosoftX64Arguments,
  microsoftX64ReturnResult,
} from '../../../js/targets/abi/microsoft-x64.js';

// Issue #5997: the return-side vector recognizer must match the parameter
// side. `__m256*` spellings are 256-bit vectors and must never be classified
// as integer scalars returned in RAX (nor silently truncated to 128 bits).

const r256 = classifyMicrosoftX64FunctionReturn({
  functionPrototype: { returnType: '__m256', returnBits: 256, returnsValue: true },
});
assert.equal(r256.reg, null, 'wide vector return must not mint a register fact');
assert.equal(r256.partial, true);
assert.equal(r256.unsupported, true);
assert.equal(r256.vector, true);
assert.equal(r256.bits, 256);
assert.equal(r256.reason, 'microsoft-x64-wide-vector-return-not-modeled');

const call256 = classifyMicrosoftX64CallReturn({
  callPrototype:{ returnType:'__m256', returnBits:256, returnsValue:true },
});
assert.deepEqual(call256, r256, 'call and function projections preserve the same unsupported shape');

// Diagnostic width is not permission to invent a location, and malformed
// decision metadata must not be coerced into a proven vector width.
for (const bits of [0, -1, 32.5, NaN, Infinity, '256', null, undefined]) {
  const unknown = microsoftX64ReturnResult({ kind:'unknown', vector:true, bits, reg:'rax', unsupported:true });
  assert.equal(unknown.reg, null);
  assert.equal(unknown.partial, true);
  assert.equal(unknown.unsupported, true);
  assert.equal(unknown.vector, true);
  assert.equal(unknown.bits, null);
}
const untyped = microsoftX64ReturnResult({ kind:'unknown', bits:256 });
assert.equal(Object.hasOwn(untyped, 'vector'), false);
assert.equal(Object.hasOwn(untyped, 'bits'), false);

// Without explicit returnBits, `__m256` still identifies by name.
const r256NoBits = classifyMicrosoftX64FunctionReturn({
  functionPrototype: { returnType: '__m256', returnsValue: true },
});
assert.equal(r256NoBits.unsupported, true);
assert.equal(r256NoBits.vector, true);
assert.equal(r256NoBits.reg, null);

// Variant spellings are covered by the same recognizer.
for (const returnType of ['__m256i', '__m256d']) {
  const r = classifyMicrosoftX64FunctionReturn({
    functionPrototype: { returnType, returnBits: 256, returnsValue: true },
  });
  assert.equal(r.unsupported, true, `${returnType} must fail closed`);
  assert.equal(r.reg, null);
  assert.equal(r.partial, true, `${returnType} must not claim an exact result`);
}

// Arguments pipeline stays consistent: an unmodeled wide-vector return is an
// unproven return shape, so it must go conservative (no exact arg layout) and
// must not deny a possible hidden result pointer.
const args = classifyMicrosoftX64Arguments({
  callPrototype: { returnType: '__m256', returnBits: 256, returnsValue: true, args: [] },
});
assert.equal(args.partial, true);
assert.equal(args.reason, 'microsoft-x64-wide-vector-return-not-modeled');
assert.equal(args.hiddenResultPossible, true);

// `__m128` XMM0 path is preserved.
const r128 = classifyMicrosoftX64FunctionReturn({
  functionPrototype: { returnType: '__m128', returnBits: 128, returnsValue: true },
});
assert.equal(r128.reg, 'xmm0');
assert.equal(r128.bits, 128);
assert.equal(r128.partial, undefined);

// Integer returns are untouched.
const rInt = classifyMicrosoftX64FunctionReturn({
  functionPrototype: { returnType: 'long long', returnBits: 64, returnsValue: true },
});
assert.deepEqual({ reg:rInt.reg, bits:rInt.bits, kind:rInt.kind }, { reg:'rax', bits:64, kind:undefined });

console.log('issue-5997 microsoft-x64 wide vector return fail-closed: ok');
