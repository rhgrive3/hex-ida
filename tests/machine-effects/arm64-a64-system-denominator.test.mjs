import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { parseOperands } from '../../js/arm64.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import {
  ARM64_SYSTEM_EFFECT_MNEMONICS,
  liftArm64SystemEffects,
} from '../../js/targets/architecture/arm64/effects/system.js';
import {
  ARM64_A64_SYSTEM_DENOMINATOR_ID,
  ARM64_A64_SYSTEM_ENCODING_FAMILIES,
  ARM64_A64_SYSTEM_MNEMONIC_DENOMINATOR,
  arm64A64SystemEncodingCases,
  classifyArm64A64SystemEncoding,
  validateArm64A64SystemDenominator,
} from '../../tools/validation/machine-effects/arm64-a64-system-denominator.mjs';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

const CANONICAL_MEMORY_OWNER = new Set(['dmb','dsb','isb','clrex']);
const ENVIRONMENT_REGISTERS = Object.freeze([
  ...Array.from({ length:31 }, (_unused, index) => `x${index}`), 'sp',
  ...Array.from({ length:32 }, (_unused, index) => `v${index}`),
  'NZCV.N','NZCV.Z','NZCV.C','NZCV.V','fpcr','fpsr','pstate','sys:arm64.execution-environment',
]);
const ENVIRONMENT_SPACES = Object.freeze(['code','io','memory','tls']);

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
}
function instruction(raw, id) {
  return {
    instructionId:id,
    address:raw.address,
    mnemonic:raw.mnemonic,
    operands:raw.opStr,
    opStr:raw.opStr,
    ops:parseOperands(raw.opStr),
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
      for (const input of operation.effectSummary.inputs || []) assertDefined(input, defined, `${label}:${operation.intrinsicId}`);
      for (const output of operation.effectSummary.outputs || []) {
        const id = temporaryId(output);
        assert.ok(id, `${label}:${operation.intrinsicId}:output-without-temporary`);
        defined.add(id);
      }
      continue;
    }
    if (operation.kind === 'register-write') assertDefined(operation.value, defined, `${label}:register-write`);
  }
}
function assertEnvironmentBoundary(effect, mnemonic, id) {
  const intrinsic = effect.operations.find((operation) => operation.kind === 'intrinsic' && operation.metadata?.environmentBoundary);
  assert.ok(intrinsic, `${id}:${mnemonic}:environment-intrinsic-required`);
  assert.ok(intrinsic.effectSummary.registersRead.includes('sys:arm64.execution-environment'), `${id}:environment-state-read`);
  assert.ok(intrinsic.effectSummary.registersWritten.includes('sys:arm64.execution-environment'), `${id}:environment-state-write`);
  if (intrinsic.metadata.conservativeFullEnvironment) {
    assert.deepEqual(intrinsic.effectSummary.registersRead, [...ENVIRONMENT_REGISTERS].sort(), `${id}:environment-register-read-footprint`);
    assert.deepEqual(intrinsic.effectSummary.registersWritten, [...ENVIRONMENT_REGISTERS].sort(), `${id}:environment-register-write-footprint`);
  }
  if (!['svc','hvc','smc','brk','hlt','eret','sys','dc'].includes(mnemonic)) {
    assert.equal(intrinsic.effectSummary.memoryRead.scope, 'none', `${id}:bounded-environment-memory-read`);
    assert.equal(intrinsic.effectSummary.memoryWrite.scope, 'none', `${id}:bounded-environment-memory-write`);
  } else {
    assert.equal(intrinsic.effectSummary.memoryRead.scope, 'all', `${id}:environment-memory-read`);
    assert.equal(intrinsic.effectSummary.memoryWrite.scope, 'all', `${id}:environment-memory-write`);
    assert.deepEqual(intrinsic.effectSummary.memoryRead.spaces, [...ENVIRONMENT_SPACES].sort(), id);
    assert.deepEqual(intrinsic.effectSummary.memoryWrite.spaces, [...ENVIRONMENT_SPACES].sort(), id);
  }
  assert.equal(intrinsic.effectSummary.determinism, 'nondeterministic', `${id}:environment-determinism`);
}

const denominator = validateArm64A64SystemDenominator();
assert.equal(denominator.denominatorId, ARM64_A64_SYSTEM_DENOMINATOR_ID);
assert.equal(denominator.encodingFamilyCount, 8);
assert.equal(denominator.encodingCaseCount, 262_330);
assert.equal(denominator.mnemonicCount, 24);
assert.equal(denominator.selectorCount, 65_536);
assert.equal(denominator.registerCount, 32);
assert.deepEqual([...ARM64_A64_SYSTEM_MNEMONIC_DENOMINATOR].sort(), [...ARM64_SYSTEM_EFFECT_MNEMONICS].sort());

