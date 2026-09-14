export const ARM64_A64_CONTROL_DENOMINATOR_SCHEMA = 'arm64-a64-control-denominator/v1';
export const ARM64_A64_CONTROL_DENOMINATOR_ID = 'arm64:a64:control-encoding-discriminators:v1';

const entry = (id, mask, match, operation) => Object.freeze({ id, mask:mask >>> 0, match:match >>> 0, operation });

// Mask/match rows are the discriminating fields from the Arm A64 branch,
// exception and system instruction encoding tables. Register and signed
// immediate payloads are enumerated separately below.
export const ARM64_A64_CONTROL_ENCODING_FAMILIES = Object.freeze([
  entry('branch-immediate-b', 0xfc000000, 0x14000000, 'b'),
  entry('branch-immediate-bl', 0xfc000000, 0x94000000, 'bl'),
  entry('conditional-branch-immediate', 0xff000010, 0x54000000, 'b.cond'),
  entry('compare-and-branch-zero', 0x7f000000, 0x34000000, 'cbz'),
  entry('compare-and-branch-nonzero', 0x7f000000, 0x35000000, 'cbnz'),
  entry('test-bit-and-branch-zero', 0x7f000000, 0x36000000, 'tbz'),
  entry('test-bit-and-branch-nonzero', 0x7f000000, 0x37000000, 'tbnz'),
  entry('branch-register', 0xfffffc1f, 0xd61f0000, 'br'),
  entry('branch-link-register', 0xfffffc1f, 0xd63f0000, 'blr'),
  entry('return-register', 0xfffffc1f, 0xd65f0000, 'ret'),
]);

const DIRECT_OFFSETS = Object.freeze([0, 1, 0x1ffffff, 0x2000000, 0x3ffffff]);
const COND_OFFSETS = Object.freeze([0, 1, 0x3ffff, 0x40000, 0x7ffff]);
const TEST_OFFSETS = Object.freeze([0, 1, 0x1fff, 0x2000, 0x3fff]);
const CONDITIONS = Object.freeze(['eq','ne','hs','lo','mi','pl','vs','vc','hi','ls','ge','lt','gt','le','al','nv']);

export function classifyArm64A64ControlEncoding(word) {
  const value = Number(word) >>> 0;
  const matches = ARM64_A64_CONTROL_ENCODING_FAMILIES.filter((family) => ((value & family.mask) >>> 0) === family.match);
  if (matches.length > 1) throw new Error(`arm64-control-denominator-overlap:0x${value.toString(16)}`);
  return matches[0] ?? null;
}

export function* arm64A64ControlEncodingCases() {
  for (const [operation, base] of [['b',0x14000000],['bl',0x94000000]]) {
    for (const immediate of DIRECT_OFFSETS) {
      yield Object.freeze({ id:`${operation}:imm26:${immediate}`, operation, word:(base | immediate) >>> 0 });
    }
  }
  for (let condition = 0; condition < CONDITIONS.length; condition++) {
    for (const immediate of COND_OFFSETS) {
      yield Object.freeze({ id:`b.${CONDITIONS[condition]}:imm19:${immediate}`, operation:`b.${CONDITIONS[condition]}`, word:(0x54000000 | (immediate << 5) | condition) >>> 0 });
    }
  }
  for (const [operation, base] of [['cbz',0x34000000],['cbnz',0x35000000]]) {
    for (const sf of [0,1]) for (let register = 0; register < 32; register++) for (const immediate of COND_OFFSETS) {
      yield Object.freeze({ id:`${operation}:${sf ? 'x' : 'w'}${register}:imm19:${immediate}`, operation, word:(base | (sf << 31) | (immediate << 5) | register) >>> 0 });
    }
  }
  for (const [operation, base] of [['tbz',0x36000000],['tbnz',0x37000000]]) {
    for (let bit = 0; bit < 64; bit++) for (let register = 0; register < 32; register++) for (const immediate of TEST_OFFSETS) {
      yield Object.freeze({
        id:`${operation}:bit${bit}:r${register}:imm14:${immediate}`,
        operation,
        word:(base | ((bit >>> 5) << 31) | ((bit & 31) << 19) | (immediate << 5) | register) >>> 0,
      });
    }
  }
  for (const [operation, base] of [['br',0xd61f0000],['blr',0xd63f0000],['ret',0xd65f0000]]) {
    for (let register = 0; register < 32; register++) {
      yield Object.freeze({ id:`${operation}:x${register}`, operation, word:(base | (register << 5)) >>> 0 });
    }
  }
}

export function validateArm64A64ControlDenominator() {
  const ids = ARM64_A64_CONTROL_ENCODING_FAMILIES.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('arm64-control-denominator-family-duplicate');
  for (let left = 0; left < ARM64_A64_CONTROL_ENCODING_FAMILIES.length; left++) {
    const a = ARM64_A64_CONTROL_ENCODING_FAMILIES[left];
    if (((a.match & a.mask) >>> 0) !== a.match) throw new Error(`arm64-control-denominator-match-outside-mask:${a.id}`);
    for (let right = left + 1; right < ARM64_A64_CONTROL_ENCODING_FAMILIES.length; right++) {
      const b = ARM64_A64_CONTROL_ENCODING_FAMILIES[right];
      if ((((a.match ^ b.match) & (a.mask & b.mask)) >>> 0) === 0) {
        throw new Error(`arm64-control-denominator-family-overlap:${a.id}:${b.id}`);
      }
    }
  }
  let encodingCaseCount = 0;
  const observed = new Set();
  for (const item of arm64A64ControlEncodingCases()) {
    const family = classifyArm64A64ControlEncoding(item.word);
    if (!family) throw new Error(`arm64-control-denominator-case-unowned:${item.id}`);
    observed.add(family.id);
    encodingCaseCount++;
  }
  if (observed.size !== ARM64_A64_CONTROL_ENCODING_FAMILIES.length) throw new Error('arm64-control-denominator-family-unobserved');
  return Object.freeze({
    valid:true,
    schemaVersion:ARM64_A64_CONTROL_DENOMINATOR_SCHEMA,
    denominatorId:ARM64_A64_CONTROL_DENOMINATOR_ID,
    profileId:'arm64:a64',
    encodingFamilyCount:ARM64_A64_CONTROL_ENCODING_FAMILIES.length,
    encodingCaseCount,
    conditionCount:CONDITIONS.length,
    registerCount:32,
    testedBitCount:64,
    oracleIds:Object.freeze(['arm-a-profile-a64-branch-encoding-tables', 'deployed-capstone-5-arm64', 'llvm-mc-18-aarch64-disassembler']),
  });
}
