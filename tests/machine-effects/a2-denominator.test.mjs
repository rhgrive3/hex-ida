import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { classifyMachineEffectsCoverage } from '../../js/targets/architecture/coverage.js';
import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';
import {
  a2DenominatorReport,
  loadA2DenominatorInventory,
  validateA2DenominatorInventory,
} from '../../tools/validation/machine-effects/a2-denominator.mjs';

const inventory = loadA2DenominatorInventory();
const validation = validateA2DenominatorInventory(inventory);
assert.equal(validation.valid, true);
assert.equal(validation.architectureCount, 4);
assert.equal(validation.fullIsaCoverageIncluded, false);
assert.equal(validation.explicitDecoderGapCount >= 4, true);
assert.equal(validation.blockingGapCount > validation.explicitDecoderGapCount, true);
assert.equal(validation.terminalEligible, false, 'partial and unsupported in-profile effect families remain blocking gaps');
assert.ok(validation.blockingGaps.includes('arm64:a64:all-decoder-encodings-and-aliases'));
assert.equal(validation.blockingGaps.includes('riscv64:rv64imc:all-valid-32-bit-and-compressed-encodings'), false,
  'the exhaustive versioned RV64IMC decoder denominator closes only its decoder unit');
assert.ok(validation.blockingGaps.includes('x86_64:long-64:effect-family:atomic'));
assert.ok(validation.blockingGaps.includes('arm64e:a64+pac:alias:baseline-a64-delegation'), 'delegated baseline exclusions remain profile blockers');

const report = a2DenominatorReport(inventory);
assert.equal(report.validation.valid, true);
assert.equal(report.schemaVersion, 'machine-effects-a2-denominator-report/v2');
assert.equal(report.scope.percentagePolicy.includes('not-emitted'), true);

const arm64e = inventory.architectures.find((architecture) => architecture.id === 'arm64e');
assert.equal(arm64e.aliases.find((alias) => alias.id === 'baseline-a64-delegation').sourceArchitecture, 'arm64');
assert.ok(arm64e.pointerAuthenticationMnemonics.includes('paciasp'));
assert.ok(arm64e.pointerAuthenticationMnemonics.includes('retaa'));

function clone() { return JSON.parse(JSON.stringify(inventory)); }

{
  const mutated = clone();
  mutated.architectures[0].effectRegistry.families.pop();
  assert.throws(() => validateA2DenominatorInventory(mutated), /a2-denominator-fallback-must-be-last/);
}

{
  const mutated = clone();
  const families = mutated.architectures.find((architecture) => architecture.id === 'x86_64').effectRegistry.families;
  [families[0], families[1]] = [families[1], families[0]];
  assert.throws(() => validateA2DenominatorInventory(mutated), /a2-denominator-effect-registry-drift/);
}

{
  const mutated = clone();
  mutated.architectures.find((architecture) => architecture.id === 'arm64e').pointerAuthenticationMnemonics.pop();
  assert.throws(() => validateA2DenominatorInventory(mutated), /a2-denominator-pac-registry-drift/);
}

{
  const mutated = clone();
  mutated.architectures.find((architecture) => architecture.id === 'arm64e').aliases[0].sourceArchitecture = 'x86_64';
  assert.throws(() => validateA2DenominatorInventory(mutated), /a2-denominator-arm64e-baseline-alias-missing/);
}

{
  const mutated = clone();
  mutated.architectures.find((architecture) => architecture.id === 'riscv64').effectRegistry.families.pop();
  assert.throws(() => validateA2DenominatorInventory(mutated), /a2-denominator-fallback-must-be-last/);
}

{
  const mutated = clone();
  mutated.architectures.find((architecture) => architecture.id === 'x86_64').decoder.missingUnits = [];
  assert.throws(() => validateA2DenominatorInventory(mutated), /a2-denominator-decoder-units-required/);
}

{
  const mutated = clone();
  mutated.architectures.find((architecture) => architecture.id === 'x86_64').decoder.semanticVersion = 'stale-decoder';
  assert.throws(() => validateA2DenominatorInventory(mutated), /a2-denominator-decoder-semantic-version-drift/);
}

{
  const mutated = clone();
  mutated.architectures.find((architecture) => architecture.id === 'riscv64').decoder.denominator.denominatorId = 'riscv64:rv64imc:unproven-denominator';
  assert.throws(() => validateA2DenominatorInventory(mutated), /a2-denominator-exact-decoder-proof-identity-drift/);
}

{
  const gaps = report.validation.blockingGaps;
  assert.equal(gaps.includes('riscv64:rv64imc:effect-family:system:ecall'), false, 'complete environment intrinsic is non-blocking');
  assert.equal(gaps.includes('riscv64:rv64imc:effect-family:system:ebreak'), false, 'proven exact intrinsic stays non-blocking');
  assert.ok(gaps.includes('riscv64:rv64imc:effect-family:system:fence.i'), 'nested out-of-profile effects must remain explicit');
  assert.equal(gaps.includes('riscv64:rv64imc:effect-family:system'), false, 'an exact parent must not mask its nested gaps');
}

{
  const mutated = clone();
  const system = mutated.architectures.find((architecture) => architecture.id === 'riscv64').effectRegistry.families.find((family) => family.id === 'system');
  delete system.subunits.find((unit) => unit.id === 'ebreak').proof;
  assert.throws(() => validateA2DenominatorInventory(mutated), /a2-denominator-exact-current-proof-required/);
}

{
  const unknownArm64 = { instructionId:'a2:unknown:arm64', architectureId:'arm64', mode:'a64', mnemonic:'a2_unknown', ops:[] };
  const unknownArm64e = { instructionId:'a2:unknown:arm64e', architectureId:'arm64e', mode:'arm64e', mnemonic:'a2_unknown', ops:[] };
  const unknownX86 = createX86DecodedInstruction({
    instructionId:'a2:unknown:x86', instructionCode:1, instructionFamily:'a2_unknown', address:0x1000n,
    length:1, rawBytes:Uint8Array.of(0x90), mode:'long-64', detailAvailable:true,
    detail:{ operands:[], operandCount:0 },
  });
  const unknownRiscv = createRiscv64DecodedInstruction({
    instructionId:'a2:unknown:riscv64', address:0x1000n, size:4,
    rawBytes:Uint8Array.of(0x7b, 0x00, 0x00, 0x00), mode:'rv64imc', origin:{ instructionIds:['a2:unknown:riscv64'] },
  });
  for (const [architecture, decoded] of [['arm64', unknownArm64], ['arm64e', unknownArm64e], ['x86_64', unknownX86], ['riscv64', unknownRiscv]]) {
    assert.equal(classifyMachineEffectsCoverage(architecture, decoded).status, 'unsupported', `${architecture} generic fallback must stay unsupported`);
  }
}

for (const architecture of inventory.architectures) {
  const exclusions = architecture.effectRegistry.families.filter((family) => family.status === 'excluded');
  assert.ok(exclusions.every((family) => family.preexisting === true && family.reason), `${architecture.id} exclusions must remain explicit`);
}

console.log('A2 denominator inventory and drift guards: PASS');
