import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { recoverFunctionPrototype } from '../../../js/decompiler/types/prototype.js';
import {
  resolveABIPlugin, AAPCS64_ABI, DARWIN_ARM64_ABI, SYSV_AMD64_ABI,
  MICROSOFT_X64_ABI, MICROSOFT_VECTORCALL_ABI,
  RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI, UNKNOWN_ABI,
} from '../../../js/targets/abi/index.js';

// Frozen independently of the executable case loops: deleting a case cannot
// shrink the denominator. Each original grouped example remains represented.
export const REQUIRED_PROFILE_CASE_IDS = Object.freeze([
  "identity Apple arm64",
  "identity Apple arm64e",
  "identity AAPCS64",
  "identity SysV AMD64",
  "identity Microsoft x64",
  "identity Microsoft vectorcall",
  "identity RISC-V LP64",
  "identity RISC-V LP64F",
  "identity RISC-V LP64D",
  "identity unsupported",
  "Darwin scalar integer argument",
  "Darwin scalar floating argument",
  "Darwin scalar pointer argument",
  "Darwin scalar integer return",
  "Darwin scalar floating return",
  "AAPCS64 scalar integer argument",
  "AAPCS64 scalar floating argument",
  "AAPCS64 scalar pointer argument",
  "AAPCS64 scalar integer return",
  "AAPCS64 scalar floating return",
  "SysV scalar integer argument",
  "SysV scalar floating argument",
  "SysV scalar pointer argument",
  "SysV scalar integer return",
  "SysV scalar floating return",
  "Microsoft x64 scalar integer argument",
  "Microsoft x64 scalar floating argument",
  "Microsoft x64 scalar pointer argument",
  "Microsoft x64 scalar integer return",
  "Microsoft x64 scalar floating return",
  "Microsoft vectorcall scalar integer argument",
  "Microsoft vectorcall scalar floating argument",
  "Microsoft vectorcall scalar pointer argument",
  "Microsoft vectorcall scalar integer return",
  "Microsoft vectorcall scalar floating return",
  "RISC-V LP64 scalar integer argument",
  "RISC-V LP64 scalar floating argument",
  "RISC-V LP64 scalar pointer argument",
  "RISC-V LP64 scalar integer return",
  "RISC-V LP64 scalar floating return",
  "RISC-V LP64F scalar integer argument",
  "RISC-V LP64F scalar floating argument",
  "RISC-V LP64F scalar pointer argument",
  "RISC-V LP64F scalar integer return",
  "RISC-V LP64F scalar floating return",
  "RISC-V LP64D scalar integer argument",
  "RISC-V LP64D scalar floating argument",
  "RISC-V LP64D scalar pointer argument",
  "RISC-V LP64D scalar integer return",
  "RISC-V LP64D scalar floating return",
  "Darwin aggregate arguments",
  "Darwin aggregate missing alignment stays partial",
  "Darwin HFA arguments",
  "AAPCS64 aggregate arguments",
  "AAPCS64 HFA arguments",
  "SysV explicit INTEGER eightbytes",
  "SysV explicit SSE eightbytes",
  "SysV unknown aggregate is partial",
  "Microsoft x64 aggregate is indirect",
  "Microsoft x64 unknown aggregate stays partial",
  "Microsoft vectorcall HVA",
  "RISC-V LP64 small aggregate",
  "RISC-V LP64 large aggregate",
  "RISC-V LP64F small aggregate",
  "RISC-V LP64F large aggregate",
  "RISC-V LP64D small aggregate",
  "RISC-V LP64D large aggregate",
  "Darwin aggregate return",
  "AAPCS64 aggregate return",
  "SysV aggregate return",
  "RISC-V aggregate return",
  "AAPCS64 hidden sret",
  "Microsoft x64 hidden sret",
  "RISC-V hidden sret",
  "lp64f unknown-layout aggregate return remains partial",
  "lp64d unknown-layout aggregate return remains partial",
  "microsoft-vectorcall unknown-layout aggregate return remains partial",
  "darwin-arm64 known variadic frontier",
  "aapcs64 known variadic frontier",
  "sysv-amd64 known variadic frontier",
  "microsoft-x64 known variadic frontier",
  "microsoft-vectorcall known variadic frontier",
  "lp64 known variadic frontier",
  "lp64f known variadic frontier",
  "lp64d known variadic frontier",
  "unknown prototype remains conservative",
  "unknown ABI has no placements",
  "consumer rejects stale ABI evidence",
  "consumer rejects malformed ABI evidence",
  "consumer rejects architecture-mismatch ABI evidence",
  "consumer rejects conflict ABI evidence",
  "consumer publishes ABI semantic identity",
  "consumer groups AAPCS64 aggregate pieces",
  "consumer groups Darwin HFA pieces",
  "consumer groups vectorcall HVA pieces",
  "consumer preserves Microsoft aggregate-indirect class",
  "consumer groups RISC-V LP64 aggregate pieces",
  "consumer preserves aggregate return piece metadata",
  "consumer projects SysV aggregate return pieces",
]);

