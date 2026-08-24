import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE_PATH = path.join(ROOT, 'tools/validation/phase6/profile.json');

export const RV64IMC_DECODER_DENOMINATOR_SCHEMA = 'riscv64-rv64imc-decoder-denominator/v1';
export const RV64IMC_DECODER_DENOMINATOR_ID = 'riscv64:rv64imc:decoder-denominator:v1';

const entry = (id, mask, match, operation, completeness = 'exact') => Object.freeze({
  id,
  mask: mask >>> 0,
  match: match >>> 0,
  operation,
  completeness,
});

const opcodeFunct3 = (id, opcode, funct3, operation, completeness) => entry(
  id,
  0x0000707f,
  (opcode | (funct3 << 12)) >>> 0,
  operation,
  completeness,
);

const opcodeFunct3Funct7 = (id, opcode, funct3, funct7, operation, completeness) => entry(
  id,
  0xfe00707f,
  (opcode | (funct3 << 12) | (funct7 << 25)) >>> 0,
  operation,
  completeness,
);

/**
 * Finite RV64IMC 32-bit encoding-family denominator.
 *
 * These masks are the discriminating fields in the frozen profile's official
 * RV64I and M encoding tables. Non-discriminating register/immediate bits are
 * intentionally wildcards. FENCE and SYSTEM use stricter masks below because
 * their reserved register/immediate fields are themselves validity
 * discriminators. Entries are disjoint; a word matching more than one entry is
 * a denominator defect and fails validation.
 */
export const RV64IMC_32BIT_ENCODING_FAMILIES = Object.freeze([
  entry('rv64i-lui', 0x0000007f, 0x00000037, 'lui'),
  entry('rv64i-auipc', 0x0000007f, 0x00000017, 'auipc'),
  entry('rv64i-jal', 0x0000007f, 0x0000006f, 'jal'),
  opcodeFunct3('rv64i-jalr', 0x67, 0, 'jalr'),

  ...[[0, 'beq'], [1, 'bne'], [4, 'blt'], [5, 'bge'], [6, 'bltu'], [7, 'bgeu']]
    .map(([funct3, op]) => opcodeFunct3(`rv64i-branch-${op}`, 0x63, funct3, op)),
  ...[[0, 'lb'], [1, 'lh'], [2, 'lw'], [3, 'ld'], [4, 'lbu'], [5, 'lhu'], [6, 'lwu']]
    .map(([funct3, op]) => opcodeFunct3(`rv64i-load-${op}`, 0x03, funct3, op)),
  ...[[0, 'sb'], [1, 'sh'], [2, 'sw'], [3, 'sd']]
    .map(([funct3, op]) => opcodeFunct3(`rv64i-store-${op}`, 0x23, funct3, op)),

  ...[[0, 'addi'], [2, 'slti'], [3, 'sltiu'], [4, 'xori'], [6, 'ori'], [7, 'andi']]
    .map(([funct3, op]) => opcodeFunct3(`rv64i-op-imm-${op}`, 0x13, funct3, op)),
  entry('rv64i-op-imm-slli', 0xfc00707f, 0x00001013, 'slli'),
  entry('rv64i-op-imm-srli', 0xfc00707f, 0x00005013, 'srli'),
  entry('rv64i-op-imm-srai', 0xfc00707f, 0x40005013, 'srai'),

  opcodeFunct3('rv64i-op-imm-32-addiw', 0x1b, 0, 'addiw'),
  opcodeFunct3Funct7('rv64i-op-imm-32-slliw', 0x1b, 1, 0x00, 'slliw'),
  opcodeFunct3Funct7('rv64i-op-imm-32-srliw', 0x1b, 5, 0x00, 'srliw'),
  opcodeFunct3Funct7('rv64i-op-imm-32-sraiw', 0x1b, 5, 0x20, 'sraiw'),

  ...[[0, 'add'], [1, 'sll'], [2, 'slt'], [3, 'sltu'], [4, 'xor'], [5, 'srl'], [6, 'or'], [7, 'and']]
    .map(([funct3, op]) => opcodeFunct3Funct7(`rv64i-op-${op}`, 0x33, funct3, 0x00, op)),
  opcodeFunct3Funct7('rv64i-op-sub', 0x33, 0, 0x20, 'sub'),
  opcodeFunct3Funct7('rv64i-op-sra', 0x33, 5, 0x20, 'sra'),
  ...[[0, 'mul'], [1, 'mulh'], [2, 'mulhsu'], [3, 'mulhu'], [4, 'div'], [5, 'divu'], [6, 'rem'], [7, 'remu']]
    .map(([funct3, op]) => opcodeFunct3Funct7(`rv64m-op-${op}`, 0x33, funct3, 0x01, op)),

  ...[[0, 'addw'], [1, 'sllw'], [5, 'srlw']]
    .map(([funct3, op]) => opcodeFunct3Funct7(`rv64i-op-32-${op}`, 0x3b, funct3, 0x00, op)),
  opcodeFunct3Funct7('rv64i-op-32-subw', 0x3b, 0, 0x20, 'subw'),
  opcodeFunct3Funct7('rv64i-op-32-sraw', 0x3b, 5, 0x20, 'sraw'),
  ...[[0, 'mulw'], [4, 'divw'], [5, 'divuw'], [6, 'remw'], [7, 'remuw']]
    .map(([funct3, op]) => opcodeFunct3Funct7(`rv64m-op-32-${op}`, 0x3b, funct3, 0x01, op)),

  // Base FENCE: fm=0000 and the reserved rd/rs1 fields are both zero.
  entry('rv64i-fence', 0xf00fffff, 0x0000000f, 'fence'),
  // Canonical FENCE.TSO tuple: fm=1000, predecessor=RW, successor=RW.
  entry('rv64i-fence-tso', 0xffffffff, 0x8330000f, 'fence'),
  entry('rv64i-ecall', 0xffffffff, 0x00000073, 'ecall', 'partial-environment'),
  entry('rv64i-ebreak', 0xffffffff, 0x00100073, 'ebreak', 'partial-environment'),
]);

