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

const malformedConvention = MICROSOFT_X64_ABI.classifyArguments({
  callPrototype:{ parameters:[{ type:'double', bits:64 }] },
}, {
  callingConvention:['microsoft-x64'],
});
assertConservative(malformedConvention, 'xmm0', 'structured calling convention');

console.log('issue-4039 ABI prototype metadata authority regression: ok');
