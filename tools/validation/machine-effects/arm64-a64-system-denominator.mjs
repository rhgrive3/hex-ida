export const ARM64_A64_SYSTEM_DENOMINATOR_SCHEMA = 'arm64-a64-system-denominator/v1';
export const ARM64_A64_SYSTEM_DENOMINATOR_ID = 'arm64:a64:system-encoding-discriminators:v1';

export const ARM64_A64_SYSTEM_MNEMONIC_DENOMINATOR = Object.freeze([
  'nop','dmb','dsb','isb','yield','wfe','wfi','sev','sevl','clrex','bti',
  'svc','hvc','smc','brk','hlt','mrs','msr','dc','ic','tlbi','sys','eret','hint',
]);

const entry = (id, mask, match, mnemonic = null) => Object.freeze({
  id,
  mask:mask >>> 0,
  match:match >>> 0,
  ...(mnemonic ? { mnemonic } : {}),
});

// Fixed fields from the Arm A-profile A64 exception-generation and system
// instruction encoding tables.  Bits [20:5] of the two system rows are the
// complete op0/op1/CRn/CRm/op2 discriminator domain; Rt is kept outside the
// mask and swept at the alias-sensitive X0/XZR boundaries below.
export const ARM64_A64_SYSTEM_ENCODING_FAMILIES = Object.freeze([
  entry('exception-svc', 0xffe0001f, 0xd4000001, 'svc'),
  entry('exception-hvc', 0xffe0001f, 0xd4000002, 'hvc'),
  entry('exception-smc', 0xffe0001f, 0xd4000003, 'smc'),
  entry('exception-brk', 0xffe0001f, 0xd4200000, 'brk'),
  entry('exception-hlt', 0xffe0001f, 0xd4400000, 'hlt'),
  entry('system-write-or-operation', 0xffe00000, 0xd5000000),
  entry('system-read-or-operation', 0xffe00000, 0xd5200000),
  entry('exception-return', 0xffffffff, 0xd69f03e0, 'eret'),
]);

export const ARM64_A64_SYSTEM_SELECTOR_COUNT = 1 << 16;
export const ARM64_A64_SYSTEM_REGISTER_COUNT = 32;
const EXCEPTION_IMMEDIATES = Object.freeze([0, 1, 0x7fff, 0x8000, 0xffff]);
const SYSTEM_DIRECTIONS = Object.freeze([
  ['system-write-or-operation', 0xd5000000],
  ['system-read-or-operation', 0xd5200000],
]);
const REGISTER_PAYLOAD_FORMS = Object.freeze([
  ['msr-register', 0xd51bd040],
  ['mrs-register', 0xd53bd040],
  ['sys-register', 0xd5080000],
  ['dc-register', 0xd5087620],
  ['tlbi-register', 0xd5088100],
]);

function item(id, familyId, word) {
  return Object.freeze({ id, familyId, word:word >>> 0 });
}

export function classifyArm64A64SystemEncoding(word) {
  const value = Number(word) >>> 0;
  const matches = ARM64_A64_SYSTEM_ENCODING_FAMILIES.filter((family) => (
    ((value & family.mask) >>> 0) === family.match
  ));
  if (matches.length > 1) {
    throw new Error(`arm64-system-denominator-overlap:0x${value.toString(16)}:${matches.map(({ id }) => id).join(',')}`);
  }
  return matches[0] ?? null;
}

