export const ARM64_A64_INTEGER_DENOMINATOR_SCHEMA = 'arm64-a64-integer-denominator/v1';
export const ARM64_A64_INTEGER_DENOMINATOR_ID = 'arm64:a64:integer-encoding-discriminators:v1';

// Decoder spellings accepted by the production integer registry. Some are Arm
// assembly aliases that deployed Capstone canonicalizes to another spelling;
// those alternate-provider paths remain part of the effect-family contract.
export const ARM64_A64_INTEGER_MNEMONIC_DENOMINATOR = Object.freeze([
  'add','adds','sub','subs','adc','adcs','sbc','sbcs','neg','negs','ngc','ngcs',
  'and','ands','orr','eor','bic','bics','orn','eon','mvn',
  'lsl','lslv','lsr','lsrv','asr','asrv','ror','rorv',
  'mul','mneg','smull','umull','smulh','umulh','sdiv','udiv',
  'madd','msub','smaddl','smsubl','umaddl','umsubl','smnegl','umnegl',
  'mov','movz','movn','movk','adr','adrp',
  'ubfx','sbfx','ubfiz','sbfiz','bfxil','bfi','bfc','ubfm','sbfm','bfm','extr',
  'sxtb','sxth','sxtw','uxtb','uxth','uxtw','clz','rbit','rev','rev16','rev32','abs',
  'csel','csinc','csinv','csneg','cset','csetm','cinc','cneg','cinv',
]);

const entry = (id, mask, match, operation) => Object.freeze({
  id,
  mask:mask >>> 0,
  match:match >>> 0,
  operation,
});

// Fixed fields from the Arm A-profile A64 data-processing encoding tables.
// Operand registers and immediate payloads are deliberately outside these
// masks; their complete discriminator domains (and representative payload
// boundaries) are generated below.
export const ARM64_A64_INTEGER_ENCODING_FAMILIES = Object.freeze([
  entry('add-sub-immediate',          0x1f800000, 0x11000000, 'add-sub'),
  entry('add-sub-shifted-register',   0x1f200000, 0x0b000000, 'add-sub'),
  entry('add-sub-extended-register',  0x1f200000, 0x0b200000, 'add-sub'),
  entry('add-sub-with-carry',         0x1fe0fc00, 0x1a000000, 'add-sub-carry'),
  entry('logical-immediate',          0x1f800000, 0x12000000, 'logical'),
  entry('logical-shifted-register',   0x1f000000, 0x0a000000, 'logical'),

  entry('udiv',                       0x7fe0fc00, 0x1ac00800, 'udiv'),
  entry('sdiv',                       0x7fe0fc00, 0x1ac00c00, 'sdiv'),
  entry('lslv',                       0x7fe0fc00, 0x1ac02000, 'lsl'),
  entry('lsrv',                       0x7fe0fc00, 0x1ac02400, 'lsr'),
  entry('asrv',                       0x7fe0fc00, 0x1ac02800, 'asr'),
  entry('rorv',                       0x7fe0fc00, 0x1ac02c00, 'ror'),

  entry('madd',                       0x7fe08000, 0x1b000000, 'madd'),
  entry('msub',                       0x7fe08000, 0x1b008000, 'msub'),
  entry('smaddl',                     0xffe08000, 0x9b200000, 'smaddl'),
  entry('smsubl',                     0xffe08000, 0x9b208000, 'smsubl'),
  entry('umaddl',                     0xffe08000, 0x9ba00000, 'umaddl'),
  entry('umsubl',                     0xffe08000, 0x9ba08000, 'umsubl'),
  entry('smulh',                      0xffe0fc00, 0x9b407c00, 'smulh'),
  entry('umulh',                      0xffe0fc00, 0x9bc07c00, 'umulh'),

  entry('movn',                       0x7f800000, 0x12800000, 'movn'),
  entry('movz',                       0x7f800000, 0x52800000, 'movz'),
  entry('movk',                       0x7f800000, 0x72800000, 'movk'),
  entry('adr',                        0x9f000000, 0x10000000, 'adr'),
  entry('adrp',                       0x9f000000, 0x90000000, 'adrp'),

  entry('sbfm',                       0x7f800000, 0x13000000, 'sbfm'),
  entry('bfm',                        0x7f800000, 0x33000000, 'bfm'),
  entry('ubfm',                       0x7f800000, 0x53000000, 'ubfm'),
  entry('extr',                       0x7fa00000, 0x13800000, 'extr'),

  entry('rbit',                       0x7ffffc00, 0x5ac00000, 'rbit'),
  entry('rev16',                      0x7ffffc00, 0x5ac00400, 'rev16'),
  entry('rev-or-rev32',               0x7ffffc00, 0x5ac00800, 'rev'),
  entry('rev64',                      0x7ffffc00, 0x5ac00c00, 'rev'),
  entry('clz',                        0x7ffffc00, 0x5ac01000, 'clz'),
  entry('abs-cssc',                   0x7ffffc00, 0x5ac02000, 'abs'),

  entry('csel',                       0x7fe00c00, 0x1a800000, 'csel'),
  entry('csinc',                      0x7fe00c00, 0x1a800400, 'csinc'),
  entry('csinv',                      0x7fe00c00, 0x5a800000, 'csinv'),
  entry('csneg',                      0x7fe00c00, 0x5a800400, 'csneg'),
]);