export const RV64IMC_COMPRESSED_ENCODING_FAMILIES = Object.freeze([
  'c.addi4spn', 'c.lw', 'c.ld', 'c.sw', 'c.sd',
  'c.nop', 'c.addi', 'c.addiw', 'c.li', 'c.addi16sp', 'c.lui',
  'c.srli', 'c.srai', 'c.andi', 'c.sub', 'c.xor', 'c.or', 'c.and', 'c.subw', 'c.addw',
  'c.j', 'c.beqz', 'c.bnez',
  'c.slli', 'c.lwsp', 'c.ldsp', 'c.jr', 'c.mv', 'c.ebreak', 'c.jalr', 'c.add', 'c.swsp', 'c.sdsp',
]);

export const RV64IMC_COMPRESSED_UNSUPPORTED_REASONS = Object.freeze([
  'riscv64-c-addi4spn-reserved-zero-immediate',
  'riscv64-c-addiw-reserved-zero-rd',
  'riscv64-c-addi16sp-reserved-zero-immediate',
  'riscv64-c-lui-reserved-zero-immediate',
  'riscv64-reserved-c-alu-encoding',
  'riscv64-c-lwsp-reserved-zero-rd',
  'riscv64-c-ldsp-reserved-zero-rd',
  'riscv64-c-jr-reserved-zero-rs1',
  'riscv64-floating-point-extension-outside-phase6-profile',
  'riscv64-reserved-c-quadrant0-encoding',
]);

export const RV64IMC_32BIT_OUT_OF_PROFILE_NEGATIVES = Object.freeze([
  Object.freeze({ id:'a-extension', word:0x00b5a52f, reason:'riscv64-atomic-extension-outside-phase6-profile' }),
  Object.freeze({ id:'f-d-q-extension', word:0x02b57553, reason:'riscv64-floating-point-extension-outside-phase6-profile' }),
  Object.freeze({ id:'zicsr-extension', word:0xc0002573, reason:'riscv64-zicsr-outside-phase6-profile' }),
  Object.freeze({ id:'zifencei-extension', word:0x0000100f, reason:'riscv64-zifencei-outside-phase6-profile' }),
  Object.freeze({ id:'privileged-system', word:0x30200073, reason:'riscv64-privileged-system-outside-phase6-profile' }),
  Object.freeze({ id:'reserved-opcode', word:0x0000007b, reason:'riscv64-unknown-opcode' }),
]);