export function* arm64A64SystemEncodingCases() {
  for (const family of ARM64_A64_SYSTEM_ENCODING_FAMILIES.slice(0, 5)) {
    for (const immediate of EXCEPTION_IMMEDIATES) {
      yield item(`${family.id}:immediate:${immediate}`, family.id, (family.match | (immediate << 5)) >>> 0);
    }
  }

  // X0 and XZR are both required: Rt=31 selects architecturally meaningful
  // aliases (HINT, barriers, cache/TLB operations, PSTATE forms) that are not
  // visible with an ordinary register.  Every system selector is swept at both
  // boundaries, so no alias can disappear behind a representative opcode.
  for (const [familyId, base] of SYSTEM_DIRECTIONS) {
    for (let selector = 0; selector < ARM64_A64_SYSTEM_SELECTOR_COUNT; selector++) {
      for (const rt of [0, 31]) {
        yield item(`${familyId}:selector:${selector}:rt:${rt}`, familyId, (base | (selector << 5) | rt) >>> 0);
      }
    }
  }

  // Once the alias-sensitive boundary is bound, sweep every remaining Rt for
  // representative MRS/MSR/SYS/maintenance forms to prove physical register
  // identity and XZR discard/zero-source behavior.
  for (const [id, template] of REGISTER_PAYLOAD_FORMS) {
    const familyId = classifyArm64A64SystemEncoding(template).id;
    for (let register = 0; register < ARM64_A64_SYSTEM_REGISTER_COUNT; register++) {
      yield item(`${id}:register:${register}`, familyId, ((template & ~0x1f) | register) >>> 0);
    }
  }
  yield item('exception-return', 'exception-return', 0xd69f03e0);
}

let validatedDenominator = null;
export function validateArm64A64SystemDenominator() {
  if (validatedDenominator) return validatedDenominator;
  if (new Set(ARM64_A64_SYSTEM_MNEMONIC_DENOMINATOR).size !== ARM64_A64_SYSTEM_MNEMONIC_DENOMINATOR.length) {
    throw new Error('arm64-system-denominator-mnemonic-duplicate');
  }
  const ids = ARM64_A64_SYSTEM_ENCODING_FAMILIES.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('arm64-system-denominator-family-duplicate');
  for (let left = 0; left < ARM64_A64_SYSTEM_ENCODING_FAMILIES.length; left++) {
    const a = ARM64_A64_SYSTEM_ENCODING_FAMILIES[left];
    if (((a.match & a.mask) >>> 0) !== a.match) throw new Error(`arm64-system-denominator-match-outside-mask:${a.id}`);
    for (let right = left + 1; right < ARM64_A64_SYSTEM_ENCODING_FAMILIES.length; right++) {
      const b = ARM64_A64_SYSTEM_ENCODING_FAMILIES[right];
      if ((((a.match ^ b.match) & (a.mask & b.mask)) >>> 0) === 0) {
        throw new Error(`arm64-system-denominator-family-overlap:${a.id}:${b.id}`);
      }
    }
  }
  let encodingCaseCount = 0;
  const observed = new Set();
  for (const candidate of arm64A64SystemEncodingCases()) {
    const family = classifyArm64A64SystemEncoding(candidate.word);
    if (!family || family.id !== candidate.familyId) {
      throw new Error(`arm64-system-denominator-case-unowned:${candidate.id}:${family?.id || 'none'}`);
    }
    observed.add(family.id);
    encodingCaseCount++;
  }
  if (observed.size !== ARM64_A64_SYSTEM_ENCODING_FAMILIES.length) throw new Error('arm64-system-denominator-family-unobserved');
  validatedDenominator = Object.freeze({
    valid:true,
    schemaVersion:ARM64_A64_SYSTEM_DENOMINATOR_SCHEMA,
    denominatorId:ARM64_A64_SYSTEM_DENOMINATOR_ID,
    profileId:'arm64:a64',
    encodingFamilyCount:ARM64_A64_SYSTEM_ENCODING_FAMILIES.length,
    encodingCaseCount,
    mnemonicCount:ARM64_A64_SYSTEM_MNEMONIC_DENOMINATOR.length,
    selectorCount:ARM64_A64_SYSTEM_SELECTOR_COUNT,
    registerCount:ARM64_A64_SYSTEM_REGISTER_COUNT,
    oracleIds:Object.freeze([
      'arm-a-profile-a64-exception-and-system-encoding-tables',
      'deployed-capstone-5-arm64',
      'llvm-mc-18-aarch64-disassembler',
    ]),
  });
  return validatedDenominator;
}