export function runRequiredProfileMatrix({ beforeCase = null } = {}) {
  const rows = [];
  function row(name, fn) {
    try {
      beforeCase?.(name);
      fn();
      rows.push({ status:'PASS', name });
    } catch (error) {
      rows.push({ status:'FAIL', name, detail:error?.message || String(error) });
    }
  }

  function classifyArguments(abi, parameters, extra = {}) {
    const callPrototype = { parameters, ...extra };
    return abi.classifyArguments({ callPrototype }, { callPrototype });
  }

  function classifyReturn(abi, prototype) {
    return abi.classifyFunctionReturn({ functionPrototype:prototype, prototype, ...prototype });
  }

  function value(id, reg) { return { id, reg, uses:[{}] }; }

  function recover(abi, registers, types = {}, opts = {}) {
    const adapterOptions = abi.id === 'darwin-arm64'
      ? { architecture:'arm64', platform:'darwin' }
      : {};
    return recoverFunctionPrototype(
      { args:new Map(registers.map((reg, index) => [reg, value(index + 1, reg)])), instructions:[] },
      { values:new Map(), ...types },
      { ...opts, abiAdapter:semanticAbiAdapter(abi, adapterOptions) },
    );
  }

  function registers(entry) {
    return Array.isArray(entry?.regs) ? entry.regs : entry?.reg ? [entry.reg] : [];
  }

  const profileCases = [
    ['Apple arm64', { architecture:'arm64', platform:'darwin' }, 'darwin-arm64'],
    ['Apple arm64e', { architecture:'arm64e', platform:'darwin' }, 'darwin-arm64'],
    ['AAPCS64', { architecture:'arm64', platform:'linux' }, 'aapcs64'],
    ['SysV AMD64', { architecture:'x86_64', platform:'linux' }, 'sysv-amd64'],
    ['Microsoft x64', { architecture:'x86_64', platform:'windows' }, 'microsoft-x64'],
    ['Microsoft vectorcall', { architecture:'x86_64', platform:'windows', abiId:'microsoft-vectorcall' }, 'microsoft-vectorcall'],
    ['RISC-V LP64', { architecture:'riscv64', platform:'linux', abiId:'lp64' }, 'lp64'],
    ['RISC-V LP64F', { architecture:'riscv64', platform:'linux', abiId:'lp64f' }, 'lp64f'],
    ['RISC-V LP64D', { architecture:'riscv64', platform:'linux', abiId:'lp64d' }, 'lp64d'],
    ['unsupported', { architecture:'mips64', platform:'linux' }, 'unknown'],
  ];
  for (const [name, target, expected] of profileCases) {
    row(`identity ${name}`, () => assert.equal(resolveABIPlugin(target).id, expected));
  }

  const scalarProfiles = [
    [DARWIN_ARM64_ABI, 'Darwin', 'x0', 'v0', 'x0', 'fp'],
    [AAPCS64_ABI, 'AAPCS64', 'x0', 'v0', 'x0', 'fp'],
    [SYSV_AMD64_ABI, 'SysV', 'rdi', 'xmm0', 'rdi', 'sse-scalar'],
    [MICROSOFT_X64_ABI, 'Microsoft x64', 'rcx', 'xmm0', 'rcx', 'fp'],
    [MICROSOFT_VECTORCALL_ABI, 'Microsoft vectorcall', 'rcx', 'xmm0', 'rcx', 'fp'],
    [RISCV_LP64_ABI, 'RISC-V LP64', 'x10', 'x10', 'x10', 'float-in-integer-register'],
    [RISCV_LP64F_ABI, 'RISC-V LP64F', 'x10', 'x10', 'x10', 'float-in-integer-register'],
    [RISCV_LP64D_ABI, 'RISC-V LP64D', 'x10', 'f10', 'x10', 'float'],
  ];
  for (const [abi, name, integerReg, fpReg, pointerReg, fpClass] of scalarProfiles) {
    for (const [scalar, parameter, expectedReg, expectedClass] of [
      ['integer', { type:'int64', bits:64 }, integerReg, 'integer'],
      ['floating', { type:'double', bits:64 }, fpReg, fpClass],
      ['pointer', { type:'void *', bits:64, pointer:true }, pointerReg, 'pointer'],
    ]) row(`${name} scalar ${scalar} argument`, () => {
      const result = classifyArguments(abi, [parameter]);
      assert.equal(result.partial, false);
      assert.deepEqual(registers(result.arguments[0]), [expectedReg]);
      assert.equal(result.arguments[0].abiClass, expectedClass);
    });
    row(`${name} scalar integer return`, () => {
      const integer = classifyReturn(abi, { returnType:'int64', returnBits:64, returnsValue:true });
      assert.deepEqual(registers(integer), [integerReg === 'rdi' || integerReg === 'rcx' ? 'rax' : integerReg]);
    });
    row(`${name} scalar floating return`, () => {
      const floating = classifyReturn(abi, { returnType:'double', returnBits:64, returnClass:'fp', returnsValue:true });
      assert.deepEqual(registers(floating), [fpReg]);
    });
  }

  const aggregate16 = { type:'struct Pair', aggregate:true, bits:128,
    members:[{ type:'uint64', bits:64, byteOffset:0 }, { type:'uint64', bits:64, byteOffset:8 }] };
  const aggregate32 = { type:'struct Big', aggregate:true, bits:256,
    members:Array.from({ length:4 }, (_unused, index) => ({ type:'uint64', bits:64, byteOffset:index * 8 })) };
  const hfa4 = { type:'struct HFA', aggregate:true, hfa:true, elementBits:32, bits:128,
    members:Array.from({ length:4 }, (_unused, index) => ({ type:'float', bits:32, byteOffset:index * 4 })) };
  const hva4 = { type:'struct HVA', aggregate:true, hva:true, members:4, elementBits:64, bits:256 };
  const sysvIntegerPair = { type:'struct Pair', aggregate:true, bits:128, eightbyteClasses:['INTEGER','INTEGER'] };
  const sysvSsePair = { type:'struct FPair', aggregate:true, bits:128, eightbyteClasses:['SSE','SSE'] };

  row('Darwin aggregate arguments', () => {
    // A positive placement needs layout alignment evidence. Keep the original
    // alignment-less descriptor as its own explicit conservative case below.
    const result = classifyArguments(DARWIN_ARM64_ABI, [{ ...aggregate16, alignmentBytes:8 }]);
    assert.equal(result.partial, false);
    assert.deepEqual(registers(result.arguments[0]), ['x0','x1']);
  });
  row('Darwin aggregate missing alignment stays partial', () => {
    const result = classifyArguments(DARWIN_ARM64_ABI, [aggregate16]);
    assert.equal(result.partial, true);
    assert.deepEqual(registers(result.arguments[0]), []);
    assert.equal(result.arguments[0].exact, false);
    assert.equal(result.arguments[0].reason, 'darwin-arm64-aggregate-alignment-not-proven');
  });
  row('Darwin HFA arguments', () => {
    const result = classifyArguments(DARWIN_ARM64_ABI, [hfa4]);
    assert.deepEqual(registers(result.arguments[0]), ['v0','v1','v2','v3']);
  });
  row('AAPCS64 aggregate arguments', () => {
    const result = classifyArguments(AAPCS64_ABI, [aggregate16]);
    assert.deepEqual(registers(result.arguments[0]), ['x0','x1']);
  });
  row('AAPCS64 HFA arguments', () => {
    const result = classifyArguments(AAPCS64_ABI, [hfa4]);
    assert.deepEqual(registers(result.arguments[0]), ['v0','v1','v2','v3']);
  });
  row('SysV explicit INTEGER eightbytes', () => {
    const result = classifyArguments(SYSV_AMD64_ABI, [sysvIntegerPair]);
    assert.equal(result.partial, false);
    assert.deepEqual(registers(result.arguments[0]), ['rdi','rsi']);
  });
  row('SysV explicit SSE eightbytes', () => {
    const result = classifyArguments(SYSV_AMD64_ABI, [sysvSsePair]);
    assert.equal(result.partial, false);
    assert.deepEqual(registers(result.arguments[0]), ['xmm0','xmm1']);
  });
  row('SysV unknown aggregate is partial', () => {
    assert.equal(classifyArguments(SYSV_AMD64_ABI, [aggregate16]).partial, true);
  });
  row('Microsoft x64 aggregate is indirect', () => {
    const result = classifyArguments(MICROSOFT_X64_ABI, [aggregate16]);
    assert.equal(result.partial, false);
    assert.equal(result.arguments[0].abiClass, 'aggregate-indirect');
    assert.equal(result.arguments[0].reg, 'rcx');
    assert.equal(result.arguments[0].pointer, true);
  });
  row('Microsoft x64 unknown aggregate stays partial', () => {
    assert.equal(classifyArguments(MICROSOFT_X64_ABI, [{ type:'struct Tiny', aggregate:true, bits:8 }]).partial, true);
  });
  row('Microsoft vectorcall HVA', () => {
    const result = classifyArguments(MICROSOFT_VECTORCALL_ABI, [hva4]);
    assert.equal(result.partial, false);
    assert.deepEqual(registers(result.arguments[0]), ['xmm0','xmm1','xmm2','xmm3']);
  });
  for (const [abi, name] of [[RISCV_LP64_ABI,'LP64'], [RISCV_LP64F_ABI,'LP64F'], [RISCV_LP64D_ABI,'LP64D']]) {
    row(`RISC-V ${name} small aggregate`, () => {
      const small = classifyArguments(abi, [aggregate16]);
      assert.equal(small.partial, false);
      assert.deepEqual(registers(small.arguments[0]), ['x10','x11']);
    });
    row(`RISC-V ${name} large aggregate`, () => {
      const large = classifyArguments(abi, [aggregate32]);
      assert.equal(large.partial, false);
      assert.equal(large.arguments[0].pointer, true);
      assert.equal(large.arguments[0].reg, 'x10');
    });
  }

  for (const [abi, name, parameter, expected] of [
    [DARWIN_ARM64_ABI, 'Darwin aggregate return', aggregate16, ['x0','x1']],
    [AAPCS64_ABI, 'AAPCS64 aggregate return', aggregate16, ['x0','x1']],
    [SYSV_AMD64_ABI, 'SysV aggregate return', sysvIntegerPair, ['rax','rdx']],
    [RISCV_LP64_ABI, 'RISC-V aggregate return', aggregate16, ['x10','x11']],
  ]) {
    row(name, () => {
      const result = classifyReturn(abi, { ...parameter, returnType:parameter.type, returnsValue:true });
      assert.deepEqual(registers(result), expected);
    });
  }
  row('AAPCS64 hidden sret', () => {
    const result = classifyReturn(AAPCS64_ABI, { ...aggregate32, returnType:'struct Big', returnsValue:true });
    assert.equal(result.indirect, true);
    assert.equal(result.hiddenResultPointer, 'x8');
  });
  row('Microsoft x64 hidden sret', () => {
    const result = classifyReturn(MICROSOFT_X64_ABI, { returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true });
    assert.equal(result.indirect, true);
    assert.equal(result.hiddenResultPointer.input, 'rcx');
  });
  row('RISC-V hidden sret', () => {
    const result = classifyReturn(RISCV_LP64_ABI, { ...aggregate32, returnType:'struct Big', returnsValue:true });
    assert.equal(result.indirect, true);
    assert.equal(result.hiddenResultPointer.input, 'x10');
  });
  for (const abi of [RISCV_LP64F_ABI, RISCV_LP64D_ABI, MICROSOFT_VECTORCALL_ABI]) {
    row(`${abi.id} unknown-layout aggregate return remains partial`, () => {
      assert.equal(classifyReturn(abi, { returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true }).partial, true);
    });
  }

  for (const abi of [DARWIN_ARM64_ABI, AAPCS64_ABI, SYSV_AMD64_ABI, MICROSOFT_X64_ABI, MICROSOFT_VECTORCALL_ABI, RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI]) {
    row(`${abi.id} known variadic frontier`, () => {
      const result = classifyArguments(abi, [{ type:'int64', bits:64 }], { variadic:true });
      assert.equal(result.stackArgsUnknown, true);
      assert.equal(result.stackArgsMayContainPointers, true);
    });
  }
  row('unknown prototype remains conservative', () => {
    const result = AAPCS64_ABI.classifyArguments({}, {});
    assert.equal(result.partial, true);
    assert.equal(result.stackArgsUnknown, true);
  });
  row('unknown ABI has no placements', () => {
    const result = classifyArguments(UNKNOWN_ABI, [{ type:'int64', bits:64 }]);
    assert.equal(result.unsupported, true);
    assert.deepEqual(result.arguments, []);
  });

  for (const [name, adapter] of [
    ['stale', { id:'aapcs64', semanticVersion:'1', semanticIdentity:'aapcs64@1', architectureId:'arm64' }],
    ['malformed', { id:'aapcs64' }],
    ['architecture-mismatch', { id:'aapcs64', semanticVersion:'2', semanticIdentity:'aapcs64@2', architectureId:'x86_64' }],
    ['conflict', { id:'aapcs64', semanticVersion:'2', semanticIdentity:'aapcs64@2', architectureId:'arm64', completeness:'conflict' }],
  ]) {
    row(`consumer rejects ${name} ABI evidence`, () => {
      const prototype = recoverFunctionPrototype(
        { args:new Map([['x0', value(1, 'x0')]]), instructions:[] },
        { values:new Map() },
        { abiAdapter:adapter },
      );
      assert.equal(prototype.conventionKnown, false);
      assert.deepEqual(prototype.arguments, []);
    });
  }
  row('consumer publishes ABI semantic identity', () => assert.equal(recover(AAPCS64_ABI, ['x0']).abiSemanticIdentity, 'aapcs64@2'));
  row('consumer groups AAPCS64 aggregate pieces', () => {
    const prototype = recover(AAPCS64_ABI, ['x0','x1'], {}, { functionPrototype:{ parameters:[aggregate16] } });
    assert.equal(prototype.arguments.length, 1);
    assert.deepEqual(prototype.arguments[0].regs, ['x0','x1']);
  });
  row('consumer groups Darwin HFA pieces', () => {
    const prototype = recover(DARWIN_ARM64_ABI, ['v0','v1','v2','v3'], {}, { functionPrototype:{ parameters:[hfa4] } });
    assert.equal(prototype.arguments.length, 1);
    assert.deepEqual(prototype.arguments[0].regs, ['v0','v1','v2','v3']);
  });
  row('consumer groups vectorcall HVA pieces', () => {
    const prototype = recover(MICROSOFT_VECTORCALL_ABI, ['xmm0','xmm1','xmm2','xmm3'], {}, { functionPrototype:{ parameters:[hva4] } });
    assert.equal(prototype.arguments.length, 1);
    assert.deepEqual(prototype.arguments[0].regs, ['ymm0','ymm1','ymm2','ymm3']);
  });
  row('consumer preserves Microsoft aggregate-indirect class', () => {
    const prototype = recover(MICROSOFT_X64_ABI, ['rcx'], {}, { functionPrototype:{ parameters:[aggregate16] } });
    assert.equal(prototype.arguments[0].abiClass, 'aggregate-indirect');
    assert.equal(prototype.arguments[0].pointer, true);
  });
  row('consumer groups RISC-V LP64 aggregate pieces', () => {
    const prototype = recover(RISCV_LP64_ABI, ['x10','x11'], {}, { functionPrototype:{ parameters:[aggregate16] } });
    assert.equal(prototype.arguments.length, 1);
    assert.deepEqual(prototype.arguments[0].regs, ['x10','x11']);
  });
  row('consumer preserves aggregate return piece metadata', () => {
    const prototype = recover(AAPCS64_ABI, ['x0','x1'], { ret:{ ...aggregate16, type:'struct Pair' } });
    assert.equal(prototype.returnLocations.length, 2);
    assert.ok(prototype.returnLocations.every((location) => location.abiClass));
  });
  row('consumer projects SysV aggregate return pieces', () => {
    const prototype = recover(SYSV_AMD64_ABI, ['rax','rdx'], { ret:{ type:'struct Pair', aggregate:true, bits:128, eightbyteClasses:['INTEGER','INTEGER'] } });
    assert.deepEqual(prototype.returnLocations.map((location) => location.reg), ['rax','rdx']);
  });

  return Object.freeze({ version:1, denominator:REQUIRED_PROFILE_CASE_IDS.length,
    rows:Object.freeze(rows.map(result => Object.freeze(result))) });
}