const session = await createCapstoneArm64Session();
let count = 0;
const observed = new Set();
const onePerMnemonic = new Map();
try {
  function verifyCandidate(candidate) {
      const raw = session.decode(bytes32(candidate.word), 0x800000n + BigInt(count * 4))[0];
      // Reserved selector combinations are an intentional part of the finite
      // negative domain.  They establish that the proof does not promote a
      // raw system-region bit pattern merely because its top-level mask fits.
      if (!raw) { count++; return; }
      const id = `arm64-system-denominator:${candidate.id}`;
      if (!ARM64_SYSTEM_EFFECT_MNEMONICS.has(raw.mnemonic)) {
        const unowned = liftArm64SystemEffects(instruction(raw, id));
        assert.equal(unowned, null, `${candidate.id}:unregistered system alias captured:${raw.mnemonic}:${raw.opStr}`);
        count++;
        return;
      }
      observed.add(raw.mnemonic);
      if (!onePerMnemonic.has(raw.mnemonic)) onePerMnemonic.set(raw.mnemonic, candidate.word);
      const decodedModel = instruction(raw, id);
      const effects = liftArm64SystemEffects(decodedModel);
      assert.ok(effects, `${candidate.id}:escaped system ownership:${raw.mnemonic}:${raw.opStr}`);
      assert.ok(['exact','exact-with-intrinsic'].includes(effects.completeness), `${candidate.id}:${raw.mnemonic}:${raw.opStr}:${effects.unknownEffects?.reason}`);
      assert.equal(effects.metadata.family, 'arm64-system', candidate.id);
      assert.equal(effects.operations.some((operation) => operation.kind === 'unknown'), false, candidate.id);
      assert.doesNotThrow(() => validateMachineEffectBundle(effects), candidate.id);
      assertClosedDataflow(effects, candidate.id);

      const gpOperands = decodedModel.ops.filter((operand) => operand?.k === 'reg' && (operand.cls === 'gp' || operand.cls === 'zr'));
      if (raw.mnemonic === 'mrs') {
        const destination = gpOperands[0];
        const writes = effects.operations.filter((operation) => operation.kind === 'register-write' && /^x\d+$/.test(operation.register.registerId));
        assert.equal(writes.length, destination?.cls === 'zr' ? 0 : 1, `${candidate.id}:MRS destination cardinality`);
        if (writes[0]) assert.equal(writes[0].register.widthBits, 64, `${candidate.id}:MRS physical destination width`);
      }
      if (raw.mnemonic === 'msr' && gpOperands.length) {
        const source = gpOperands.at(-1);
        const reads = effects.operations.filter((operation) => operation.kind === 'register-read' && /^x\d+$/.test(operation.register.registerId));
        assert.equal(reads.length, source.cls === 'zr' ? 0 : 1, `${candidate.id}:MSR source cardinality`);
        if (reads[0]) assert.equal(reads[0].register.widthBits, 64, `${candidate.id}:MSR physical source width`);
      }

      if (effects.metadata.environmentBoundary) assertEnvironmentBoundary(effects, raw.mnemonic, candidate.id);
      if (CANONICAL_MEMORY_OWNER.has(raw.mnemonic)) {
        assert.equal(effects.metadata.environmentBoundary, undefined, `${candidate.id}:memory-owned operation must not become environment fallback`);
      }
      count++;
  }
  for (const candidate of arm64A64SystemEncodingCases()) verifyCandidate(candidate);
} finally {
  session.close();
}
assert.equal(count, denominator.encodingCaseCount);
assert.deepEqual([...observed].sort(), [...ARM64_SYSTEM_EFFECT_MNEMONICS].sort(), 'every system registry mnemonic must be emitted by deployed Capstone');

const llvmMc = ['/usr/bin/llvm-mc-18','/usr/bin/llvm-mc'].find((candidate) => fs.existsSync(candidate));
assert.ok(llvmMc, 'LLVM MC 18 AArch64 oracle is required');
const oracleInput = [...onePerMnemonic.values()].map((word) => (
  [...bytes32(word)].map((byte) => `0x${byte.toString(16).padStart(2, '0')}`).join(' ')
)).join('\n');
const oracle = spawnSync(llvmMc, ['--disassemble','--triple=aarch64','--mattr=+v8.5a'], { input:`${oracleInput}\n`, encoding:'utf8' });
assert.equal(oracle.status, 0, oracle.stderr);
assert.doesNotMatch(oracle.stdout, /<unknown>/i, 'LLVM independently rejects a Capstone-owned system form');

const forms = spawnSync(llvmMc, ['--triple=aarch64','--mattr=+v8.5a','--show-encoding'], {
  input:'svc #65535\nbrk #32768\nmrs xzr, tpidr_el0\nmsr tpidr_el0, xzr\nsys #0, c0, c0, #0, x0\nhint #9\neret\n',
  encoding:'utf8',
});
assert.equal(forms.status, 0, forms.stderr);
assert.equal([...forms.stdout.matchAll(/encoding: \[/g)].length, 7);

for (const word of [
  0xd4000000, // adjacent exception-generation encoding, not one of the five owned traps
  0xd4600000, // DCPS1 remains in the global decoder/fallback gap
  0xd69f03e1, // damaged fixed Rt field in ERET
  0xd61f0000, // BR belongs to the control family
]) assert.equal(classifyArm64A64SystemEncoding(word), null, `adjacent encoding claimed:0x${word.toString(16)}`);

for (const [mnemonic, operands] of [
  ['mrs','x0'], ['msr','tpidr_el0'], ['hint',''], ['svc','x0'],
]) {
  const malformed = liftArm64SystemEffects({
    instructionId:`arm64-system-negative:${mnemonic}:${operands}`,
    mnemonic,
    operands,
    ops:parseOperands(operands),
    mode:'a64',
  });
  assert.equal(malformed.completeness, 'partial', `${mnemonic} ${operands} must fail closed`);
}
assert.equal(liftArm64SystemEffects({ instructionId:'arm64-system-unowned-at', mnemonic:'at', ops:parseOperands('s1e1r, x0'), mode:'a64' }), null);
assert.equal(liftArm64SystemEffects({ instructionId:'arm64-system-unowned-pac', mnemonic:'paciasp', ops:[], mode:'a64' }), null);
assert.equal(new Set(ARM64_A64_SYSTEM_ENCODING_FAMILIES.map(({ id }) => id)).size, 8);
console.log(`ARM64 A64 system denominator (${count} finite discriminator cases): PASS`);
