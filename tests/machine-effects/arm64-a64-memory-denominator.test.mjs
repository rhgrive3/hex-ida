import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { ARM64_MEMORY_EFFECT_MNEMONICS } from '../../js/targets/architecture/arm64/effects/memory.js';
import {
  ARM64_A64_MEMORY_DENOMINATOR_ID,
  ARM64_A64_MEMORY_ENCODING_FAMILIES,
  ARM64_A64_MEMORY_EXACT_MNEMONICS,
  ARM64_A64_MEMORY_LOCKED_CASE_COUNT,
  ARM64_A64_MEMORY_LOCKED_CORPUS_SHA256,
  ARM64_A64_MEMORY_PARTIAL_MNEMONICS,
  arm64A64MemoryDecoderDependencyProof,
  arm64A64MemoryEncodingCases,
  validateArm64A64MemoryDenominator,
} from '../../tools/validation/machine-effects/arm64-a64-memory-denominator.mjs';
import { validateArm64A64DecoderDependencyProof } from '../../tools/validation/machine-effects/arm64-a64-decoder-denominator.mjs';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
}
function executable(candidates) { return candidates.find((candidate) => fs.existsSync(candidate)); }
function assembleCases(cases) {
  const clang = executable(['/usr/bin/clang-18','/usr/bin/clang','/usr/local/swift/usr/bin/clang']);
  const objdump = executable(['/usr/bin/llvm-objdump-18','/usr/bin/llvm-objdump','/usr/local/swift/usr/bin/llvm-objdump']);
  assert.ok(clang, 'LLVM/Clang AArch64 integrated assembler is required');
  assert.ok(objdump, 'LLVM objdump AArch64 disassembler is required');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arm64-memory-denominator-'));
  const source = path.join(directory, 'memory.s');
  const object = path.join(directory, 'memory.o');
  try {
    fs.writeFileSync(source, `.text\n${cases.map((current) => current.asm).join('\n')}\n`);
    const assembled = spawnSync(clang, ['-target','aarch64-none-elf','-march=armv8.1-a+lse','-c',source,'-o',object], { encoding:'utf8' });
    assert.equal(assembled.status, 0, assembled.stderr);
    const disassembled = spawnSync(objdump, ['-d',object], { encoding:'utf8' });
    assert.equal(disassembled.status, 0, disassembled.stderr);
    const rows = [...disassembled.stdout.matchAll(/^\s*[0-9a-f]+:\s+([0-9a-f]{8})\s+([^\n]+)$/gmi)]
      .map((match) => Object.freeze({ word:Number.parseInt(match[1],16) >>> 0, llvmText:match[2].trim() }));
    assert.equal(rows.length, cases.length, 'LLVM oracle instruction count drift');
    return rows;
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
}
function decodedInstruction(raw, id, word = null) {
  return {
    instructionId:id,
    address:raw.address,
    mnemonic:raw.mnemonic,
    operands:raw.opStr,
    opStr:raw.opStr,
    ops:parseOperands(raw.opStr),
    ...(word == null ? {} : { word }),
    mode:'a64',
    origin:{ instructionIds:[id] },
  };
}
function accesses(bundle) {
  const out = [];
  for (const operation of bundle.operations) {
    if (operation.kind === 'memory-read') out.push({ direction:'read', access:operation.access });
    if (operation.kind === 'memory-write') out.push({ direction:'write', access:operation.access });
    if (operation.kind === 'intrinsic') {
      for (const access of operation.effectSummary?.memoryRead?.accesses || []) out.push({ direction:'read', access });
      for (const access of operation.effectSummary?.memoryWrite?.accesses || []) out.push({ direction:'write', access });
    }
  }
  return out;
}

const denominator = validateArm64A64MemoryDenominator();
assert.equal(denominator.denominatorId, ARM64_A64_MEMORY_DENOMINATOR_ID);
assert.equal(denominator.encodingFamilyCount, 9);
assert.equal(denominator.encodingCaseCount, 267);
assert.equal(denominator.mnemonicCount, 123);
assert.equal(denominator.partialMnemonicCount, 0);
assert.equal(denominator.exactMnemonicCount, 123);
assert.equal(denominator.encodingCaseCount, ARM64_A64_MEMORY_LOCKED_CASE_COUNT);
assert.equal(denominator.corpusSha256, ARM64_A64_MEMORY_LOCKED_CORPUS_SHA256);
assert.match(denominator.corpusSha256, /^[0-9a-f]{64}$/);

const memoryDependencyProof = arm64A64MemoryDecoderDependencyProof();
assert.equal(validateArm64A64DecoderDependencyProof('memory', memoryDependencyProof), true);
assert.equal(validateArm64A64DecoderDependencyProof('simd', memoryDependencyProof), false, 'a memory proof must never satisfy the SIMD dependency');
for (const damaged of [
  { ...memoryDependencyProof, observedCorpusSha256:'b'.repeat(64) },
  { ...memoryDependencyProof, encodingCaseCount:ARM64_A64_MEMORY_LOCKED_CASE_COUNT - 1 },
  { ...memoryDependencyProof, coverageState:'partial' },
  { ...memoryDependencyProof, independentAuthority:false },
  { ...memoryDependencyProof, oracleIds:['production-effect-registry-memory','deployed-capstone-5-arm64'] },
]) assert.equal(validateArm64A64DecoderDependencyProof('memory', damaged), false);
assert.equal(new Set(ARM64_A64_MEMORY_ENCODING_FAMILIES.map(({ id }) => id)).size, 9);
assert.deepEqual(
  [...ARM64_MEMORY_EFFECT_MNEMONICS].sort(),
  [...ARM64_A64_MEMORY_EXACT_MNEMONICS, ...ARM64_A64_MEMORY_PARTIAL_MNEMONICS].sort(),
  'production memory registry drifted from the independently-declared denominator',
);

const cases = [...arm64A64MemoryEncodingCases()];
const llvmRows = assembleCases(cases);
const session = await createCapstoneArm64Session();
try {
  for (let index = 0; index < cases.length; index++) {
    const current = cases[index];
    const oracle = llvmRows[index];
    const raw = session.decode(bytes32(oracle.word), 0x400000n + BigInt(index * 4));
    assert.equal(raw.length, 1, `${current.id}:Capstone rejected LLVM encoding 0x${oracle.word.toString(16)}:${oracle.llvmText}`);
    assert.equal(raw[0].mnemonic, current.mnemonic, `${current.id}:decoder mnemonic drift:${raw[0].opStr}`);
    const effects = liftArm64MachineEffects(decodedInstruction(raw[0], `arm64-memory-denominator:${current.id}`, oracle.word));
    assert.ok(effects, `${current.id}:registry-owned decoder form escaped memory ownership`);
    assert.equal(effects.completeness, current.completeness, `${current.id}:${raw[0].mnemonic}:${raw[0].opStr}:${effects.unknownEffects?.reason}`);

    if (current.completeness === 'partial') {
      assert.deepEqual([...effects.unknownEffects.categories].sort(), ['memory','other']);
      assert.equal(accesses(effects).length, 0, `${current.id}:partial hint must not fabricate a memory access`);
      continue;
    }

    const memoryAccesses = accesses(effects);
    if (current.widthBits != null) {
      assert.ok(memoryAccesses.length > 0, `${current.id}:expected a memory access`);
      for (const observed of memoryAccesses) assert.equal(observed.access.widthBits, current.widthBits, `${current.id}:${observed.direction}:width`);
    }
    if (current.ordering && current.ordering !== 'barrier') {
      assert.equal(effects.metadata.ordering, current.ordering, `${current.id}:summary ordering`);
    }
    if (current.readOrdering) assert.ok(memoryAccesses.some(({ direction, access }) => direction === 'read' && access.ordering === current.readOrdering), `${current.id}:read ordering`);
    if (current.writeOrdering) assert.ok(memoryAccesses.some(({ direction, access }) => direction === 'write' && access.ordering === current.writeOrdering), `${current.id}:write ordering`);
    if (current.addressingMode) assert.equal(effects.metadata.addressing?.mode, current.addressingMode, `${current.id}:addressing mode`);
    if (current.prefetch) {
      assert.equal(effects.metadata.prefetch?.operation, current.prefetch.operation, `${current.id}:prfop operation`);
      assert.equal(effects.metadata.prefetch?.cacheLevel, current.prefetch.cacheLevel, `${current.id}:prfop target`);
      assert.equal(effects.metadata.prefetch?.policy, current.prefetch.policy, `${current.id}:prfop policy`);
      assert.equal(effects.metadata.prefetch?.named, current.prefetch.named, `${current.id}:prfop naming`);
      assert.equal(effects.metadata.prefetch?.prfop, current.prefetch.prfop, `${current.id}:prfop code`);
      assert.equal(accesses(effects).length, 0, `${current.id}:a prefetch hint must not fabricate a memory access`);
      assert.equal(effects.operations.some((operation) => operation.kind === 'memory-write'), false, `${current.id}:prefetch write`);
      const intrinsic = effects.operations.find((operation) => operation.kind === 'intrinsic');
      assert.ok(intrinsic, `${current.id}:prefetch intrinsic`);
      assert.equal(intrinsic.intrinsicId, 'arm64.memory-system-prefetch-hint', `${current.id}:prefetch intrinsic id`);
      assert.deepEqual(intrinsic.effectSummary.registersWritten, [], `${current.id}:prefetch register writes`);
      assert.equal(intrinsic.effectSummary.determinism, 'nondeterministic', `${current.id}:prefetch determinism`);
    }
    if (current.literal) assert.equal(effects.metadata.transfer, 'literal', `${current.id}:literal discriminator`);
    if (current.writeback) {
      const memoryIndex = effects.operations.findIndex((operation) => operation.kind === 'memory-read' || operation.kind === 'memory-write');
      const writebackIndex = effects.operations.findIndex((operation) => operation.kind === 'register-write' && operation.metadata?.purpose === 'address-writeback');
      assert.ok(memoryIndex >= 0 && writebackIndex > memoryIndex, `${current.id}:writeback must be explicit and post-access`);
    }
    for (const faultKind of current.faultKinds || []) assert.ok(effects.possibleFaults.some((fault) => fault.kind === faultKind), `${current.id}:missing fault ${faultKind}`);
    if (current.tagChecked === false) {
      const abort = effects.possibleFaults.find((fault) => fault.kind === 'data-abort');
      assert.equal(abort?.detail?.tagChecked, false, `${current.id}:SP tag-check discriminator`);
    }
    if (current.barrierOption) {
      assert.equal(effects.metadata.option, current.barrierOption, `${current.id}:barrier option`);
      assert.equal(effects.operations[0].kind, 'barrier', `${current.id}:barrier operation`);
    }
    if (current.barrierCrm != null) {
      assert.equal(effects.metadata.crm, current.barrierCrm, `${current.id}:barrier CRm discriminator`);
      assert.equal(effects.operations[0].kind, 'barrier', `${current.id}:barrier operation`);
    }
    if (current.clrexImmediate != null) assert.equal(effects.metadata.immediate, current.clrexImmediate, `${current.id}:CLREX imm4 discriminator`);
  }

  const pairExclusive = session.decode(bytes32(0xc87f8440), 0x500000n);
  assert.equal(pairExclusive[0]?.mnemonic, 'ldaxp');
  const unsupported = liftArm64MachineEffects(decodedInstruction(pairExclusive[0], 'arm64-memory-negative:ldaxp'));
  assert.equal(unsupported, null, 'unowned pair-exclusive must remain unsupported');

  assert.deepEqual(session.decode(bytes32(0xffffffff), 0x500004n), [], 'invalid encoding unexpectedly decoded');
} finally {
  session.close();
}

const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const w = (n) => ({ k:'reg', text:`w${n}`, cls:'gp', bits:32, num:n });
const b = (n) => ({ k:'reg', text:`b${n}`, cls:'fp', bits:8, num:n });
const s = (n) => ({ k:'reg', text:`s${n}`, cls:'fp', bits:32, num:n });
const imm = (value) => ({ k:'imm', text:`#${value}`, value:BigInt(value) });
const mem = (base, { mode='offset', disp=0n, writebackDisp=undefined } = {}) => {
  const address = mode === 'post' ? null : imm(disp);
  const out = { k:'mem', text:'[...]', base, index:null, shift:null, mode, disp:address, addressDisp:address, writebackDisp:null };
  if (mode === 'pre') out.writebackDisp = writebackDisp === undefined ? address : imm(writebackDisp);
  if (mode === 'post') out.writebackDisp = imm(writebackDisp ?? disp);
  return out;
};
function direct(mnemonic, ops) {
  const instructionId = `arm64-memory-malformed:${mnemonic}:${Math.random()}`;
  return liftArm64MachineEffects({ instructionId, mnemonic, ops, mode:'a64', origin:{ instructionIds:[instructionId] } });
}

for (const malformed of [
  direct('ldrb', [x(0), mem(x(1))]),
  direct('ldrb', [b(0), mem(x(1))]),
  direct('strh', [x(0), mem(x(1))]),
  direct('ldarb', [x(0), mem(x(1))]),
  direct('ldr', [x(0), x(2), mem(x(1))]),
  direct('ldr', [x(0), mem(x(1), { disp:7n })]),
  direct('ldr', [x(0), mem(x(1), { disp:32768n })]),
  direct('ldur', [x(0), mem(x(1), { disp:-257n })]),
  direct('ldr', [x(0), mem(x(1), { mode:'pre', disp:-8n, writebackDisp:-16n })]),
  direct('ldp', [x(0), s(2), mem(x(1))]),
  direct('ldp', [x(0), x(2), mem(x(1), { disp:512n })]),
  direct('cas', [x(0), x(2), x(3), mem(x(1))]),
  direct('stxr', [w(2), x(2), mem(x(1))]),
  direct('stxr', [w(1), x(2), mem(x(1))]),
  direct('clrex', [{ k:'imm', text:'#16', value:16n }]),
  direct('dsb', [{ k:'imm', text:'#16', value:16n }]),
  direct('isb', [{ k:'imm', text:'#16', value:16n }]),
  direct('ssbb', [imm(0)]),
  direct('pssbb', [imm(4)]),
  direct('prfm', [mem(x(1))]),
  direct('prfum', [mem(x(1))]),
  direct('prfm', [{ k:'other', text:'pldl4keep' }, mem(x(1))]),
  direct('prfm', [{ k:'other', text:'pldl1keep' }, mem(x(1), { mode:'pre', disp:-8n, writebackDisp:-8n })]),
]) {
  assert.equal(malformed?.completeness, 'partial', 'malformed/invalid structured input must fail closed');
  assert.equal(accesses(malformed).length, 0, 'malformed/invalid structured input must not emit memory effects');
}

const constrained = direct('ldp', [x(1), x(2), mem(x(1), { mode:'pre', disp:-16n })]);
assert.equal(constrained.completeness, 'partial');
assert.match(constrained.unknownEffects.reason, /constrained-unpredictable/);

console.log(`ARM64 A64 memory denominator (${denominator.encodingCaseCount} LLVM+Capstone cases): PASS`);