export function assertRequiredProfileMatrix(report) {
  assert.equal(report?.version, 1, 'matrix version');
  assert.equal(report.denominator, REQUIRED_PROFILE_CASE_IDS.length, 'frozen matrix denominator');
  assert.ok(Array.isArray(report.rows), 'matrix rows');
  assert.equal(report.rows.length, REQUIRED_PROFILE_CASE_IDS.length, 'every required case must terminate');
  for (let i = 0; i < report.rows.length; i++) {
    assert.ok(Object.hasOwn(report.rows, i), 'matrix must not contain holes');
    assert.ok(report.rows[i] && ['PASS', 'FAIL'].includes(report.rows[i].status), 'unknown/skipped states are not terminal evidence');
  }
  assert.deepEqual(report.rows.map(result => result.name).sort(), [...REQUIRED_PROFILE_CASE_IDS].sort(),
    'missing, duplicated or extra case identity');
  assert.deepEqual(report.rows.filter(result => result.status !== 'PASS'), [], 'required profile failures');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runRequiredProfileMatrix();
  for (const result of report.rows) console.log(`${result.status} | ${result.name}${result.detail ? ` | ${result.detail}` : ''}`);
  const failures = report.rows.filter(result => result.status === 'FAIL');
  console.log(`MATRIX_SUMMARY total=${report.rows.length} passed=${report.rows.length - failures.length} failed=${failures.length}`);
  assertRequiredProfileMatrix(report);
}
