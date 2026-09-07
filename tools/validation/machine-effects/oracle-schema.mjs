import crypto from 'node:crypto';

import {
  CASE_SCHEMA_VERSION,
  INDEPENDENT_GENERATOR_IDENTITY,
  INDEPENDENT_GENERATOR_VERSION,
  INDEPENDENT_ORACLE_IDENTITY,
  INDEPENDENT_ORACLE_VERSION,
  ORACLE_BUDGETS,
  ORACLE_PROFILE_INVENTORY,
  PASS_STATUSES,
  RESULT_SCHEMA_VERSION,
  RESULT_STATUSES,
  assertDistinctOracleIdentity,
  assertIndependentText,
  assertIndependentProvenance,
  assertNonEmptyString,
} from './oracle-policy.mjs';

export const MACHINE_STATE_KEYS = Object.freeze(['registers', 'flags', 'vectors', 'memory']);
export const OUTCOME_KINDS = Object.freeze([
  'normal',
  'trap',
  'fault',
  'exception',
  'unpredictable',
  'unsupported',
  'unavailable',
  'cancelled',
  'resource-limited',
]);

const CASE_KEYS = new Set([
  'schemaVersion',
  'caseId',
  'profileId',
  'architecture',
  'instructionBytes',
  'mnemonic',
  'operation',
  'initialState',
  'expectedOutcome',
  'expectedState',
  'definedMask',
  'undefinedMask',
  'unobservedMask',
  'requiredFeatures',
  'expectedStateSource',
  'generatorIdentity',
  'generatorVersion',
  'oracleIdentity',
  'oracleVersion',
  'provenance',
]);

const SOURCE_KEYS = new Set(['kind', 'authorityId', 'reference', 'revision', 'executionSource']);
const PROVENANCE_KEYS = new Set([
  'authorityId',
  'authorityRole',
  'isaReference',
  'referenceRevision',
  'executionSource',
  'sourceKind',
  'toolchainIdentity',
  'independentFromProduction',
]);
const OPERATION_KEYS = new Set([
  'kind',
  'destination',
  'lhs',
  'rhs',
  'widthBits',
  'carryIn',
  'setsFlags',
]);
const STATE_KEYS = new Set(MACHINE_STATE_KEYS);
const MEMORY_KEYS = new Set(['address', 'value', 'widthBits']);

function fail(code, detail = null) {
  throw new TypeError(detail == null ? code : `${code}:${detail}`);
}

function plainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function assertAllowedKeys(value, allowed, code) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, key);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalValue(value) {
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical-value-nonfinite-number');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail('canonical-value-undefined', key);
      out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  fail('canonical-value-unsupported-type', typeof value);
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Digest(value) {
  const bytes = typeof value === 'string' ? value : canonicalStringify(value);
  return `sha256:${crypto.createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

function assertDigest(value, code) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) fail(code);
  return value;
}

function normalizeHex(value, widthBits, code) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) fail(code);
  let number;
  try { number = BigInt(value); } catch { fail(code); }
  if (number < 0n || number >= (1n << BigInt(widthBits))) fail(code);
  return `0x${number.toString(16).padStart(Math.ceil(widthBits / 4), '0')}`;
}

function hexNumber(value, code) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) fail(code);
  try { return BigInt(value); } catch { fail(code); }
}

function normalizeRegisterMap(value, code) {
  plainObject(value, code);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(key)) fail(`${code}-key`, key);
    out[key] = normalizeHex(value[key], 64, `${code}-value`);
  }
  return out;
}

function normalizeFlagMap(value, code) {
  plainObject(value, code);
  const expected = ['N', 'Z', 'C', 'V'];
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail(`${code}-keys`);
  const out = {};
  for (const key of expected) {
    if (!Number.isInteger(value[key]) || (value[key] !== 0 && value[key] !== 1)) fail(`${code}-value`, key);
    out[key] = value[key];
  }
  return out;
}

function normalizeVectorMap(value, code) {
  plainObject(value, code);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (!/^[vV][0-9]+$/.test(key)) fail(`${code}-key`, key);
    out[key.toLowerCase()] = normalizeHex(value[key], 128, `${code}-value`);
  }
  return out;
}

function normalizeMemory(value, code, { mask = false } = {}) {
  if (!Array.isArray(value)) fail(code);
  const out = value.map((entry) => {
    plainObject(entry, `${code}-entry`);
    assertAllowedKeys(entry, MEMORY_KEYS, `${code}-unknown-field`);
    if (!Number.isInteger(entry.widthBits) || ![8, 16, 32, 64, 128].includes(entry.widthBits)) fail(`${code}-width`);
    return {
      address: normalizeHex(entry.address, 64, `${code}-address`),
      value: normalizeHex(entry.value, entry.widthBits, `${code}-${mask ? 'mask' : 'value'}`),
      widthBits: entry.widthBits,
    };
  });
  out.sort((a, b) => a.address.localeCompare(b.address) || a.widthBits - b.widthBits);
  const seen = new Set();
  for (const entry of out) {
    const id = `${entry.address}/${entry.widthBits}`;
    if (seen.has(id)) fail(`${code}-duplicate`, id);
    seen.add(id);
  }
  return out;
}

export function normalizeMachineState(value, code = 'machine-state-invalid') {
  plainObject(value, code);
  assertAllowedKeys(value, STATE_KEYS, `${code}-unknown-field`);
  for (const key of MACHINE_STATE_KEYS) if (!(key in value)) fail(`${code}-missing-field`, key);
  return {
    registers: normalizeRegisterMap(value.registers, `${code}-registers`),
    flags: normalizeFlagMap(value.flags, `${code}-flags`),
    vectors: normalizeVectorMap(value.vectors, `${code}-vectors`),
    memory: normalizeMemory(value.memory, `${code}-memory`),
  };
}

function zeroLikeMask(state) {
  return {
    registers: Object.fromEntries(Object.keys(state.registers).map((key) => [key, `0x${'0'.repeat(16)}`])),
    flags: { N: 0, Z: 0, C: 0, V: 0 },
    vectors: Object.fromEntries(Object.keys(state.vectors).map((key) => [key, `0x${'0'.repeat(32)}`])),
    memory: state.memory.map((entry) => ({ address: entry.address, value: `0x${'0'.repeat(entry.widthBits / 4)}`, widthBits: entry.widthBits })),
  };
}

export function normalizeDefinedMask(value, state, code = 'defined-mask-invalid') {
  plainObject(value, code);
  assertAllowedKeys(value, STATE_KEYS, `${code}-unknown-field`);
  for (const key of MACHINE_STATE_KEYS) if (!(key in value)) fail(`${code}-missing-field`, key);
  const registers = normalizeRegisterMap(value.registers, `${code}-registers`);
  const vectors = normalizeVectorMap(value.vectors, `${code}-vectors`);
  for (const key of Object.keys(registers)) if (!(key in state.registers)) fail(`${code}-register-unknown`, key);
  for (const key of Object.keys(vectors)) if (!(key in state.vectors)) fail(`${code}-vector-unknown`, key);
  const flags = normalizeFlagMap(value.flags, `${code}-flags`);
  const memory = normalizeMemory(value.memory, `${code}-memory`, { mask: true });
  const stateMemory = new Set(state.memory.map((entry) => `${entry.address}/${entry.widthBits}`));
  for (const entry of memory) if (!stateMemory.has(`${entry.address}/${entry.widthBits}`)) fail(`${code}-memory-unknown`, entry.address);
  return { registers, flags, vectors, memory };
}

function maskOverlap(a, b) {
  return (hexNumber(a) & hexNumber(b)) !== 0n;
}

export function assertDisjointMasks(definedMask, excludedMask, code = 'defined-mask-overlap') {
  for (const key of Object.keys(definedMask.registers)) {
    if (excludedMask.registers[key] && maskOverlap(definedMask.registers[key], excludedMask.registers[key])) fail(code, `register:${key}`);
  }
  for (const key of ['N', 'Z', 'C', 'V']) {
    if (definedMask.flags[key] && excludedMask.flags[key]) fail(code, `flag:${key}`);
  }
  for (const key of Object.keys(definedMask.vectors)) {
    if (excludedMask.vectors[key] && maskOverlap(definedMask.vectors[key], excludedMask.vectors[key])) fail(code, `vector:${key}`);
  }
  const excludedMemory = new Set(excludedMask.memory.map((entry) => `${entry.address}/${entry.widthBits}`));
  for (const entry of definedMask.memory) if (excludedMemory.has(`${entry.address}/${entry.widthBits}`)) fail(code, `memory:${entry.address}`);
  return true;
}

export function normalizeOutcome(value, code = 'outcome-invalid') {
  plainObject(value, code);
  const allowed = new Set(['kind', 'code', 'detail']);
  assertAllowedKeys(value, allowed, `${code}-unknown-field`);
  if (!OUTCOME_KINDS.includes(value.kind)) fail(`${code}-kind`);
  if (value.code != null) assertNonEmptyString(value.code, `${code}-code`);
  if (value.detail != null) assertNonEmptyString(value.detail, `${code}-detail`);
  return {
    kind: value.kind,
    ...(value.code == null ? {} : { code: value.code }),
    ...(value.detail == null ? {} : { detail: value.detail }),
  };
}

function normalizeOperation(value, code = 'operation-invalid') {
  plainObject(value, code);
  assertAllowedKeys(value, OPERATION_KEYS, `${code}-unknown-field`);
  if (value.kind !== 'add-with-flags') fail(`${code}-kind`);
  for (const key of ['destination', 'lhs', 'rhs']) assertNonEmptyString(value[key], `${code}-${key}`);
  if (!Number.isInteger(value.widthBits) || ![8, 16, 32, 64].includes(value.widthBits)) fail(`${code}-width`);
  if (!Number.isInteger(value.carryIn) || (value.carryIn !== 0 && value.carryIn !== 1)) fail(`${code}-carry`);
  if (typeof value.setsFlags !== 'boolean') fail(`${code}-sets-flags`);
  return {
    kind: value.kind,
    destination: value.destination,
    lhs: value.lhs,
    rhs: value.rhs,
    widthBits: value.widthBits,
    carryIn: value.carryIn,
    setsFlags: value.setsFlags,
  };
}

function normalizeSource(value, code = 'expected-state-source-invalid') {
  plainObject(value, code);
  assertAllowedKeys(value, SOURCE_KEYS, `${code}-unknown-field`);
  if (value.kind !== 'isa-specification') fail(`${code}-kind`);
  for (const key of ['authorityId', 'reference', 'revision', 'executionSource']) assertNonEmptyString(value[key], `${code}-${key}`);
  if (/(?:production|expected[-_ ]?table|js\/semantics\/effects|self[-_ ]?oracle)/i.test(`${value.authorityId} ${value.reference} ${value.executionSource}`)) fail(`${code}-production-derived`);
  return {
    kind: value.kind,
    authorityId: value.authorityId,
    reference: value.reference,
    revision: value.revision,
    executionSource: value.executionSource,
  };
}

function normalizeProvenance(value, oracleIdentity, code = 'provenance-invalid') {
  plainObject(value, code);
  assertAllowedKeys(value, PROVENANCE_KEYS, `${code}-unknown-field`);
  for (const key of PROVENANCE_KEYS) if (!(key in value)) fail(`${code}-missing-field`, key);
  const normalized = assertIndependentProvenance(value, { oracleIdentity, code });
  return normalized;
}

function normalizeFeatures(value, code) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) fail(code);
  const out = [...new Set(value.map((item) => item.trim()))].sort();
  if (out.length !== value.length) fail(`${code}-duplicate`);
  return out;
}

function normalizeInstructionBytes(value, code) {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0 || value.length > 256) fail(code);
  return value.toLowerCase();
}

function normalizeCaseInput(input) {
  plainObject(input, 'corpus-case-invalid');
  assertAllowedKeys(input, CASE_KEYS, 'corpus-case-unknown-field');
  for (const key of [
    'schemaVersion', 'profileId', 'architecture', 'instructionBytes', 'mnemonic', 'operation',
    'initialState', 'expectedOutcome', 'expectedState', 'definedMask', 'undefinedMask',
    'unobservedMask', 'requiredFeatures', 'expectedStateSource', 'generatorIdentity',
    'generatorVersion', 'oracleIdentity', 'oracleVersion', 'provenance',
  ]) if (!(key in input)) fail('corpus-case-missing-field', key);
  if (input.schemaVersion !== CASE_SCHEMA_VERSION) fail('corpus-case-schema-version');
  const profileId = assertNonEmptyString(input.profileId, 'corpus-case-profile-required');
  const architecture = assertNonEmptyString(input.architecture, 'corpus-case-architecture-required');
  const profile = ORACLE_PROFILE_INVENTORY.find((entry) => entry.profileId === profileId);
  if (!profile) fail('corpus-case-profile-unknown', profileId);
  if (profile.architecture !== architecture) fail('corpus-case-profile-architecture-mismatch', profileId);
  const mnemonic = assertNonEmptyString(input.mnemonic, 'corpus-case-mnemonic-required');
  const instructionBytes = normalizeInstructionBytes(input.instructionBytes, 'corpus-case-instruction-bytes');
  const operation = normalizeOperation(input.operation);
  const initialState = normalizeMachineState(input.initialState, 'corpus-case-initial-state');
  for (const key of [operation.lhs, operation.rhs, operation.destination]) {
    if (!(key in initialState.registers)) fail('corpus-case-state-register-missing', key);
  }
  const expectedOutcome = normalizeOutcome(input.expectedOutcome, 'corpus-case-expected-outcome');
  const expectedState = input.expectedState == null
    ? null
    : normalizeMachineState(input.expectedState, 'corpus-case-expected-state');
  if (expectedOutcome.kind === 'normal' && expectedState == null) fail('corpus-case-normal-state-required');
  if (expectedState != null && !(operation.destination in expectedState.registers)) fail('corpus-case-expected-register-missing', operation.destination);
  const maskBasis = expectedState ?? initialState;
  const definedMask = normalizeDefinedMask(input.definedMask, maskBasis, 'corpus-case-defined-mask');
  const undefinedMask = normalizeDefinedMask(input.undefinedMask, maskBasis, 'corpus-case-undefined-mask');
  const unobservedMask = normalizeDefinedMask(input.unobservedMask, maskBasis, 'corpus-case-unobserved-mask');
  assertDisjointMasks(definedMask, undefinedMask, 'corpus-case-undefined-bit-marked-defined');
  assertDisjointMasks(definedMask, unobservedMask, 'corpus-case-unobserved-bit-marked-defined');
  const expectedStateSource = normalizeSource(input.expectedStateSource);
  if (expectedStateSource.authorityId !== profile.authorityId) fail('corpus-case-profile-authority-mismatch');
  const oracleIdentity = assertDistinctOracleIdentity(input.oracleIdentity, 'corpus-case-oracle-identity');
  const oracleVersion = assertNonEmptyString(input.oracleVersion, 'corpus-case-oracle-version');
  const generatorIdentity = assertDistinctOracleIdentity(input.generatorIdentity, 'corpus-case-generator-identity');
  const generatorVersion = assertNonEmptyString(input.generatorVersion, 'corpus-case-generator-version');
  const provenance = normalizeProvenance(input.provenance, oracleIdentity, 'corpus-case-provenance');
  if (provenance.authorityId !== expectedStateSource.authorityId) fail('corpus-case-provenance-authority-mismatch');
  if (provenance.isaReference !== expectedStateSource.reference) fail('corpus-case-provenance-reference-mismatch');
  if (provenance.referenceRevision !== expectedStateSource.revision) fail('corpus-case-provenance-revision-mismatch');
  return {
    schemaVersion: CASE_SCHEMA_VERSION,
    profileId,
    architecture,
    instructionBytes,
    mnemonic,
    operation,
    initialState,
    expectedOutcome,
    expectedState,
    definedMask,
    undefinedMask,
    unobservedMask,
    requiredFeatures: normalizeFeatures(input.requiredFeatures, 'corpus-case-features'),
    expectedStateSource,
    generatorIdentity,
    generatorVersion,
    oracleIdentity,
    oracleVersion,
    provenance,
  };
}

export function createCorpusCase(input) {
  const normalized = normalizeCaseInput(input);
  const suppliedCaseId = input.caseId;
  if (suppliedCaseId != null) assertDigest(suppliedCaseId, 'corpus-case-id-invalid');
  const caseId = sha256Digest(normalized);
  if (suppliedCaseId != null && suppliedCaseId !== caseId) fail('corpus-case-stale-identity');
  return deepFreeze({ ...normalized, caseId });
}

export function validateCorpusCase(input) {
  return createCorpusCase(input);
}

const RESULT_KEYS = new Set([
  'schemaVersion', 'resultId', 'caseId', 'caseIdentity', 'profileId', 'oracleIdentity', 'oracleVersion',
  'oracleSource', 'toolchainIdentity', 'provenance', 'status', 'expectedOutcome', 'observedOutcome',
  'observedState', 'definedMask', 'comparisonCounts', 'mismatches', 'diagnostics', 'passContribution',
]);

function normalizeComparisonCounts(value, code = 'comparison-counts-invalid') {
  plainObject(value, code);
  const keys = ['registers', 'flags', 'vectors', 'memory', 'outcome', 'total'];
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(`${code}-keys`);
  const out = {};
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail(`${code}-value`, key);
    out[key] = value[key];
  }
  if (out.total !== out.registers + out.flags + out.vectors + out.memory + out.outcome) fail(`${code}-total`);
  return out;
}

function normalizeMismatch(value, code = 'mismatch-invalid') {
  plainObject(value, code);
  const allowed = new Set(['observable', 'expected', 'observed', 'mask', 'reason']);
  assertAllowedKeys(value, allowed, `${code}-unknown-field`);
  assertNonEmptyString(value.observable, `${code}-observable`);
  if (value.reason != null) assertNonEmptyString(value.reason, `${code}-reason`);
  return {
    observable: value.observable,
    ...(value.expected == null ? {} : { expected: value.expected }),
    ...(value.observed == null ? {} : { observed: value.observed }),
    ...(value.mask == null ? {} : { mask: value.mask }),
    ...(value.reason == null ? {} : { reason: value.reason }),
  };
}

function normalizeDiagnostics(value, code = 'diagnostics-invalid') {
  if (!Array.isArray(value)) fail(code);
  if (value.length > ORACLE_BUDGETS.maxDiagnostics) fail(`${code}-count`);
  return value.map((entry) => {
    plainObject(entry, `${code}-entry`);
    const allowed = new Set(['code', 'detail']);
    assertAllowedKeys(entry, allowed, `${code}-unknown-field`);
    return {
      code: assertNonEmptyString(entry.code, `${code}-code`),
      ...(entry.detail == null ? {} : { detail: String(entry.detail).slice(0, ORACLE_BUDGETS.maxDiagnosticBytes) }),
    };
  });
}

function normalizeResultInput(input, caseValue = null) {
  plainObject(input, 'oracle-result-invalid');
  assertAllowedKeys(input, RESULT_KEYS, 'oracle-result-unknown-field');
  for (const key of [
    'schemaVersion', 'caseId', 'caseIdentity', 'profileId', 'oracleIdentity', 'oracleVersion',
    'oracleSource', 'toolchainIdentity', 'provenance', 'status', 'expectedOutcome', 'observedOutcome',
    'observedState', 'definedMask', 'comparisonCounts', 'mismatches', 'diagnostics', 'passContribution',
  ]) if (!(key in input)) fail('oracle-result-missing-field', key);
  if (input.schemaVersion !== RESULT_SCHEMA_VERSION) fail('oracle-result-schema-version');
  const caseId = assertDigest(input.caseId, 'oracle-result-case-id-invalid');
  const caseIdentity = assertDigest(input.caseIdentity, 'oracle-result-case-identity-invalid');
  if (caseId !== caseIdentity) fail('oracle-result-case-identity-mismatch');
  if (caseValue && caseId !== caseValue.caseId) fail('oracle-result-stale-case');
  const profileId = assertNonEmptyString(input.profileId, 'oracle-result-profile-required');
  if (caseValue && profileId !== caseValue.profileId) fail('oracle-result-profile-mismatch');
  const oracleIdentity = assertDistinctOracleIdentity(input.oracleIdentity, 'oracle-result-oracle-identity');
  const oracleVersion = assertNonEmptyString(input.oracleVersion, 'oracle-result-oracle-version');
  if (caseValue && oracleIdentity !== caseValue.oracleIdentity) fail('oracle-result-oracle-identity-mismatch');
  if (caseValue && oracleVersion !== caseValue.oracleVersion) fail('oracle-result-oracle-version-mismatch');
  const oracleSource = assertIndependentText(input.oracleSource, 'oracle-result-oracle-source');
  const toolchainIdentity = assertIndependentText(input.toolchainIdentity, 'oracle-result-toolchain-identity');
  const provenance = normalizeProvenance(input.provenance, oracleIdentity, 'oracle-result-provenance');
  if (!RESULT_STATUSES.includes(input.status)) fail('oracle-result-status');
  const expectedOutcome = normalizeOutcome(input.expectedOutcome, 'oracle-result-expected-outcome');
  if (caseValue && canonicalStringify(expectedOutcome) !== canonicalStringify(caseValue.expectedOutcome)) fail('oracle-result-expected-outcome-mismatch');
  const observedOutcome = normalizeOutcome(input.observedOutcome, 'oracle-result-observed-outcome');
  const observedState = input.observedState == null ? null : normalizeMachineState(input.observedState, 'oracle-result-observed-state');
  const maskBasis = observedState ?? caseValue?.expectedState ?? caseValue?.initialState;
  if (!maskBasis) fail('oracle-result-mask-basis-required');
  const definedMask = normalizeDefinedMask(input.definedMask, maskBasis, 'oracle-result-defined-mask');
  if (caseValue && canonicalStringify(definedMask) !== canonicalStringify(caseValue.definedMask)) fail('oracle-result-defined-mask-mismatch');
  const comparisonCounts = normalizeComparisonCounts(input.comparisonCounts);
  if (!Array.isArray(input.mismatches)) fail('oracle-result-mismatches-invalid');
  const mismatches = input.mismatches.map((entry) => normalizeMismatch(entry));
  const diagnostics = normalizeDiagnostics(input.diagnostics);
  if (!Number.isInteger(input.passContribution) || ![0, 1].includes(input.passContribution)) fail('oracle-result-pass-contribution');
  if (PASS_STATUSES.includes(input.status)) {
    if (!observedState || input.passContribution !== 1 || comparisonCounts.total <= 0 || mismatches.length > 0) fail('oracle-result-pass-incomplete');
  } else if (input.passContribution !== 0) {
    fail('oracle-result-nonpass-contributes-pass');
  }
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    caseId,
    caseIdentity,
    profileId,
    oracleIdentity,
    oracleVersion,
    oracleSource,
    toolchainIdentity,
    provenance,
    status: input.status,
    expectedOutcome,
    observedOutcome,
    observedState,
    definedMask,
    comparisonCounts,
    mismatches,
    diagnostics,
    passContribution: input.passContribution,
  };
}

export function createOracleResult(input, caseValue = null) {
  const normalized = normalizeResultInput(input, caseValue);
  const suppliedResultId = input.resultId;
  if (suppliedResultId != null) assertDigest(suppliedResultId, 'oracle-result-id-invalid');
  const resultId = sha256Digest(normalized);
  if (suppliedResultId != null && suppliedResultId !== resultId) fail('oracle-result-stale-identity');
  return deepFreeze({ ...normalized, resultId });
}

export function validateOracleResult(input, caseValue = null) {
  return createOracleResult(input, caseValue);
}

export function emptyMaskForState(state) {
  return deepFreeze(zeroLikeMask(normalizeMachineState(state)));
}

export function maskValue(mask) {
  return hexNumber(mask, 'mask-value-invalid');
}
