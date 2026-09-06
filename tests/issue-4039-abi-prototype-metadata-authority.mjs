import assert from 'node:assert/strict';

import {
  DARWIN_ARM64_ABI,
  MICROSOFT_X64_ABI,
  RISCV_LP64D_ABI,
  SYSV_AMD64_ABI,
} from '../js/targets/abi/index.js';

function exactRegister(result, reg) {
  return Array.isArray(result?.arguments) && result.arguments.some((argument) => {
    const usesRegister = argument?.reg === reg || argument?.regs?.includes?.(reg);
    return usesRegister
      && argument?.exact !== false
      && argument?.possible !== true
      && argument?.certainty !== 'unknown';
  });
}

function assertConservative(result, forbiddenRegister, label) {
  assert.equal(result?.partial, true, `${label}: malformed metadata must be partial`);
  assert.equal(exactRegister(result, forbiddenRegister), false,
    `${label}: malformed metadata must not mint exact ${forbiddenRegister} placement`);
}

const exactCases = [
  ['sysv-amd64', SYSV_AMD64_ABI, 'xmm0'],
  ['microsoft-x64', MICROSOFT_X64_ABI, 'xmm0'],
  ['darwin-arm64', DARWIN_ARM64_ABI, 'v0'],
  ['riscv-lp64d', RISCV_LP64D_ABI, 'f10'],
];

for (const [label, abi, register] of exactCases) {
  const result = abi.classifyArguments({
    callPrototype: {
      parameters: [{ type:'double', bits:64 }],
    },
  });
  assert.equal(exactRegister(result, register), true,
    `${label}: primitive string/number metadata must preserve existing exact FP placement`);
}

for (const [label, abi, register] of exactCases) {
  const result = abi.classifyArguments({
    callPrototype: {
      parameters: [{
        type: { toString() { return 'double'; } },
        bits:64,
      }],
    },
  });
  assertConservative(result, register, `${label} structured type`);
}

for (const [label, abi, register] of exactCases) {
  const result = abi.classifyArguments({
    callPrototype: {
      parameters: [{ type:'double', bits:[64] }],
    },
  });
  assertConservative(result, register, `${label} structured bits`);
}

const sysvAggregate = SYSV_AMD64_ABI.classifyArguments({
  callPrototype: {
    parameters: [{
      aggregate:true,
      bits:['128'],
      eightbyteClasses:[['INTEGER'], ['SSE']],
    }],
  },
});
assertConservative(sysvAggregate, 'rdi', 'sysv structured aggregate classes');
assert.equal(exactRegister(sysvAggregate, 'xmm0'), false,
  'sysv structured aggregate classes must not mint mixed INTEGER/SSE placement');

const riscvVector = RISCV_LP64D_ABI.classifyArguments({
  callingConvention:'riscv-vector-variant',
  callPrototype: {
    parameters: [{
      type:'vector',
      vector:true,
      bits:128,
      lmul:[8],
      tupleCount:[2],
    }],
  },
});
assert.equal(riscvVector?.partial, true,
  'RISC-V structured LMUL/tupleCount must fail closed');
assert.equal(exactRegister(riscvVector, 'v8'), false,
  'RISC-V structured LMUL/tupleCount must not mint an exact vector group');

for (const [label, abi] of exactCases) {
  const result = abi.classifyFunctionReturn({
    functionPrototype: {
      returnType: { toString() { return 'double'; } },
      returnBits:64,
      returnsValue:true,
    },
  });
  assert.equal(result?.partial, true, `${label}: malformed return type must be partial`);
  assert.equal(result?.reg ?? null, null, `${label}: malformed return type must not mint a return register`);
  assert.equal(result?.exact, false, `${label}: malformed return type must be explicitly non-exact`);
}

const providerResult = SYSV_AMD64_ABI.classifyArguments(
  { callTarget:0x1234n },
  {
    callPrototypeFor() {
      return { parameters:[{ type:['double'], bits:64 }] };
    },
  },
);
assertConservative(providerResult, 'xmm0', 'provider-supplied structured prototype');

const validProviderResult = SYSV_AMD64_ABI.classifyArguments(
  { callTarget:0x1234n },
  {
    callPrototypeFor() {
      return { parameters:[{ type:'double', bits:64 }] };
    },
  },
);
assert.equal(exactRegister(validProviderResult, 'xmm0'), true,
  'valid provider-supplied prototype must preserve exact FP placement');

let providerGetReads = 0;
const throwingProviderGetOptions = new Proxy({}, {
  get(target, key, receiver) {
    if (key === 'callPrototypeFor') {
      providerGetReads += 1;
      throw new Error('provider get trap');
    }
    return Reflect.get(target, key, receiver);
  },
});
assertConservative(SYSV_AMD64_ABI.classifyArguments(
  { callTarget:0x1234n },
  throwingProviderGetOptions,
), 'xmm0', 'provider callPrototypeFor get trap');
const throwingProviderGetReturn = SYSV_AMD64_ABI.classifyCallReturn(
  { callTarget:0x1234n },
  throwingProviderGetOptions,
);
assert.equal(throwingProviderGetReturn?.reg ?? null, null,
  'provider get trap must not mint a return register');
assert.equal(providerGetReads, 0,
  'provider boundary must not invoke caller get traps while snapshotting callPrototypeFor');

