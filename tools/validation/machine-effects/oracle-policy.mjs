export const ORACLE_SCHEMA_VERSION = 'machine-effects-independent-oracle/v1';
export const CASE_SCHEMA_VERSION = 'machine-effects-independent-oracle-case/v1';
export const RESULT_SCHEMA_VERSION = 'machine-effects-independent-oracle-result/v1';
export const REPORT_SCHEMA_VERSION = 'machine-effects-independent-oracle-report/v1';

export const INDEPENDENT_ORACLE_IDENTITY = 'hex-independent-machine-effects-oracle';
export const INDEPENDENT_ORACLE_VERSION = '1.0.0';
export const INDEPENDENT_GENERATOR_IDENTITY = 'hex-independent-reference-generator';
export const INDEPENDENT_GENERATOR_VERSION = '1.0.0';

export const PRODUCTION_SUBJECT_IDENTITY = 'production-machine-effects-evaluator';
export const PRODUCTION_ORACLE_IDENTITIES = Object.freeze([
  PRODUCTION_SUBJECT_IDENTITY,
  'production-machine-effects-expected-tables',
  'machine-effects-production-registry',
]);

export const PROFILE_IDS = Object.freeze([
  'arm64:a64',
  'arm64e:a64+pac',
  'x86_64:long-64',
  'riscv64:rv64imc',
]);

export const ORACLE_PROFILE_INVENTORY = Object.freeze([
  Object.freeze({
    profileId: 'arm64:a64',
    architecture: 'arm64',
    isa: 'A64',
    authorityId: 'arm-armv8-a64-reference',
    authorityRole: 'independent-isa-reference',
    reference: 'Arm Architecture Reference Manual for A-profile architecture',
    revision: 'DDI0487-2024-12',
    executionSource: 'independent-a64-reference-model',
    toolchainIdentity: 'llvm-mc-18.1.3-aarch64-a64',
    status: 'promoted',
  }),
  Object.freeze({
    profileId: 'arm64e:a64+pac',
    architecture: 'arm64e',
    isa: 'A64+PAC',
    authorityId: 'arm-armv8-a64-pac-reference',
    authorityRole: 'independent-isa-reference',
    reference: 'Arm Architecture Reference Manual for A-profile architecture, PAC profile context',
    revision: 'DDI0487-2024-12',
    executionSource: 'independent-a64-reference-model',
    toolchainIdentity: 'llvm-mc-18.1.3-aarch64-a64-pac-profile',
    status: 'promoted',
  }),
  Object.freeze({
    profileId: 'x86_64:long-64',
    architecture: 'x86_64',
    isa: 'long-64',
    authorityId: 'intel-sdm-x86-64-reference',
    authorityRole: 'independent-isa-reference',
    reference: 'Intel 64 and IA-32 Architectures Software Developers Manual',
    revision: '2025-01',
    executionSource: 'independent-x86-reference-model',
    toolchainIdentity: 'llvm-mc-18.1.3-x86-64-long-mode',
    status: 'promoted',
  }),
  Object.freeze({
    profileId: 'riscv64:rv64imc',
    architecture: 'riscv64',
    isa: 'RV64IMC',
    authorityId: 'riscv-unprivileged-spec-reference',
    authorityRole: 'independent-isa-reference',
    reference: 'The RISC-V Instruction Set Manual, Volume I',
    revision: '20240411',
    executionSource: 'independent-riscv-reference-model',
    toolchainIdentity: 'llvm-mc-18.1.3-riscv64-rv64imc',
    status: 'promoted',
  }),
]);

export const ORACLE_BUDGETS = Object.freeze({
  maxCases: 1024,
  maxInputBytes: 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxDiagnostics: 32,
  maxDiagnosticBytes: 4096,
  timeoutMs: 5000,
});

export const RESULT_STATUSES = Object.freeze([
  'exact/equivalent',
  'stricter-conservative',
  'mismatch',
  'unsupported',
  'unavailable',
  'not-integrated',
  'malformed',
  'partial',
  'cancelled',
  'resource-limited',
]);

export const PASS_STATUSES = Object.freeze(['exact/equivalent']);
export const NON_PASS_STATUSES = Object.freeze(RESULT_STATUSES.filter((status) => !PASS_STATUSES.includes(status)));
export const BLOCKING_STATUSES = Object.freeze([
  'stricter-conservative',
  'mismatch',
  'malformed',
  'partial',
  'not-integrated',
  'cancelled',
  'resource-limited',
]);

const FORBIDDEN_AUTHORITY_TEXT = /(?:production|expected[-_ ]?table|js\/semantics\/effects|machine-effects-evaluator|self[-_ ]?oracle)/i;

