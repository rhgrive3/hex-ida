import assert from 'node:assert/strict';
import {
  classifyMicrosoftVectorcallArguments,
  classifyMicrosoftVectorcallFunctionReturn,
} from '../../../js/targets/abi/microsoft-vectorcall.js';

const floatHva4 = (type = 'HF4') => ({
  hva: true, bits: 128, bytes: 16, type,
  members: [
    { type: 'float', bits: 32, bytes: 4, byteOffset: 0 },
    { type: 'float', bits: 32, bytes: 4, byteOffset: 4 },
    { type: 'float', bits: 32, bytes: 4, byteOffset: 8 },
    { type: 'float', bits: 32, bytes: 4, byteOffset: 12 },
  ],
});
const doubleHva2 = (type = 'HD2') => ({
  hva: true, bits: 128, bytes: 16, type,
  members: [
    { type: 'double', bits: 64, bytes: 8, byteOffset: 0 },
    { type: 'double', bits: 64, bytes: 8, byteOffset: 8 },
  ],
});
const m256Hva4 = () => ({
  hva: true, bits: 1024, bytes: 128, type: 'HM256x4',
  members: Array.from({ length: 4 }, (_unused, index) => ({
    type: '__m256', bits: 256, bytes: 32, byteOffset: index * 32,
  })),
});

// #5998: a __vectorcall vector type includes the floating-point types, so an
// HVA of 32-bit floats is valid. The 64-bit element minimum demoted every
// float HVA to `hva-unproven` partial.
{
  const result = classifyMicrosoftVectorcallArguments({ callPrototype: {
    callingConvention: '__vectorcall', args: [floatHva4()],
  } });
  const entry = result.arguments[0];
  assert.equal(entry.location, 'register', `${entry.reason ?? ''}`);
  assert.equal(entry.reg, 'xmm0');
  assert.equal(entry.abiClass, 'hva');
  assert.equal(entry.partial ?? false, false);
  assert.deepEqual(entry.regs, ['xmm0', 'xmm1', 'xmm2', 'xmm3']);
  assert.equal(entry.vectorElementBits, 32);
}

// Double HVAs keep their existing behavior.
{
  const result = classifyMicrosoftVectorcallArguments({ callPrototype: {
    callingConvention: '__vectorcall', args: [doubleHva2()],
  } });
  assert.equal(result.arguments[0].location, 'register');
  assert.equal(result.arguments[0].reg, 'xmm0');
}

// Float HVA consumes vector registers positionally alongside other vectors.
{
  const result = classifyMicrosoftVectorcallArguments({ callPrototype: {
    callingConvention: '__vectorcall',
    args: [{ type: '__m128', vector: true, bits: 128 }, floatHva4()],
  } });
  assert.equal(result.arguments[0].reg, 'xmm0');
  assert.equal(result.arguments[1].reg, 'xmm1');
  assert.deepEqual(result.arguments[1].regs, ['xmm1', 'xmm2', 'xmm3', 'xmm4']);
}


 // HVA return uses the same strict physical layout proof as arguments.
{
  const result = classifyMicrosoftVectorcallFunctionReturn({ prototype: floatHva4() });
  assert.equal(result.reg, 'xmm0');
  assert.deepEqual(result.regs, ['xmm0', 'xmm1', 'xmm2', 'xmm3']);
  assert.equal(result.elementBits, 32);
  assert.equal(result.bytes, 16);
}
{
  const result = classifyMicrosoftVectorcallFunctionReturn({ prototype: m256Hva4() });
  assert.equal(result.reg, 'ymm0');
  assert.deepEqual(result.regs, ['ymm0', 'ymm1', 'ymm2', 'ymm3']);
  assert.equal(result.elementBits, 256);
}
{
  const malformed = floatHva4();
  malformed.members[1] = { ...malformed.members[1], byteOffset: 8 };
  const result = classifyMicrosoftVectorcallFunctionReturn({ prototype: malformed });
  assert.equal(result.reg, null);
  assert.equal(result.partial, true);
  assert.equal(result.reason, 'microsoft-vectorcall-hva-return-layout-not-proven');
}
{
  const tooMany = {
    hva: true, bits: 160, bytes: 20, type: 'HF5',
    members: Array.from({ length: 5 }, (_unused, index) => ({
      type: 'float', bits: 32, bytes: 4, byteOffset: index * 4,
    })),
  };
  const result = classifyMicrosoftVectorcallFunctionReturn({ prototype: tooMany });
  assert.equal(result.reg, null);
  assert.equal(result.partial, true);
  assert.equal(result.reason, 'microsoft-vectorcall-hva-return-layout-not-proven');
}

// Non-canonical element widths (non power-of-two vector widths) stay unproven.
{
  const bogus = { hva: true, bits: 192, bytes: 24, members: [
    { type: 'float', bits: 96, bytes: 12, byteOffset: 0 },
    { type: 'float', bits: 96, bytes: 12, byteOffset: 12 },
  ] };
  const result = classifyMicrosoftVectorcallArguments({ callPrototype: {
    callingConvention: '__vectorcall', args: [bogus],
  } });
  assert.equal(result.arguments[0].location, 'unknown');
  assert.equal(result.arguments[0].partial, true);
}

console.log('vectorcall float HVA element authority (#5998): PASS');
