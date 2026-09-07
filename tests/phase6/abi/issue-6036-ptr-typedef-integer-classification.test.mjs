import assert from 'node:assert/strict';

import {
  MICROSOFT_X64_ABI,
  classifyMicrosoftX64Arguments,
  parameterClass,
} from '../../../js/targets/abi/microsoft-x64.js';
import { classifyMicrosoftVectorcallArguments } from '../../../js/targets/abi/microsoft-vectorcall.js';
import { SYSV_AMD64_ABI } from '../../../js/targets/abi/sysv-amd64.js';
import { AAPCS64_ABI } from '../../../js/targets/abi/aapcs64.js';
import { DARWIN_ARM64_ABI } from '../../../js/targets/abi/darwin-arm64.js';
import { RISCV_LP64_ABI, RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

/* C integer typedefs whose spellings contain "ptr" are integers, not
 * pointers. The pointer heuristic must not match bare substrings. */
const INTEGER_PTR_TYPEDEF_TYPES = ['uintptr_t', 'intptr_t', 'ptrdiff_t'];
/* Controls that must keep being classified as pointers. */
const POINTER_CONTROLS = ['void *', 'int *', 'const char *', 'void*', 'char *'];

const parameterClassifiers = [
  ['microsoft-x64', parameterClass],
  ['sysv-amd64', null], // exercised through the ABI plugin below
];

for (const type of INTEGER_PTR_TYPEDEF_TYPES) {
  const classified = parameterClass({ type });
  assert.equal(classified.pointer, false,
    `microsoft-x64 parameterClass: ${type} must not be classified as a pointer`);
  assert.equal(classified.aggregate, false,
    `microsoft-x64 parameterClass: ${type} must not be classified as an aggregate`);

  const call = classifyMicrosoftX64Arguments({ callPrototype:{ args:[{ type }] } });
  assert.equal(call.arguments[0]?.pointer, false,
    `microsoft-x64 arguments: ${type} must not be classified as a pointer`);
  assert.equal(call.arguments[0]?.abiClass, 'integer',
    `microsoft-x64 arguments: ${type} must classify as integer`);
  assert.equal(call.arguments[0]?.reg, 'rcx');

  const vectorcall = classifyMicrosoftVectorcallArguments({ callPrototype:{ callingConvention:'vectorcall', args:[{ type }] } });
  assert.equal(vectorcall.arguments[0]?.pointer, false,
    `microsoft-vectorcall inherits microsoft-x64 parameterClass: ${type} must not be a pointer`);

  for (const [label, abi] of [
    ['sysv-amd64', SYSV_AMD64_ABI],
    ['aapcs64', AAPCS64_ABI],
    ['darwin-arm64', DARWIN_ARM64_ABI],
    ['riscv-lp64', RISCV_LP64_ABI],
    ['riscv-lp64d', RISCV_LP64D_ABI],
  ]) {
    const result = abi.classifyArguments({ callPrototype:{ args:[{ type }] } });
    const entry = result.arguments.find((argument) => argument?.index === 0);
    assert.ok(entry, `${label}: ${type} must produce an argument entry`);
    assert.equal(entry.pointer === true || entry.abiClass === 'pointer', false,
      `${label}: ${type} must not be classified as a pointer`);
  }
}

for (const type of POINTER_CONTROLS) {
  const classified = parameterClass({ type });
  assert.equal(classified.pointer, true,
    `microsoft-x64 parameterClass: ${type} must stay a pointer`);

  for (const [label, abi] of [
    ['sysv-amd64', SYSV_AMD64_ABI],
    ['aapcs64', AAPCS64_ABI],
    ['darwin-arm64', DARWIN_ARM64_ABI],
    ['riscv-lp64d', RISCV_LP64D_ABI],
  ]) {
    const result = abi.classifyArguments({ callPrototype:{ args:[{ type }] } });
    const entry = result.arguments.find((argument) => argument?.index === 0);
    assert.ok(entry, `${label}: ${type} must produce an argument entry`);
    assert.equal(entry.pointer === true || entry.abiClass === 'pointer', true,
      `${label}: ${type} must stay a pointer`);
  }
}

/* Explicit pointer metadata must stay authoritative. */
for (const meta of [{ pointer:true }, { isPointer:true }]) {
  assert.equal(parameterClass({ ...meta, type:'uintptr_t' }).pointer, true,
    'explicit pointer metadata must win over the type spelling');
}

/* A standalone `pointer` ABI class is a canonical class word. */
assert.equal(parameterClass({ type:'int', abiClass:'pointer' }).pointer, true,
  'standalone abiClass "pointer" must classify as pointer');
assert.equal(parameterClass({ type:'int', kind:'ptr' }).pointer, true,
  'standalone kind "ptr" must classify as pointer');

/* A stack-placed uintptr_t alone must not claim pointer presence. */
{
  const result = classifyMicrosoftX64Arguments({
    callPrototype:{ args:[
      { type:'int64_t' }, { type:'int64_t' }, { type:'int64_t' }, { type:'int64_t' },
      { type:'uintptr_t' },
    ] },
  });
  const stackEntry = result.stackArguments.find((entry) => entry.index === 4);
  assert.ok(stackEntry, 'fifth scalar argument must be placed on the stack');
  assert.equal(stackEntry.pointer, false, 'stack uintptr_t must not be a pointer');
  assert.equal(result.stackArgsMayContainPointers, false,
    'integer-only stack arguments must not claim stack pointer presence');
}

/* The plugins expose the same classifier through the plugin surface. */
assert.equal(MICROSOFT_X64_ABI.id, 'microsoft-x64');
for (const type of INTEGER_PTR_TYPEDEF_TYPES) {
  const result = MICROSOFT_X64_ABI.classifyArguments({ callPrototype:{ args:[{ type }] } });
  assert.equal(result.arguments[0]?.abiClass, 'integer');
}

void parameterClassifiers;
