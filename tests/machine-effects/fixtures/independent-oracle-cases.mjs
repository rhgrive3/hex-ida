function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const PRIMARY_INITIAL = {
  registers: {
    x0: '0x0000000000000000',
    x1: '0x7fffffffffffffff',
    x2: '0x0000000000000001',
  },
  flags: { N: 0, Z: 0, C: 0, V: 0 },
  vectors: { v0: '0x00112233445566778899aabbccddeeff' },
  memory: [],
};

const PRIMARY_EXPECTED = {
  registers: {
    x0: '0x8000000000000000',
    x1: '0x7fffffffffffffff',
    x2: '0x0000000000000001',
  },
  flags: { N: 1, Z: 0, C: 0, V: 1 },
  vectors: { v0: '0x00112233445566778899aabbccddeeff' },
  memory: [],
};

const PRIMARY_DEFINED = {
  registers: {
    x0: '0xffffffffffffffff',
    x1: '0xffffffffffffffff',
    x2: '0xffffffffffffffff',
  },
  flags: { N: 1, Z: 1, C: 1, V: 1 },
  vectors: { v0: '0xffffffffffffffffffffffffffffffff' },
  memory: [],
};

function source({ authorityId, reference, revision, executionSource }) {
  return {
    kind: 'isa-specification',
    authorityId,
    reference,
    revision,
    executionSource,
  };
}

function provenance({ authorityId, reference, revision, executionSource, toolchainIdentity }) {
  return {
    authorityId,
    authorityRole: 'independent-isa-reference',
    isaReference: reference,
    referenceRevision: revision,
    executionSource,
    sourceKind: 'isa-specification-plus-independent-reference-model',
    toolchainIdentity,
    independentFromProduction: true,
  };
}

function addCase({
  profileId,
  architecture,
  instructionBytes,
  mnemonic,
  destination,
  lhs,
  rhs,
  initialState,
  expectedState,
  definedMask,
  requiredFeatures,
  authorityId,
  reference,
  revision,
  executionSource,
  toolchainIdentity,
  setsFlags = true,
}) {
  return deepFreeze({
    schemaVersion: 'machine-effects-independent-oracle-case/v1',
    profileId,
    architecture,
    instructionBytes,
    mnemonic,
    operation: {
      kind: 'add-with-flags',
      destination,
      lhs,
      rhs,
      widthBits: 64,
      carryIn: 0,
      setsFlags,
    },
    initialState,
    expectedOutcome: { kind: 'normal' },
    expectedState,
    definedMask,
    undefinedMask: {
      registers: {},
      flags: { N: 0, Z: 0, C: 0, V: 0 },
      vectors: {},
      memory: [],
    },
    unobservedMask: {
      registers: {},
      flags: { N: 0, Z: 0, C: 0, V: 0 },
      vectors: {},
      memory: [],
    },
    requiredFeatures,
    expectedStateSource: source({ authorityId, reference, revision, executionSource }),
    generatorIdentity: 'hex-independent-reference-generator',
    generatorVersion: '1.0.0',
    oracleIdentity: 'hex-independent-machine-effects-oracle',
    oracleVersion: '1.0.0',
    provenance: provenance({ authorityId, reference, revision, executionSource, toolchainIdentity }),
  });
}

export const DETERMINISTIC_ADD_CASE = addCase({
  profileId: 'arm64:a64',
  architecture: 'arm64',
  instructionBytes: '200002ab',
  mnemonic: 'ADDS X0, X1, X2',
  destination: 'x0',
  lhs: 'x1',
  rhs: 'x2',
  initialState: PRIMARY_INITIAL,
  expectedState: PRIMARY_EXPECTED,
  definedMask: PRIMARY_DEFINED,
  requiredFeatures: ['a64'],
  authorityId: 'arm-armv8-a64-reference',
  reference: 'Arm Architecture Reference Manual for A-profile architecture, A64 ADD/subtract with flags',
  revision: 'DDI0487-2024-12',
  executionSource: 'independent-a64-reference-model',
  toolchainIdentity: 'llvm-mc-18.1.3-aarch64-a64',
});

