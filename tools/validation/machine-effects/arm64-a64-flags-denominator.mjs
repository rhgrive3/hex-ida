export const ARM64_A64_FLAGS_DENOMINATOR_SCHEMA = 'arm64-a64-flags-denominator/v1';
export const ARM64_A64_FLAGS_DENOMINATOR_ID = 'arm64:a64:flags-encoding-discriminators:v1';

const entry = (id, mask, match, operation) => Object.freeze({ id, mask:mask >>> 0, match:match >>> 0, operation });

export const ARM64_A64_FLAG_ENCODING_FAMILIES = Object.freeze([
  entry('cmn-shifted-register', 0x7f20001f, 0x2b00001f, 'cmn'),
  entry('cmp-shifted-register', 0x7f20001f, 0x6b00001f, 'cmp'),
  entry('cmn-extended-register', 0x7fe0001f, 0x2b20001f, 'cmn'),
  entry('cmp-extended-register', 0x7fe0001f, 0x6b20001f, 'cmp'),
  entry('cmn-immediate', 0x7f80001f, 0x3100001f, 'cmn'),
  entry('cmp-immediate', 0x7f80001f, 0x7100001f, 'cmp'),
  entry('tst-shifted-register', 0x7f20001f, 0x6a00001f, 'tst'),
  entry('tst-logical-immediate', 0x7f80001f, 0x7200001f, 'tst'),
  entry('ccmn-register', 0x7fe00c10, 0x3a400000, 'ccmn'),
  entry('ccmp-register', 0x7fe00c10, 0x7a400000, 'ccmp'),
  entry('ccmn-immediate', 0x7fe00c10, 0x3a400800, 'ccmn'),
  entry('ccmp-immediate', 0x7fe00c10, 0x7a400800, 'ccmp'),
]);

const CONDITIONS = 16;
export const ARM64_A64_FLAGS_EXPECTED = Object.freeze({
  encodingFamilyCount:12,
  encodingCaseCount:15232,
  conditionCount:16,
  familyCaseCounts:Object.freeze({
    'cmn-shifted-register':352, 'cmn-extended-register':144, 'cmn-immediate':80,
    'cmp-shifted-register':352, 'cmp-extended-register':144, 'cmp-immediate':80,
    'tst-shifted-register':448, 'tst-logical-immediate':11392,
    'ccmn-register':576, 'ccmn-immediate':544, 'ccmp-register':576, 'ccmp-immediate':544,
  }),
});

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

export function classifyArm64A64FlagEncoding(word) {
  const value = Number(word) >>> 0;
  const matches = ARM64_A64_FLAG_ENCODING_FAMILIES.filter((family) => ((value & family.mask) >>> 0) === family.match);
  if (matches.length > 1) throw new Error(`arm64-flags-denominator-overlap:0x${value.toString(16)}`);
  const family = matches[0] ?? null;
  if (!family) return null;
  const sf = value >>> 31;
  const amount = (value >>> 10) & 0x3f;
  if (family.id.endsWith('shifted-register')) {
    const shift = (value >>> 22) & 3;
    if ((family.operation !== 'tst' && shift === 3) || (!sf && amount >= 32)) return null;
  }
  if (family.id.endsWith('extended-register') && ((value >>> 10) & 7) > 4) return null;
  if (family.id === 'tst-logical-immediate') {
    const N = (value >>> 22) & 1;
    const immr = (value >>> 16) & 0x3f;
    const imms = (value >>> 10) & 0x3f;
    if (!validLogicalImmediate(sf, N, immr, imms)) return null;
  }
  return family;
}