const PAYLOAD_IMMEDIATES_12 = Object.freeze([0, 1, 0x7ff, 0xfff]);
const PAYLOAD_IMMEDIATES_16 = Object.freeze([0, 1, 0x7fff, 0xffff]);
const PAYLOAD_IMMEDIATES_21 = Object.freeze([0, 1, 0xfffff, 0x100000, 0x1fffff]);

function highestSetBit(value) {
  for (let bit = 6; bit >= 0; bit--) if (value & (1 << bit)) return bit;
  return -1;
}

function validLogicalImmediate(sf, N, immr, imms) {
  if (!sf && N) return false;
  const len = highestSetBit((N << 6) | ((~imms) & 0x3f));
  if (len < 1 || (!sf && len > 5)) return false;
  const levels = (1 << len) - 1;
  const highMask = (~((1 << (len + 1)) - 1)) & 0x3f;
  return (imms & levels) !== levels && (imms & highMask) === highMask;
}

function isValidFamilyWord(family, value) {
  const sf = value >>> 31;
  if (family.id === 'add-sub-shifted-register') {
    const shift = (value >>> 22) & 3;
    const amount = (value >>> 10) & 0x3f;
    return shift !== 3 && (sf || amount < 32);
  }
  if (family.id === 'add-sub-extended-register') return ((value >>> 10) & 7) <= 4;
  if (family.id === 'logical-immediate') {
    return validLogicalImmediate(sf, (value >>> 22) & 1, (value >>> 16) & 0x3f, (value >>> 10) & 0x3f);
  }
  if (family.id === 'logical-shifted-register') return sf || ((value >>> 10) & 0x3f) < 32;
  if (family.id === 'movn' || family.id === 'movz' || family.id === 'movk') {
    return sf || ((value >>> 21) & 3) < 2;
  }
  if (family.id === 'sbfm' || family.id === 'bfm' || family.id === 'ubfm' || family.id === 'extr') {
    const N = (value >>> 22) & 1;
    const amount = (value >>> 10) & 0x3f;
    return N === sf && (sf || amount < 32);
  }
  if (family.id === 'rev64') return sf === 1;
  if (family.id === 'rev-or-rev32') return true;
  return true;
}

export function classifyArm64A64IntegerEncoding(word) {
  const value = Number(word) >>> 0;
  const matches = ARM64_A64_INTEGER_ENCODING_FAMILIES.filter((family) => (
    ((value & family.mask) >>> 0) === family.match && isValidFamilyWord(family, value)
  ));
  if (matches.length > 1) throw new Error(`arm64-integer-denominator-overlap:0x${value.toString(16)}:${matches.map(({ id }) => id).join(',')}`);
  return matches[0] ?? null;
}

function item(id, familyId, word) {
  return Object.freeze({ id, familyId, word:word >>> 0 });
}

function* registerPayloadCases(familyId, template, fields) {
  for (const shift of fields) for (let register = 0; register < 32; register++) {
    yield item(`${familyId}:register:${shift}:${register}`, familyId, ((template & ~(0x1f << shift)) | (register << shift)) >>> 0);
  }
}

