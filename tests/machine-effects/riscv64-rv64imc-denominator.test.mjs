import assert from 'node:assert/strict';

import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';
import { liftRiscv64MachineEffects } from '../../js/targets/architecture/riscv64/effects/index.js';
import { decodeRiscv64InstructionWord } from '../../js/targets/architecture/riscv64/instruction-word.js';
import {
  RV64IMC_32BIT_ENCODING_FAMILIES,
  RV64IMC_32BIT_OUT_OF_PROFILE_NEGATIVES,
  RV64IMC_ALIAS_OR_HINT_VECTORS,
  RV64IMC_COMPRESSED_ENCODING_FAMILIES,
  RV64IMC_COMPRESSED_UNSUPPORTED_REASONS,
  RV64IMC_DECODER_DENOMINATOR_ID,
  classifyRv64imc32Encoding,
  validateRv64imcDecoderDenominator,
} from '../../tools/validation/machine-effects/riscv64-rv64imc-denominator.mjs';
import { compareWithCapstoneOperands } from '../../tools/validation/phase6/llvm-oracle.mjs';
import { createCapstoneRiscv64Session } from '../phase6/helpers/capstone-session.mjs';

function bytes16(word) {
  return Uint8Array.of(word & 0xff, (word >>> 8) & 0xff);
}

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function decoded(bytes, id) {
  return createRiscv64DecodedInstruction({
    address: 0x1000n,
    size: bytes.length,
    rawBytes: bytes,
    mode: 'rv64imc',
    instructionId: id,
    origin: { instructionIds: [id] },
  });
}