let providerAccessorReads = 0;
const throwingProviderAccessorOptions = {};
Object.defineProperty(throwingProviderAccessorOptions, 'callPrototypeFor', {
  enumerable:true,
  get() {
    providerAccessorReads += 1;
    throw new Error('provider accessor trap');
  },
});
assertConservative(SYSV_AMD64_ABI.classifyArguments(
  { callTarget:0x1234n },
  throwingProviderAccessorOptions,
), 'xmm0', 'provider callPrototypeFor accessor');
const throwingProviderAccessorReturn = SYSV_AMD64_ABI.classifyCallReturn(
  { callTarget:0x1234n },
  throwingProviderAccessorOptions,
);
assert.equal(throwingProviderAccessorReturn?.partial, true,
  'provider accessor call-return must be partial');
assert.equal(throwingProviderAccessorReturn?.reg ?? null, null,
  'provider accessor call-return must not mint a return register');
assert.equal(throwingProviderAccessorReturn?.reason, 'abi-prototype-metadata-invalid',
  'provider accessor call-return must report invalid metadata');
assert.equal(providerAccessorReads, 0,
  'provider boundary must reject accessors without invoking them');

const throwingProviderDescriptorOptions = new Proxy({}, {
  getOwnPropertyDescriptor(target, key) {
    if (key === 'callPrototypeFor') throw new Error('provider descriptor trap');
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
});
assertConservative(SYSV_AMD64_ABI.classifyArguments(
  { callTarget:0x1234n },
  throwingProviderDescriptorOptions,
), 'xmm0', 'provider callPrototypeFor descriptor trap');
const throwingProviderDescriptorReturn = SYSV_AMD64_ABI.classifyCallReturn(
  { callTarget:0x1234n },
  throwingProviderDescriptorOptions,
);
assert.equal(throwingProviderDescriptorReturn?.partial, true,
  'provider descriptor trap call-return must be partial');
assert.equal(throwingProviderDescriptorReturn?.reg ?? null, null,
  'provider descriptor trap call-return must not mint a return register');
assert.equal(throwingProviderDescriptorReturn?.reason, 'abi-prototype-metadata-invalid',
  'provider descriptor trap call-return must report invalid metadata');

const throwingPrototype = new Proxy({}, {
  getPrototypeOf() { throw new Error('prototype reflection trap'); },
});
assertConservative(SYSV_AMD64_ABI.classifyArguments({ callPrototype:throwingPrototype }),
  'xmm0', 'explicit prototype getPrototypeOf trap');
assertConservative(SYSV_AMD64_ABI.classifyArguments(
  { callTarget:0x1234n },
  { callPrototypeFor() { return throwingPrototype; } },
), 'xmm0', 'provider prototype getPrototypeOf trap');

const throwingDescriptorPrototype = new Proxy({}, {
  getOwnPropertyDescriptor() { throw new Error('prototype descriptor trap'); },
});
assertConservative(MICROSOFT_X64_ABI.classifyArguments({ callPrototype:throwingDescriptorPrototype }),
  'xmm0', 'explicit prototype getOwnPropertyDescriptor trap');
assertConservative(MICROSOFT_X64_ABI.classifyArguments(
  { callTarget:0x1234n },
  { callPrototypeFor() { return throwingDescriptorPrototype; } },
), 'xmm0', 'provider prototype getOwnPropertyDescriptor trap');

const trappedCallReturn = SYSV_AMD64_ABI.classifyCallReturn({ callPrototype:throwingPrototype });
assert.equal(trappedCallReturn?.partial, true,
  'reflective call-return prototype must be partial');
assert.equal(trappedCallReturn?.reg ?? null, null,
  'reflective call-return prototype must not mint a return register');
assert.equal(trappedCallReturn?.reason, 'abi-prototype-metadata-invalid',
  'reflective call-return prototype must report invalid metadata');

const throwingConventionMetadata = new Proxy({
  callingConvention:'microsoft-x64',
  callPrototype:{ parameters:[{ type:'double', bits:64 }] },
}, {
  getOwnPropertyDescriptor(target, key) {
    if (key === 'callingConvention') throw new Error('calling-convention descriptor trap');
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
});
assertConservative(MICROSOFT_X64_ABI.classifyArguments(throwingConventionMetadata),
  'xmm0', 'calling-convention getOwnPropertyDescriptor trap');

const malformedConvention = MICROSOFT_X64_ABI.classifyArguments({
  callPrototype:{ parameters:[{ type:'double', bits:64 }] },
}, {
  callingConvention:['microsoft-x64'],
});
assertConservative(malformedConvention, 'xmm0', 'structured calling convention');

const malformedInstructionConvention = RISCV_LP64D_ABI.classifyArguments({
  callingConvention:['riscv-vector-variant'],
  callPrototype: {
    parameters: [{
      type:'vector',
      vector:true,
      bits:128,
      lmul:1,
      tupleCount:1,
    }],
  },
});
assert.equal(malformedInstructionConvention?.partial, true,
  'RISC-V structured instruction calling convention must fail closed');
assert.equal(exactRegister(malformedInstructionConvention, 'v8'), false,
  'RISC-V structured instruction calling convention must not select the vector ABI');

console.log('issue-4039 ABI prototype metadata authority regression: ok');