export function* arm64A64IntegerEncodingCases() {
  // Add/subtract immediate: all op/S/shift discriminators and immediate
  // boundaries. Rd=31 with S=1 is CMP/CMN and is owned by the flags family.
  for (const sf of [0,1]) for (const op of [0,1]) for (const S of [0,1]) for (const shift of [0,1]) {
    for (const imm12 of PAYLOAD_IMMEDIATES_12) {
      const rd = S ? 0 : 31;
      const word = (0x11000000 | (sf << 31) | (op << 30) | (S << 29) | (shift << 22) | (imm12 << 10) | (1 << 5) | rd) >>> 0;
      yield item(`add-sub-immediate:${sf}:${op}:${S}:${shift}:${imm12}`, 'add-sub-immediate', word);
    }
  }
  yield* registerPayloadCases('add-sub-immediate', 0x91000420, [0,5]);

  for (const sf of [0,1]) for (const op of [0,1]) for (const S of [0,1]) for (let shift = 0; shift < 3; shift++) {
    for (let amount = 0; amount < (sf ? 64 : 32); amount++) {
      const word = (0x0b000000 | (sf << 31) | (op << 30) | (S << 29) | (shift << 22) | (2 << 16) | (amount << 10) | (1 << 5)) >>> 0;
      yield item(`add-sub-shifted:${sf}:${op}:${S}:${shift}:${amount}`, 'add-sub-shifted-register', word);
    }
  }
  yield* registerPayloadCases('add-sub-shifted-register', 0x8b020020, [0,5,16]);
  for (const [alias, op, S] of [['neg',1,0],['negs',1,1]]) {
    for (const sf of [0,1]) yield item(`${alias}:${sf}`, 'add-sub-shifted-register', (0x0b000000 | (sf << 31) | (op << 30) | (S << 29) | (1 << 16) | (31 << 5)) >>> 0);
  }

  for (const sf of [0,1]) for (const op of [0,1]) for (const S of [0,1]) for (let option = 0; option < 8; option++) for (let amount = 0; amount <= 4; amount++) {
    const word = (0x0b200000 | (sf << 31) | (op << 30) | (S << 29) | (2 << 16) | (option << 13) | (amount << 10) | (1 << 5)) >>> 0;
    yield item(`add-sub-extended:${sf}:${op}:${S}:${option}:${amount}`, 'add-sub-extended-register', word);
  }
  yield* registerPayloadCases('add-sub-extended-register', 0x8b224020, [0,5,16]);

  for (const sf of [0,1]) for (const op of [0,1]) for (const S of [0,1]) {
    const word = (0x1a000000 | (sf << 31) | (op << 30) | (S << 29) | (2 << 16) | (1 << 5)) >>> 0;
    yield item(`add-sub-carry:${sf}:${op}:${S}`, 'add-sub-with-carry', word);
  }
  yield* registerPayloadCases('add-sub-with-carry', 0x9a020020, [0,5,16]);
  for (const [alias, S] of [['ngc',0],['ngcs',1]]) {
    for (const sf of [0,1]) yield item(`${alias}:${sf}`, 'add-sub-with-carry', (0x5a000000 | (sf << 31) | (S << 29) | (1 << 16) | (31 << 5)) >>> 0);
  }

  for (const sf of [0,1]) for (let opc = 0; opc < 4; opc++) for (const N of [0,1]) for (let immr = 0; immr < 64; immr++) for (let imms = 0; imms < 64; imms++) {
    if (!validLogicalImmediate(sf,N,immr,imms)) continue;
    const rd = opc === 3 ? 0 : 31; // Avoid the TST alias, proven by flags.
    const word = (0x12000000 | (sf << 31) | (opc << 29) | (N << 22) | (immr << 16) | (imms << 10) | (1 << 5) | rd) >>> 0;
    yield item(`logical-immediate:${sf}:${opc}:${N}:${immr}:${imms}`, 'logical-immediate', word);
  }
  yield* registerPayloadCases('logical-immediate', 0x92400020, [0,5]);

  for (const sf of [0,1]) for (let opc = 0; opc < 4; opc++) for (const N of [0,1]) for (let shift = 0; shift < 4; shift++) for (let amount = 0; amount < (sf ? 64 : 32); amount++) {
    const rd = opc === 3 ? 0 : 31; // Avoid the TST alias, proven by flags.
    const word = (0x0a000000 | (sf << 31) | (opc << 29) | (shift << 22) | (N << 21) | (2 << 16) | (amount << 10) | (1 << 5) | rd) >>> 0;
    yield item(`logical-shifted:${sf}:${opc}:${N}:${shift}:${amount}`, 'logical-shifted-register', word);
  }
  yield* registerPayloadCases('logical-shifted-register', 0x8a020020, [0,5,16]);
  for (const sf of [0,1]) yield item(`mvn:${sf}`, 'logical-shifted-register', (0x2a200000 | (sf << 31) | (1 << 16) | (31 << 5)) >>> 0);

  for (const [familyId, base] of [
    ['udiv',0x1ac00800],['sdiv',0x1ac00c00],['lslv',0x1ac02000],
    ['lsrv',0x1ac02400],['asrv',0x1ac02800],['rorv',0x1ac02c00],
  ]) {
    for (const sf of [0,1]) yield item(`${familyId}:${sf}`, familyId, (base | (sf << 31) | (2 << 16) | (1 << 5)) >>> 0);
    yield* registerPayloadCases(familyId, (base | 0x80000000 | (2 << 16) | (1 << 5)) >>> 0, [0,5,16]);
  }

  for (const [familyId, base, widths] of [
    ['madd',0x1b000000,[0,1]],['msub',0x1b008000,[0,1]],
    ['smaddl',0x9b200000,[1]],['smsubl',0x9b208000,[1]],
    ['umaddl',0x9ba00000,[1]],['umsubl',0x9ba08000,[1]],
  ]) {
    for (const sf of widths) {
      const word = (base | (sf << 31) | (2 << 16) | (3 << 10) | (1 << 5)) >>> 0;
      yield item(`${familyId}:${sf}`, familyId, word);
    }
    yield* registerPayloadCases(familyId, (base | 0x80000000 | (2 << 16) | (3 << 10) | (1 << 5)) >>> 0, [0,5,10,16]);
  }
  for (const [familyId, base] of [['smulh',0x9b407c00],['umulh',0x9bc07c00]]) {
    yield item(`${familyId}:64`, familyId, (base | (2 << 16) | (1 << 5)) >>> 0);
    yield* registerPayloadCases(familyId, (base | (2 << 16) | (1 << 5)) >>> 0, [0,5,16]);
  }

  for (const [familyId, base] of [['movn',0x12800000],['movz',0x52800000],['movk',0x72800000]]) {
    for (const sf of [0,1]) for (let hw = 0; hw < (sf ? 4 : 2); hw++) for (const imm16 of PAYLOAD_IMMEDIATES_16) {
      yield item(`${familyId}:${sf}:${hw}:${imm16}`, familyId, (base | (sf << 31) | (hw << 21) | (imm16 << 5)) >>> 0);
    }
    yield* registerPayloadCases(familyId, (base | 0x80000020) >>> 0, [0]);
  }

  for (const [familyId, base] of [['adr',0x10000000],['adrp',0x90000000]]) {
    for (const imm21 of PAYLOAD_IMMEDIATES_21) {
      const immlo = imm21 & 3;
      const immhi = imm21 >>> 2;
      yield item(`${familyId}:imm21:${imm21}`, familyId, (base | (immlo << 29) | (immhi << 5)) >>> 0);
    }
    yield* registerPayloadCases(familyId, base, [0]);
  }

  for (const [familyId, base] of [['sbfm',0x13000000],['bfm',0x33000000],['ubfm',0x53000000]]) {
    for (const sf of [0,1]) for (let immr = 0; immr < (sf ? 64 : 32); immr++) for (let imms = 0; imms < (sf ? 64 : 32); imms++) {
      const word = (base | (sf << 31) | (sf << 22) | (immr << 16) | (imms << 10) | (1 << 5)) >>> 0;
      yield item(`${familyId}:${sf}:${immr}:${imms}`, familyId, word);
    }
    yield* registerPayloadCases(familyId, (base | 0x80400020) >>> 0, [0,5]);
  }
  for (const sf of [0,1]) for (let lsb = 0; lsb < (sf ? 64 : 32); lsb++) {
    yield item(`extr:${sf}:${lsb}`, 'extr', (0x13800000 | (sf << 31) | (sf << 22) | (2 << 16) | (lsb << 10) | (1 << 5)) >>> 0);
  }
  yield* registerPayloadCases('extr', 0x93c20420, [0,5,16]);

  for (const [familyId, base, widths] of [
    ['rbit',0x5ac00000,[0,1]],['rev16',0x5ac00400,[0,1]],
    ['rev-or-rev32',0x5ac00800,[0,1]],['rev64',0x5ac00c00,[1]],
    ['clz',0x5ac01000,[0,1]],['abs-cssc',0x5ac02000,[0,1]],
  ]) {
    for (const sf of widths) yield item(`${familyId}:${sf}`, familyId, (base | (sf << 31) | (1 << 5)) >>> 0);
    if (familyId !== 'abs-cssc') yield* registerPayloadCases(familyId, (base | 0x80000020) >>> 0, [0,5]);
  }

  for (const [familyId, base] of [['csel',0x1a800000],['csinc',0x1a800400],['csinv',0x5a800000],['csneg',0x5a800400]]) {
    for (const sf of [0,1]) for (let condition = 0; condition < 16; condition++) {
      yield item(`${familyId}:${sf}:${condition}`, familyId, (base | (sf << 31) | (2 << 16) | (condition << 12) | (1 << 5)) >>> 0);
    }
    yield* registerPayloadCases(familyId, (base | 0x80000000 | (2 << 16) | (1 << 5)) >>> 0, [0,5,16]);
  }
  for (const [alias, familyId, base] of [['cset','csinc',0x1a800400],['csetm','csinv',0x5a800000]]) {
    for (const sf of [0,1]) for (let condition = 0; condition < 16; condition++) {
      yield item(`${alias}:${sf}:${condition}`, familyId, (base | (sf << 31) | (31 << 16) | (condition << 12) | (31 << 5)) >>> 0);
    }
  }
}