export function* arm64A64FlagEncodingCases() {
  for (const [operation, base] of [['cmn',0x2b00001f],['cmp',0x6b00001f]]) {
    for (const sf of [0,1]) for (let shift = 0; shift < 3; shift++) for (let amount = 0; amount < (sf ? 64 : 32); amount++) {
      yield Object.freeze({ id:`${operation}:shifted:${sf}:${shift}:${amount}`, operation, word:(base | (sf << 31) | (shift << 22) | (1 << 16) | (amount << 10)) >>> 0 });
    }
    for (const sf of [0,1]) for (let option = 0; option < 8; option++) for (let amount = 0; amount <= 4; amount++) {
      yield Object.freeze({ id:`${operation}:extended:${sf}:${option}:${amount}`, operation, word:(base | 0x00200000 | (sf << 31) | (1 << 16) | (option << 13) | (amount << 10)) >>> 0 });
    }
    for (const sf of [0,1]) for (const shift of [0,1]) for (const immediate of [0,1,0x7ff,0xfff]) {
      yield Object.freeze({ id:`${operation}:immediate:${sf}:${shift}:${immediate}`, operation, word:((operation === 'cmp' ? 0x7100001f : 0x3100001f) | (sf << 31) | (shift << 22) | (immediate << 10)) >>> 0 });
    }
  }

  for (const sf of [0,1]) for (let shift = 0; shift < 4; shift++) for (let amount = 0; amount < (sf ? 64 : 32); amount++) {
    yield Object.freeze({ id:`tst:shifted:${sf}:${shift}:${amount}`, operation:'tst', word:(0x6a00001f | (sf << 31) | (shift << 22) | (1 << 16) | (amount << 10)) >>> 0 });
  }
  for (const sf of [0,1]) for (let N = 0; N < 2; N++) for (let immr = 0; immr < 64; immr++) for (let imms = 0; imms < 64; imms++) {
    if (!validLogicalImmediate(sf, N, immr, imms)) continue;
    yield Object.freeze({ id:`tst:immediate:${sf}:${N}:${immr}:${imms}`, operation:'tst', word:(0x7200001f | (sf << 31) | (N << 22) | (immr << 16) | (imms << 10)) >>> 0 });
  }

  for (const [operation, base] of [['ccmn',0x3a400000],['ccmp',0x7a400000]]) {
    for (const sf of [0,1]) for (let condition = 0; condition < CONDITIONS; condition++) for (let nzcv = 0; nzcv < 16; nzcv++) {
      yield Object.freeze({ id:`${operation}:register:${sf}:${condition}:${nzcv}`, operation, word:(base | (sf << 31) | (1 << 16) | (condition << 12) | nzcv) >>> 0 });
      yield Object.freeze({ id:`${operation}:immediate:${sf}:${condition}:${nzcv}`, operation, word:(base | 0x800 | (sf << 31) | (31 << 16) | (condition << 12) | nzcv) >>> 0 });
    }
  }

  // Register fields are non-discriminating payloads; sweep their complete
  // architectural domains independently through each applicable encoding.
  for (const [operation, words] of [
    ['cmn',[0x2b01001f,0x2b21001f,0x3100041f]],
    ['cmp',[0x6b01001f,0x6b21001f,0x7100041f]],
    ['tst',[0x6a01001f,0x7200041f]],
    ['ccmn',[0x3a410000,0x3a5f0800]],
    ['ccmp',[0x7a410000,0x7a5f0800]],
  ]) {
    for (const template of words) for (const shift of [5,16]) for (let register = 0; register < 32; register++) {
      if (shift === 16 && (template & 0x800)) continue;
      const word = ((template & ~(0x1f << shift)) | (register << shift)) >>> 0;
      yield Object.freeze({ id:`${operation}:register-domain:${template}:${shift}:${register}`, operation, word });
    }
  }
}

export function validateArm64A64FlagsDenominator() {
  for (let left = 0; left < ARM64_A64_FLAG_ENCODING_FAMILIES.length; left++) {
    const a = ARM64_A64_FLAG_ENCODING_FAMILIES[left];
    if (((a.match & a.mask) >>> 0) !== a.match) throw new Error(`arm64-flags-denominator-match-outside-mask:${a.id}`);
    for (let right = left + 1; right < ARM64_A64_FLAG_ENCODING_FAMILIES.length; right++) {
      const b = ARM64_A64_FLAG_ENCODING_FAMILIES[right];
      if ((((a.match ^ b.match) & (a.mask & b.mask)) >>> 0) === 0) throw new Error(`arm64-flags-denominator-family-overlap:${a.id}:${b.id}`);
    }
  }
  let encodingCaseCount = 0;
  const observed = new Set();
  const familyCaseCounts = {};
  for (const item of arm64A64FlagEncodingCases()) {
    const family = classifyArm64A64FlagEncoding(item.word);
    if (!family) throw new Error(`arm64-flags-denominator-case-unowned:${item.id}`);
    observed.add(family.id);
    familyCaseCounts[family.id] = (familyCaseCounts[family.id] || 0) + 1;
    encodingCaseCount++;
  }
  if (observed.size !== ARM64_A64_FLAG_ENCODING_FAMILIES.length) throw new Error('arm64-flags-denominator-family-unobserved');
  if (CONDITIONS !== ARM64_A64_FLAGS_EXPECTED.conditionCount
    || ARM64_A64_FLAG_ENCODING_FAMILIES.length !== ARM64_A64_FLAGS_EXPECTED.encodingFamilyCount
    || encodingCaseCount !== ARM64_A64_FLAGS_EXPECTED.encodingCaseCount
    || JSON.stringify(familyCaseCounts) !== JSON.stringify(ARM64_A64_FLAGS_EXPECTED.familyCaseCounts)) {
    throw new Error('arm64-flags-denominator-cardinality-drift');
  }
  return Object.freeze({
    valid:true, schemaVersion:ARM64_A64_FLAGS_DENOMINATOR_SCHEMA, denominatorId:ARM64_A64_FLAGS_DENOMINATOR_ID,
    profileId:'arm64:a64', encodingFamilyCount:ARM64_A64_FLAG_ENCODING_FAMILIES.length, encodingCaseCount,
    conditionCount:CONDITIONS, familyCaseCounts:Object.freeze(familyCaseCounts),
    oracleIds:Object.freeze(['arm-a-profile-a64-data-processing-encoding-tables','deployed-capstone-5-arm64','llvm-mc-18-aarch64-disassembler']),
  });
}