export const INDEPENDENT_ORACLE_CASE_FIXTURES = deepFreeze([
  DETERMINISTIC_ADD_CASE,
  addCase({
    profileId: 'arm64e:a64+pac',
    architecture: 'arm64e',
    instructionBytes: '200002ab',
    mnemonic: 'ADDS X0, X1, X2',
    destination: 'x0',
    lhs: 'x1',
    rhs: 'x2',
    initialState: PRIMARY_INITIAL,
    expectedState: PRIMARY_EXPECTED,
    definedMask: PRIMARY_DEFINED,
    requiredFeatures: ['a64', 'pac'],
    authorityId: 'arm-armv8-a64-pac-reference',
    reference: 'Arm Architecture Reference Manual for A-profile architecture, A64 ADD/subtract with flags and PAC profile context',
    revision: 'DDI0487-2024-12',
    executionSource: 'independent-a64-reference-model',
    toolchainIdentity: 'llvm-mc-18.1.3-aarch64-a64-pac-profile',
  }),
  addCase({
    profileId: 'x86_64:long-64',
    architecture: 'x86_64',
    instructionBytes: '4801d8',
    mnemonic: 'ADD RAX, RBX',
    destination: 'rax',
    lhs: 'rax',
    rhs: 'rbx',
    initialState: {
      registers: { rax: '0x7fffffffffffffff', rbx: '0x0000000000000001' },
      flags: { N: 0, Z: 0, C: 0, V: 0 },
      vectors: {},
      memory: [],
    },
    expectedState: {
      registers: { rax: '0x8000000000000000', rbx: '0x0000000000000001' },
      flags: { N: 1, Z: 0, C: 0, V: 1 },
      vectors: {},
      memory: [],
    },
    definedMask: {
      registers: { rax: '0xffffffffffffffff', rbx: '0xffffffffffffffff' },
      flags: { N: 1, Z: 1, C: 1, V: 1 },
      vectors: {},
      memory: [],
    },
    requiredFeatures: ['long-64'],
    authorityId: 'intel-sdm-x86-64-reference',
    reference: 'Intel 64 and IA-32 Architectures Software Developers Manual, ADD flags',
    revision: '2025-01',
    executionSource: 'independent-x86-reference-model',
    toolchainIdentity: 'llvm-mc-18.1.3-x86-64-long-mode',
  }),
  addCase({
    profileId: 'riscv64:rv64imc',
    architecture: 'riscv64',
    instructionBytes: 'b3822000',
    mnemonic: 'ADD X5, X1, X2',
    destination: 'x5',
    lhs: 'x1',
    rhs: 'x2',
    initialState: {
      registers: {
        x1: '0x7fffffffffffffff',
        x2: '0x0000000000000001',
        x5: '0x0000000000000000',
      },
      flags: { N: 0, Z: 0, C: 0, V: 0 },
      vectors: {},
      memory: [],
    },
    expectedState: {
      registers: {
        x1: '0x7fffffffffffffff',
        x2: '0x0000000000000001',
        x5: '0x8000000000000000',
      },
      flags: { N: 0, Z: 0, C: 0, V: 0 },
      vectors: {},
      memory: [],
    },
    definedMask: {
      registers: {
        x1: '0xffffffffffffffff',
        x2: '0xffffffffffffffff',
        x5: '0xffffffffffffffff',
      },
      flags: { N: 0, Z: 0, C: 0, V: 0 },
      vectors: {},
      memory: [],
    },
    requiredFeatures: ['rv64imc'],
    authorityId: 'riscv-unprivileged-spec-reference',
    reference: 'The RISC-V Instruction Set Manual, Volume I, RV64I ADD',
    revision: '20240411',
    executionSource: 'independent-riscv-reference-model',
    toolchainIdentity: 'llvm-mc-18.1.3-riscv64-rv64imc',
    setsFlags: false,
  }),
]);

export function deterministicAddSubjectState(currentCase = DETERMINISTIC_ADD_CASE) {
  return {
    outcome: { kind: 'normal' },
    state: currentCase.expectedState,
    subjectIdentity: 'production-machine-effects-evaluator',
    subjectRole: 'production-machine-effects-subject',
  };
}