export const RV64IMC_ALIAS_OR_HINT_VECTORS = Object.freeze([
  Object.freeze({ id:'nop', word:0x00000013, operation:'addi' }),
  Object.freeze({ id:'li', word:0x00100513, operation:'addi' }),
  Object.freeze({ id:'mv', word:0x00058513, operation:'addi' }),
  Object.freeze({ id:'not', word:0xfff5c513, operation:'xori' }),
  Object.freeze({ id:'neg', word:0x40b00533, operation:'sub' }),
  Object.freeze({ id:'ret', word:0x00008067, operation:'jalr' }),
]);

function matchingFamilies(word) {
  const value = Number(word) >>> 0;
  return RV64IMC_32BIT_ENCODING_FAMILIES.filter((family) => ((value & family.mask) >>> 0) === family.match);
}

export function classifyRv64imc32Encoding(word) {
  const matches = matchingFamilies(word);
  if (matches.length > 1) throw new Error(`rv64imc-denominator-overlap:0x${(Number(word) >>> 0).toString(16)}:${matches.map((item) => item.id).join(',')}`);
  return matches[0] ?? null;
}

export function validateRv64imcDecoderDenominator() {
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  if (profile.schemaVersion !== 'phase6-riscv64-profile/v1') throw new Error('rv64imc-denominator-profile-schema-drift');
  if (profile.isaProfile?.id !== 'rv64imc') throw new Error('rv64imc-denominator-profile-id-drift');
  if (profile.isaProfile?.baseIsa !== 'RV64I') throw new Error('rv64imc-denominator-base-isa-drift');
  if (JSON.stringify(profile.isaProfile?.standardExtensions) !== JSON.stringify(['M', 'C'])) {
    throw new Error('rv64imc-denominator-extension-set-drift');
  }
  if (profile.decoder?.semanticVersion !== 'capstone-5-riscv64-word-exact-v1') {
    throw new Error('rv64imc-denominator-decoder-semantic-version-drift');
  }
  if (new Set(RV64IMC_32BIT_ENCODING_FAMILIES.map((family) => family.id)).size !== RV64IMC_32BIT_ENCODING_FAMILIES.length) {
    throw new Error('rv64imc-denominator-32-bit-family-duplicate');
  }
  if (new Set(RV64IMC_COMPRESSED_ENCODING_FAMILIES).size !== RV64IMC_COMPRESSED_ENCODING_FAMILIES.length) {
    throw new Error('rv64imc-denominator-compressed-family-duplicate');
  }
  // Exhaustively establish that the finite mask table itself is disjoint over
  // all opcode/funct3/funct7 discriminator tuples.
  for (let opcode = 0; opcode < 0x80; opcode += 1) {
    if ((opcode & 0b11) !== 0b11 || (opcode & 0b11111) === 0b11111) continue;
    for (let funct3 = 0; funct3 < 8; funct3 += 1) {
      for (let funct7 = 0; funct7 < 0x80; funct7 += 1) {
        const word = (opcode | (1 << 7) | (funct3 << 12) | (2 << 15) | (3 << 20) | (funct7 << 25)) >>> 0;
        matchingFamilies(word);
        if (matchingFamilies(word).length > 1) throw new Error('rv64imc-denominator-32-bit-family-overlap');
      }
    }
  }
  return Object.freeze({
    valid: true,
    schemaVersion: RV64IMC_DECODER_DENOMINATOR_SCHEMA,
    denominatorId: RV64IMC_DECODER_DENOMINATOR_ID,
    profileId: 'riscv64:rv64imc',
    encoding32FamilyCount: RV64IMC_32BIT_ENCODING_FAMILIES.length,
    compressedFamilyCount: RV64IMC_COMPRESSED_ENCODING_FAMILIES.length,
    compressedWordCount: 0xc000,
    discriminatorTupleCount: 28 * 8 * 0x80,
    oracleIds: Object.freeze([
      'deployed-capstone-5.0-riscv64-detail',
      'riscv-unprivileged-isa-rv64i-m-c-encoding-tables',
    ]),
  });
}