function sameSet(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

function assertTruthfulEffects(instruction, family) {
  const effects = liftRiscv64MachineEffects(instruction);
  assert.ok(effects, `${family.id}: supported decode must be owned by a MachineEffects family`);
  assert.equal(effects.architectureId, 'riscv64');
  assert.equal(effects.metadata.instructionFamily, instruction.fields.op);
  if (family.completeness === 'partial-environment') {
    assert.equal(effects.completeness, 'partial');
    assert.equal(effects.unknownEffects?.preservation, 'not-assumed');
    assert.equal(effects.controlEffect?.kind, 'trap');
  } else {
    assert.equal(effects.completeness, 'exact', `${family.id}: in-profile family must not silently degrade`);
    assert.equal(effects.unknownEffects, undefined);
  }
}

const denominator = validateRv64imcDecoderDenominator();
assert.equal(denominator.valid, true);
assert.equal(denominator.denominatorId, RV64IMC_DECODER_DENOMINATOR_ID);
assert.equal(denominator.discriminatorTupleCount, 28_672);
assert.equal(denominator.compressedWordCount, 49_152);

// This is the complete finite 32-bit discriminator product used by the RV64I/M
// decoder: opcode x funct3 x funct7. Register and ordinary immediate payload
// bits are non-discriminating; the two exceptions (FENCE and SYSTEM reserved
// fields) receive their own complete products below.
const observed32Families = new Set();
for (let opcode = 0; opcode < 0x80; opcode += 1) {
  if ((opcode & 0b11) !== 0b11 || (opcode & 0b11111) === 0b11111) continue;
  for (let funct3 = 0; funct3 < 8; funct3 += 1) {
    for (let funct7 = 0; funct7 < 0x80; funct7 += 1) {
      const word = (opcode | (1 << 7) | (funct3 << 12) | (2 << 15) | (3 << 20) | (funct7 << 25)) >>> 0;
      const expected = classifyRv64imc32Encoding(word);
      const instruction = decoded(bytes32(word), `rv64imc-grid-${opcode}-${funct3}-${funct7}`);
      assert.equal(instruction.fields.supported, expected != null, `32-bit discriminator drift at 0x${word.toString(16)}`);
      if (expected) {
        assert.equal(instruction.fields.op, expected.operation, expected.id);
        observed32Families.add(expected.id);
        assertTruthfulEffects(instruction, expected);
      }
    }
  }
}

// FENCE validity depends on fm/pred/succ plus the architecturally reserved rd
// and rs1 fields. Exhaust their complete validity domain, not representative
// samples, so a reserved form cannot be promoted by an over-broad mask.
for (let fenceMode = 0; fenceMode < 16; fenceMode += 1) {
  for (let predecessor = 0; predecessor < 16; predecessor += 1) {
    for (let successor = 0; successor < 16; successor += 1) {
      for (const rd of [0, 1]) for (const rs1 of [0, 1]) {
        const word = (0x0f | (rd << 7) | (rs1 << 15) | (successor << 20) | (predecessor << 24) | (fenceMode << 28)) >>> 0;
        const expected = classifyRv64imc32Encoding(word);
        const instruction = decoded(bytes32(word), `rv64imc-fence-${word}`);
        assert.equal(instruction.fields.supported, expected != null, `FENCE reserved-field drift at 0x${word.toString(16)}`);
        if (expected) {
          observed32Families.add(expected.id);
          assertTruthfulEffects(instruction, expected);
        }
      }
    }
  }
}

// SYSTEM validity depends on all imm[11:0], funct3 and the reserved rd/rs1
// fields. ECALL and EBREAK remain supported-but-partial environment transfers;
// every other tuple must fail closed as Zicsr/privileged/out-of-profile.
for (let immediate = 0; immediate < 0x1000; immediate += 1) {
  for (let funct3 = 0; funct3 < 8; funct3 += 1) {
    for (const rd of [0, 1]) for (const rs1 of [0, 1]) {
      const word = (0x73 | (rd << 7) | (funct3 << 12) | (rs1 << 15) | (immediate << 20)) >>> 0;
      const expected = classifyRv64imc32Encoding(word);
      const instruction = decoded(bytes32(word), `rv64imc-system-${word}`);
      assert.equal(instruction.fields.supported, expected != null, `SYSTEM discriminator drift at 0x${word.toString(16)}`);
      if (expected) {
        observed32Families.add(expected.id);
        assertTruthfulEffects(instruction, expected);
      }
    }
  }
}
sameSet(observed32Families, RV64IMC_32BIT_ENCODING_FAMILIES.map((family) => family.id));

// Register numbers are payload rather than validity discriminators. Still sweep
// every physical register through every wildcard register field of every family
// to prove the complete x0..x31 domain reaches the canonical register file and
// MachineEffects (including x0's hardwired read/write rules).
for (const family of RV64IMC_32BIT_ENCODING_FAMILIES) {
  for (const shift of [7, 15, 20]) {
    if (((family.mask >>> shift) & 0x1f) === 0x1f) continue;
    for (let register = 0; register < 32; register += 1) {
      const payload = ((1 << 7) | (2 << 15) | (3 << 20)) >>> 0;
      const cleared = payload & ~(0x1f << shift);
      const word = (family.match | (((~family.mask) >>> 0) & (cleared | (register << shift)))) >>> 0;
      const instruction = decoded(bytes32(word), `${family.id}-register-${shift}-${register}`);
      assert.equal(instruction.fields.supported, true, `${family.id}: register domain unexpectedly rejected`);
      assertTruthfulEffects(instruction, family);
    }
  }
}

// C is small enough to prove literally: all 49,152 16-bit words in quadrants
// 0..2 are decoded. Every supported word is assigned to a versioned family and
// lifted; every other word has a named reserved/out-of-profile reason.
const observedCompressedFamilies = new Set();
const observedCompressedReasons = new Set();
let compressedSupported = 0;
let compressedExactEffects = 0;
let compressedPartialEffects = 0;
for (let word = 0; word < 0x10000; word += 1) {
  if ((word & 0b11) === 0b11) continue;
  const instruction = decoded(bytes16(word), `rv64imc-c-${word}`);
  if (!instruction.fields.supported) {
    observedCompressedReasons.add(instruction.fields.reason);
    continue;
  }
  compressedSupported += 1;
  observedCompressedFamilies.add(instruction.fields.expandedFrom);
  const family = Object.freeze({
    id: instruction.fields.expandedFrom,
    completeness: instruction.fields.op === 'ebreak' ? 'partial-environment' : 'exact',
  });
  const effects = liftRiscv64MachineEffects(instruction);
  assert.ok(effects, `compressed word 0x${word.toString(16)} has no MachineEffects owner`);
  assertTruthfulEffects(instruction, family);
  if (effects.completeness === 'exact') compressedExactEffects += 1;
  else compressedPartialEffects += 1;
}
sameSet(observedCompressedFamilies, RV64IMC_COMPRESSED_ENCODING_FAMILIES);
sameSet(observedCompressedReasons, RV64IMC_COMPRESSED_UNSUPPORTED_REASONS);
assert.equal(compressedSupported, 38_551);
assert.equal(compressedExactEffects, 38_550);
assert.equal(compressedPartialEffects, 1, 'only the exact c.ebreak encoding may retain environment-partial effects');

for (const vector of RV64IMC_32BIT_OUT_OF_PROFILE_NEGATIVES) {
  const fields = decodeRiscv64InstructionWord(bytes32(vector.word));
  assert.equal(fields.supported, false, vector.id);
  assert.equal(fields.reason, vector.reason, vector.id);
}

for (const vector of RV64IMC_ALIAS_OR_HINT_VECTORS) {
  const instruction = decoded(bytes32(vector.word), `rv64imc-alias-${vector.id}`);
  assert.equal(instruction.fields.supported, true, vector.id);
  assert.equal(instruction.fields.op, vector.operation, `${vector.id}: semantics must come from the word, not printer alias text`);
  assertTruthfulEffects(instruction, classifyRv64imc32Encoding(vector.word));
}

// Independent deployed-oracle sampling covers every 32-bit mask family. The
// production decoder provides the semantic fields; Capstone independently owns
// instruction identity, length and structured operands.
const capstone = await createCapstoneRiscv64Session();
try {
  for (const family of RV64IMC_32BIT_ENCODING_FAMILIES) {
    const payload = ((1 << 7) | (2 << 15) | (3 << 20)) >>> 0;
    const word = (family.match | (((~family.mask) >>> 0) & payload)) >>> 0;
    const rows = capstone.decodeRaw(bytes32(word), 0x1000n);
    assert.equal(rows.length, 1, `${family.id}: deployed Capstone did not decode the official in-profile sample`);
    assert.equal(rows[0].size, 4, family.id);
    const instruction = createRiscv64DecodedInstruction({
      ...rows[0],
      instructionId: `capstone-${family.id}`,
      origin: { instructionIds: [`capstone-${family.id}`] },
    });
    assert.deepEqual(compareWithCapstoneOperands(instruction, rows[0].capstoneOperands), [], family.id);
  }

  // Exhaustively compare the deployed decoder's compressed acceptance surface.
  // Capstone deliberately omits architectural hints and accepts four extension
  // or reserved groups; these differences are enumerated exactly and cannot
  // hide a new decoder divergence.
  let capstoneDecoded = 0;
  let supportedHintNotDecoded = 0;
  let outOfProfileOrReservedDecoded = 0;
  for (let word = 0; word < 0x10000; word += 1) {
    if ((word & 0b11) === 0b11) continue;
    const bytes = bytes16(word);
    const fields = decodeRiscv64InstructionWord(bytes);
    const rows = capstone.decodeRaw(bytes, 0x1000n);
    const oracleDecoded = rows.length === 1 && rows[0].size === 2;
    if (oracleDecoded) capstoneDecoded += 1;
    if (fields.supported && !oracleDecoded) {
      assert.equal(fields.hint, true, `Capstone missed a non-hint in-profile encoding at 0x${word.toString(16)}`);
      supportedHintNotDecoded += 1;
    }
    if (!fields.supported && oracleDecoded) {
      assert.ok([
        'riscv64-floating-point-extension-outside-phase6-profile',
        'riscv64-c-addi4spn-reserved-zero-immediate',
        'riscv64-c-lui-reserved-zero-immediate',
      ].includes(fields.reason), `unexpected Capstone/official-profile divergence at 0x${word.toString(16)}:${fields.reason}`);
      outOfProfileOrReservedDecoded += 1;
    }
  }
  assert.equal(capstoneDecoded, 46_489);
  assert.equal(supportedHintNotDecoded, 285);
  assert.equal(outOfProfileOrReservedDecoded, 8_223);
} finally {
  capstone.close();
}

console.log('RV64IMC finite decoder denominator and exhaustive effects proof: PASS');