export function validateArm64A64IntegerDenominator() {
  if (new Set(ARM64_A64_INTEGER_MNEMONIC_DENOMINATOR).size !== ARM64_A64_INTEGER_MNEMONIC_DENOMINATOR.length) {
    throw new Error('arm64-integer-denominator-mnemonic-duplicate');
  }
  const ids = ARM64_A64_INTEGER_ENCODING_FAMILIES.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('arm64-integer-denominator-family-duplicate');
  for (let left = 0; left < ARM64_A64_INTEGER_ENCODING_FAMILIES.length; left++) {
    const a = ARM64_A64_INTEGER_ENCODING_FAMILIES[left];
    if (((a.match & a.mask) >>> 0) !== a.match) throw new Error(`arm64-integer-denominator-match-outside-mask:${a.id}`);
    for (let right = left + 1; right < ARM64_A64_INTEGER_ENCODING_FAMILIES.length; right++) {
      const b = ARM64_A64_INTEGER_ENCODING_FAMILIES[right];
      if ((((a.match ^ b.match) & (a.mask & b.mask)) >>> 0) === 0) {
        throw new Error(`arm64-integer-denominator-family-overlap:${a.id}:${b.id}`);
      }
    }
  }
  let encodingCaseCount = 0;
  const observed = new Set();
  for (const candidate of arm64A64IntegerEncodingCases()) {
    const family = classifyArm64A64IntegerEncoding(candidate.word);
    if (!family || family.id !== candidate.familyId) throw new Error(`arm64-integer-denominator-case-unowned:${candidate.id}:${family?.id || 'none'}`);
    observed.add(family.id);
    encodingCaseCount++;
  }
  if (observed.size !== ARM64_A64_INTEGER_ENCODING_FAMILIES.length) throw new Error('arm64-integer-denominator-family-unobserved');
  return Object.freeze({
    valid:true,
    schemaVersion:ARM64_A64_INTEGER_DENOMINATOR_SCHEMA,
    denominatorId:ARM64_A64_INTEGER_DENOMINATOR_ID,
    profileId:'arm64:a64',
    encodingFamilyCount:ARM64_A64_INTEGER_ENCODING_FAMILIES.length,
    encodingCaseCount,
    mnemonicCount:ARM64_A64_INTEGER_MNEMONIC_DENOMINATOR.length,
    registerCount:32,
    conditionCount:16,
    oracleIds:Object.freeze([
      'arm-a-profile-a64-data-processing-encoding-tables',
      'deployed-capstone-5-arm64',
      'llvm-mc-18-aarch64-disassembler',
    ]),
  });
}
