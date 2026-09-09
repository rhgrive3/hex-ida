import assert from 'node:assert/strict';
import { liftX86SystemEffects } from '../../js/targets/architecture/x86_64/effects/system.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { FLAG_TRANSFER_CASES, verifyFlagTransferValues } from './helpers/lahf-sahf-oracle.mjs';
import { X86_LONG64_DECODER_WITNESSES } from '../../tools/validation/machine-effects/fixtures/x86-long64-decoder-witnesses.mjs';

function instruction(family, bytes, patch = {}) {
  return {
    instructionId:`flag-transfer:${family}:${bytes.join('-')}`, instructionCode:1,
    instructionFamily:family, mnemonic:family, mode:'long-64', address:0x1000n,
    length:Math.max(1, bytes.length), rawBytes:Uint8Array.from(bytes), detailStatus:'complete',
    detail:{ operandCount:0, operands:[] }, ...patch,
  };
}

let valueCases = 0;
// Lock the new proof to the unchanged canonical inventory, not only convenient
// unprefixed examples. Its LAHF/SAHF witnesses include an ES null prefix.
const witnesses = X86_LONG64_DECODER_WITNESSES.filter(([, family]) => ['lahf', 'sahf'].includes(family));
assert.equal(witnesses.length, 2);
for (const [, family, hex] of witnesses) {
  assert.ok(FLAG_TRANSFER_CASES.some(row => row.family === family
    && Buffer.from(row.bytes).toString('hex') === hex), `uncovered canonical witness: ${family}:${hex}`);
}
for (const { family, bytes } of FLAG_TRANSFER_CASES) {
  // These are dedicated-lifter unit tests, not forged decoder/receiver proof.
  // The real production transport is separately exercised by phase6:browser.
  const row = instruction(family, bytes);
  const bundle = liftX86SystemEffects(row);
  validateMachineEffectBundle(bundle);
  valueCases += verifyFlagTransferValues(bundle, family);
  assert.equal(liftX86MachineEffects(row).completeness, 'exact', 'dedicated semantics do not need terminal authority');
}

for (const family of ['lahf', 'sahf']) {
  const opcode = family === 'lahf' ? 0x9f : 0x9e;
  for (const bytes of [[0x90], [opcode ^ 1], [opcode, 0x90], [0xf0, opcode],
    [0xf2, opcode], [0xf3, opcode], [0x66, opcode], [0x67, opcode], [0x64, opcode], [0x65, opcode],
    [0x40, 0x48, opcode], [0x40, 0x66, opcode]]) {
    const bundle = liftX86SystemEffects(instruction(family, bytes));
    assert.equal(bundle.completeness, 'partial', `${family}:${bytes}`);
    assert.equal(bundle.operations.length, 0, 'unproven bytes must not emit definite transfers');
  }
  for (const bytes of [[0x26, 0x26, opcode], [0x2e, 0x3e, opcode], [0x26, 0x40, opcode]]) {
    const bundle = liftX86SystemEffects(instruction(family, bytes));
    assert.equal(bundle.completeness, 'partial', 'unproved multi-prefix combinations remain partial');
    assert.equal(bundle.operations.length, 0);
  }
  assert.throws(() => liftX86SystemEffects(instruction(family, [])), /byte-length-mismatch/);
  assert.throws(() => liftX86SystemEffects(instruction(family, [opcode], { length:2 })), /byte-length-mismatch/);
  {
    const bundle = liftX86SystemEffects(instruction(family, [opcode], {
      detail:{ operandCount:1, operands:[{ type:'register', register:'rax', access:'write' }] },
    }));
    assert.equal(bundle.completeness, 'partial');
    assert.equal(bundle.operations.length, 0);
  }
}
for (const prefix of [0x26, 0x2e, 0x36, 0x3e]) {
  const bundle = liftX86SystemEffects(instruction('clc', [prefix, 0xf8]));
  assert.equal(bundle.completeness, 'partial', 'AH-transfer proof must not promote unrelated system families');
  assert.equal(bundle.operations.length, 0);
}
// The independent primitive interpreter must actually detect incorrect values,
// not merely count exact bundles. These mutations do not change product code.
{
  const wrongReservedBit = structuredClone(liftX86SystemEffects(instruction('lahf', [0x9f])));
  wrongReservedBit.operations.find(op => op.kind === 'value' && op.opcode === 'insert').inputs[0].value = '0';
  assert.throws(() => verifyFlagTransferValues(wrongReservedBit, 'lahf'), assert.AssertionError);
  const wrongAhBit = structuredClone(liftX86SystemEffects(instruction('sahf', [0x9e])));
  wrongAhBit.operations.find(op => op.kind === 'value' && op.opcode === 'extract' && op.outputs[0].valueType.widthBits === 1).metadata.lsb = 1;
  assert.throws(() => verifyFlagTransferValues(wrongAhBit, 'sahf'), assert.AssertionError);
}
console.log(`LAHF/SAHF dedicated semantics: PASS (${FLAG_TRANSFER_CASES.length} encodings, ${valueCases} value cases; malformed and oracle-mutation negatives)`);