export function assertNonEmptyString(value, code) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(code);
  return value.trim();
}

export function assertIndependentText(value, code = 'independent-text-invalid') {
  const normalized = assertNonEmptyString(value, code);
  if (FORBIDDEN_AUTHORITY_TEXT.test(normalized)) throw new TypeError(`${code}:production-derived`);
  return normalized;
}

export function assertDistinctOracleIdentity(identity, code = 'oracle-identity-invalid') {
  const normalized = assertNonEmptyString(identity, code);
  if (PRODUCTION_ORACLE_IDENTITIES.includes(normalized) || FORBIDDEN_AUTHORITY_TEXT.test(normalized)) {
    throw new TypeError(`${code}:production-derived`);
  }
  return normalized;
}

export function assertIndependentProvenance(provenance, {
  oracleIdentity = null,
  code = 'oracle-provenance-invalid',
} = {}) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new TypeError(code);
  }
  const authorityId = assertNonEmptyString(provenance.authorityId, `${code}:authority-id-required`);
  const authorityRole = assertNonEmptyString(provenance.authorityRole, `${code}:authority-role-required`);
  const isaReference = assertNonEmptyString(provenance.isaReference, `${code}:isa-reference-required`);
  const referenceRevision = assertNonEmptyString(provenance.referenceRevision, `${code}:reference-revision-required`);
  const executionSource = assertNonEmptyString(provenance.executionSource, `${code}:execution-source-required`);
  const sourceKind = assertNonEmptyString(provenance.sourceKind, `${code}:source-kind-required`);
  const toolchainIdentity = assertIndependentText(provenance.toolchainIdentity, `${code}:toolchain-identity-required`);
  if (provenance.independentFromProduction !== true) throw new TypeError(`${code}:production-derived`);
  if (!authorityRole.startsWith('independent-')) throw new TypeError(`${code}:authority-role-not-independent`);
  if (FORBIDDEN_AUTHORITY_TEXT.test(`${authorityId} ${isaReference} ${executionSource} ${sourceKind} ${toolchainIdentity}`)) {
    throw new TypeError(`${code}:production-derived`);
  }
  if (oracleIdentity != null && authorityId === oracleIdentity) {
    throw new TypeError(`${code}:authority-and-oracle-identity-collide`);
  }
  return Object.freeze({
    authorityId,
    authorityRole,
    isaReference,
    referenceRevision,
    executionSource,
    sourceKind,
    toolchainIdentity,
    independentFromProduction: true,
  });
}

export function validateOraclePolicy() {
  if (new Set(PROFILE_IDS).size !== PROFILE_IDS.length) throw new TypeError('oracle-policy-duplicate-profile');
  if (ORACLE_PROFILE_INVENTORY.length !== PROFILE_IDS.length) throw new TypeError('oracle-policy-profile-count');
  for (const profile of ORACLE_PROFILE_INVENTORY) {
    if (!PROFILE_IDS.includes(profile.profileId)) throw new TypeError(`oracle-policy-unknown-profile:${profile.profileId}`);
    assertNonEmptyString(profile.architecture, 'oracle-policy-architecture-required');
    assertNonEmptyString(profile.isa, 'oracle-policy-isa-required');
    assertNonEmptyString(profile.authorityId, 'oracle-policy-authority-required');
    assertIndependentProvenance({
      authorityId: profile.authorityId,
      authorityRole: profile.authorityRole,
      isaReference: profile.reference,
      referenceRevision: profile.revision,
      executionSource: profile.executionSource,
      sourceKind: 'isa-specification-plus-independent-reference-model',
      toolchainIdentity: profile.toolchainIdentity,
      independentFromProduction: true,
    }, { oracleIdentity: INDEPENDENT_ORACLE_IDENTITY });
    if (profile.status !== 'promoted') throw new TypeError(`oracle-policy-profile-not-promoted:${profile.profileId}`);
  }
  if (ORACLE_BUDGETS.maxCases <= 0 || ORACLE_BUDGETS.timeoutMs <= 0) throw new TypeError('oracle-policy-budget-invalid');
  return Object.freeze({
    schemaVersion: ORACLE_SCHEMA_VERSION,
    oracleIdentity: INDEPENDENT_ORACLE_IDENTITY,
    oracleVersion: INDEPENDENT_ORACLE_VERSION,
    generatorIdentity: INDEPENDENT_GENERATOR_IDENTITY,
    generatorVersion: INDEPENDENT_GENERATOR_VERSION,
    profileIds: PROFILE_IDS,
    budgets: ORACLE_BUDGETS,
    networkAllowed: false,
    productionEvaluatorIsOracle: false,
  });
}

validateOraclePolicy();
