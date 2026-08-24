import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseOperands } from '../../js/ui/explain/arm64-operands.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { ARM64_SIMD_EFFECT_MNEMONICS, liftArm64SimdEffects } from '../../js/targets/architecture/arm64/effects/simd.js';
import {
  ARM64_A64_SIMD_ALIAS_BINDINGS,
  ARM64_A64_SIMD_ASSEMBLY_CASES,
  ARM64_A64_SIMD_DENOMINATOR_VERSION,
  ARM64_A64_SIMD_MNEMONIC_DENOMINATOR,
  ARM64_A64_SIMD_ORACLE_IDS,
  validateArm64A64SimdDenominator,
} from '../../tools/validation/machine-effects/arm64-a64-simd-denominator.mjs';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

function executable(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}
function assembleWithLlvmMc(source, directory) {
  const objectPath = path.join(directory, 'simd-denominator.o');
  const llvmMc = executable(['/usr/bin/llvm-mc-18','/usr/bin/llvm-mc','/usr/local/bin/llvm-mc']);
  if (llvmMc) {
    const result = spawnSync(llvmMc, ['--triple=aarch64','--mattr=+fullfp16','--filetype=obj','-o',objectPath], { input:source, encoding:'utf8' });
    assert.equal(result.status, 0, `LLVM MC AArch64 assembly failed:\n${result.stderr}`);
    return { objectPath, oracle:'llvm-mc' };
  }
  const clang = executable(['/usr/local/swift/usr/bin/clang','/usr/bin/clang-18','/usr/bin/clang','/usr/local/bin/clang']);
  assert.ok(clang, 'LLVM MC or Clang integrated LLVM MC AArch64 oracle is required');
  const result = spawnSync(clang, ['--target=aarch64-none-elf','-march=armv8.2-a+fp16','-x','assembler','-c','-o',objectPath,'-'], { input:source, encoding:'utf8' });
  assert.equal(result.status, 0, `Clang integrated LLVM MC AArch64 assembly failed:\n${result.stderr}`);
  return { objectPath, oracle:'clang-integrated-llvm-mc' };
}
function objectTextBytes(objectPath, directory) {
  const binaryPath = path.join(directory, 'simd-denominator.bin');
  const objcopy = executable([
    '/usr/bin/llvm-objcopy-18','/usr/bin/llvm-objcopy','/usr/local/bin/llvm-objcopy','/usr/local/swift/usr/bin/llvm-objcopy',
  ]);
  assert.ok(objcopy, 'llvm-objcopy is required for the SIMD denominator oracle');
  const result = spawnSync(objcopy, ['-O','binary','--only-section=.text',objectPath,binaryPath], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(binaryPath);
}
function parseOracleOperands(opStr) {
  // Shared presentation parser currently accepts decimal lane indices only, while
  // deployed Capstone renders B[15] as B[0xf]. Keep the production SIMD lifter
  // text-free: this oracle-only adapter materializes the already-proven lane shape.
  return parseOperands(opStr).map((op) => {
    if (op.k !== 'other') return op;
    const match = /^v(\d{1,2})\.([bhsd])\[(0x[0-9a-f]+|\d+)\]$/i.exec(op.text || '');
    if (!match) return op;
    return { k:'elem', text:op.text, num:Number(match[1]), size:match[2].toLowerCase(), index:Number(BigInt(match[3])) };
  });
}
function instruction(raw, id) {
  return {
    instructionId:id,
    address:raw.address,
    mnemonic:raw.mnemonic,
    operands:raw.opStr,
    opStr:raw.opStr,
    ops:parseOracleOperands(raw.opStr),
    mode:'a64',
    origin:{ instructionIds:[id] },
  };
}
function temporaryId(value) { return value?.kind === 'temporary' ? value.temporaryId : null; }
function assertDefined(value, defined, label) {
  const id = temporaryId(value);
  if (id) assert.ok(defined.has(id), `${label}:use-before-definition:${id}`);
}
function assertClosedDataflow(bundle, label) {
  const defined = new Set();
  for (const operation of bundle.operations) {
    if (operation.kind === 'register-read') {
      const id = temporaryId(operation.value);
      assert.ok(id, `${label}:register-read-without-temporary`);
      defined.add(id);
      continue;
    }
    if (operation.kind === 'value') {
      for (const input of operation.inputs || []) assertDefined(input, defined, `${label}:${operation.opcode}`);
      for (const output of operation.outputs || []) {
        const id = temporaryId(output);
        assert.ok(id, `${label}:${operation.opcode}:output-without-temporary`);
        defined.add(id);
      }
      continue;
    }
    if (operation.kind === 'intrinsic') {
      const summary = operation.effectSummary;
      assert.deepEqual(summary.memoryRead, { scope:'none' }, `${label}:${operation.intrinsicId}:memory-read`);
      assert.deepEqual(summary.memoryWrite, { scope:'none' }, `${label}:${operation.intrinsicId}:memory-write`);
      assert.deepEqual(summary.controlEffects, [], `${label}:${operation.intrinsicId}:control-effects`);
      assert.ok(['deterministic','input-dependent'].includes(summary.determinism), `${label}:${operation.intrinsicId}:determinism`);
      for (const input of summary.inputs || []) assertDefined(input, defined, `${label}:${operation.intrinsicId}`);
      for (const output of summary.outputs || []) {
        const id = temporaryId(output);
        assert.ok(id, `${label}:${operation.intrinsicId}:output-without-temporary`);
        defined.add(id);
      }
      continue;
    }
    if (operation.kind === 'register-write') assertDefined(operation.value, defined, `${label}:register-write:${operation.register.registerId}`);
  }
}
function assertCanonicalPhysicalState(bundle, label) {
  for (const operation of bundle.operations) {
    if (!['register-read','register-write'].includes(operation.kind)) continue;
    const id = operation.register?.registerId || '';
    if (/^v\d+$/.test(id)) assert.equal(operation.register.widthBits, 128, `${label}:${id}:noncanonical-V-state`);
    if (/^x\d+$/.test(id)) assert.equal(operation.register.widthBits, 64, `${label}:${id}:noncanonical-X-state`);
  }
}
const vec = (num, arr, bits = 128) => ({ k:'reg', cls:'vec', num, bits, arr, text:`v${num}.${arr}` });
const elem = (num, size, index) => ({ k:'elem', num, size, index, text:`v${num}.${size}[${index}]` });
const gp = (num, bits = 64, cls = 'gp') => ({ k:'reg', cls, num, bits, text:cls === 'zr' ? (bits === 32 ? 'wzr' : 'xzr') : `${bits === 32 ? 'w' : 'x'}${num}` });
const imm = (value, shift = undefined) => ({ k:'imm', value:BigInt(value), text:`#${value}`, ...(shift ? { shift } : {}) });
const exact = (bundle) => bundle && ['exact','exact-with-intrinsic'].includes(bundle.completeness);

const denominator = validateArm64A64SimdDenominator();
assert.equal(denominator.version, ARM64_A64_SIMD_DENOMINATOR_VERSION);
assert.equal(denominator.mnemonicCount, 108);
assert.equal(denominator.caseCount, 891);
assert.equal(denominator.formCount, 891);
assert.equal(denominator.aliasBindingCount, 3);
assert.deepEqual(denominator.oracleIds, ARM64_A64_SIMD_ORACLE_IDS);
assert.deepEqual([...ARM64_SIMD_EFFECT_MNEMONICS].sort(), [...ARM64_A64_SIMD_MNEMONIC_DENOMINATOR].sort(), 'production SIMD registry drifted from independent denominator');

const source = `.text\n${ARM64_A64_SIMD_ASSEMBLY_CASES.map((entry) => entry.assembly).join('\n')}\n`;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arm64-a64-simd-denominator-'));
let assemblerOracle = null;
const session = await createCapstoneArm64Session();
try {
  const assembled = assembleWithLlvmMc(source, directory);
  assemblerOracle = assembled.oracle;
  const bytes = objectTextBytes(assembled.objectPath, directory);
  assert.equal(bytes.length, ARM64_A64_SIMD_ASSEMBLY_CASES.length * 4, 'each finite A64 SIMD discriminator case must encode to one fixed-width instruction');
  const decoded = session.decode(bytes, 0x500000n);
  assert.equal(decoded.length, ARM64_A64_SIMD_ASSEMBLY_CASES.length, 'deployed Capstone rejected a finite SIMD discriminator case');

  for (let index = 0; index < decoded.length; index++) {
    const spec = ARM64_A64_SIMD_ASSEMBLY_CASES[index];
    const raw = decoded[index];
    const label = `arm64-simd-denominator:${spec.id}`;
    assert.equal(raw.mnemonic, spec.expectedMnemonic, `${label}:${spec.assembly}:${raw.opStr}`);
    const decodedModel = instruction(raw, label);
    const effects = liftArm64MachineEffects(decodedModel, { instructionId:label });
    assert.ok(effects, `${label}:escaped-dispatch-ownership:${raw.mnemonic} ${raw.opStr}`);
    assert.ok(exact(effects), `${label}:not-exact:${raw.mnemonic} ${raw.opStr}:${effects.unknownEffects?.reason}`);
    assert.equal(effects.metadata.family, 'arm64-simd', `${label}:wrong-family`);
    assert.equal(effects.operations.some((operation) => operation.kind === 'unknown'), false, `${label}:unknown-effect`);
    assert.deepEqual(effects.possibleFaults, [], `${label}:unexpected-fault`);
    assert.equal(effects.controlEffect.kind, 'fallthrough', `${label}:control`);
    assert.doesNotThrow(() => validateMachineEffectBundle(effects), label);
    assertClosedDataflow(effects, label);
    assertCanonicalPhysicalState(effects, label);
  }
} finally {
  session.close();
  fs.rmSync(directory, { recursive:true, force:true });
}
assert.ok(assemblerOracle, 'an LLVM MC oracle must have executed');

// Internal decoder aliases without distinct architectural spellings remain exact,
// but are checked independently from the production registry list.
for (const alias of ARM64_A64_SIMD_ALIAS_BINDINGS) {
  const operands = alias.registryMnemonic === 'orr_v'
    ? [vec(0,'16b'),vec(1,'16b'),vec(2,'16b')]
    : alias.registryMnemonic === 'rev64_v'
      ? [vec(0,'16b'),vec(1,'16b')]
      : [vec(0,'16b'),vec(1,'16b')];
  const effect = liftArm64SimdEffects({ instructionId:`alias:${alias.registryMnemonic}`, mnemonic:alias.registryMnemonic, ops:operands, mode:'a64' });
  assert.ok(exact(effect), `${alias.registryMnemonic}:internal alias is not exact`);
  assert.equal(effect.metadata.family, 'arm64-simd');
}

// Negative discriminator proof. These cases exercise every failure class required
// by the component contract and must never manufacture an exact SIMD claim.
for (const [label, decoded, expected] of [
  ['invalid-arrangement', {mnemonic:'add',ops:[vec(0,'3s'),vec(1,'3s'),vec(2,'3s')]}, 'partial'],
  ['missing-structured-operands', {mnemonic:'add',ops:[],operands:'v0.4s, v1.4s, v2.4s'}, null],
  ['wrong-vector-width', {mnemonic:'add',ops:[vec(0,'4s',64),vec(1,'4s'),vec(2,'4s')]}, 'partial'],
  ['wrong-lane-width', {mnemonic:'ins',ops:[elem(0,'s',1),elem(1,'h',1)]}, 'partial'],
  ['invalid-register-form', {mnemonic:'dup',ops:[vec(0,'4s'),gp(31,32)]}, 'partial'],
  ['malformed-decode', {mnemonic:'add',ops:[vec(0,'4s'),vec(1,'4s'),vec(2,'4s'),vec(3,'4s')]}, 'partial'],
  ['invalid-source-arrangement', {mnemonic:'add',ops:[vec(0,'4s'),vec(1,'8h'),vec(2,'4s')]}, 'partial'],
  ['scalar-vector-mnemonic-ambiguity', {mnemonic:'add',ops:[gp(0),gp(1),gp(2)]}, null],
  ['physical-alias-shape-error', {mnemonic:'add',ops:[vec(0,'2s'),{k:'reg',cls:'fp',num:1,bits:64,text:'d1'},vec(2,'2s')]}, 'partial'],
  ['invalid-lane-form', {mnemonic:'add',ops:[vec(0,'4s'),vec(1,'4s'),elem(2,'s',0)]}, 'partial'],
  ['malformed-shift', {mnemonic:'movi',ops:[vec(0,'4s'),imm(1,{op:'asr',amount:8})]}, 'partial'],
  ['masked-ext-offset-outside-canonical-range', {mnemonic:'ext',ops:[vec(0,'8b'),vec(1,'8b'),vec(2,'8b'),imm(8)]}, 'partial'],
]) {
  const effect = liftArm64SimdEffects({ instructionId:`negative:${label}`, mode:'a64', ...decoded });
  assert.equal(effect?.completeness ?? null, expected, label);
}
assert.equal(liftArm64SimdEffects({
  instructionId:'negative:memory-owner', mnemonic:'ldr', operands:'q0, [x1]',
  ops:[{k:'reg',cls:'fp',num:0,bits:128,text:'q0'},{k:'mem',text:'[x1]'}], mode:'a64',
}), null, 'memory-shaped SIMD transfers are owned by the memory family');

const sve = liftArm64SimdEffects({ instructionId:'negative:sve', mnemonic:'add', operands:'z0.s, z1.s, z2.s', ops:[{k:'reg',cls:'z',num:0,bits:128,text:'z0.s'}], mode:'a64' });
assert.equal(sve.completeness, 'partial');
assert.match(sve.unknownEffects.reason, /sve-scalable-vector/);

// The shared operand adapter is deliberately not changed by this component. If it
// learns Capstone's hexadecimal lane spelling later, the production SIMD semantics
// remain unchanged and this proof no longer needs its oracle-only adapter fallback.
const sharedParserLane = parseOperands('v2.b[0xf]')[0];
assert.ok(['other','elem'].includes(sharedParserLane.k));
if (sharedParserLane.k === 'elem') assert.equal(sharedParserLane.index, 15);

console.log(`ARM64 A64 SIMD denominator (${denominator.caseCount} finite cases, ${assemblerOracle} + Capstone): PASS`);
