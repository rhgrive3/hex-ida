import {
  addWithFlags,
  unsignedN,
} from './independent-oracle.mjs';
import {
  BLOCKING_STATUSES,
  INDEPENDENT_ORACLE_IDENTITY,
  INDEPENDENT_ORACLE_VERSION,
  ORACLE_BUDGETS,
  PASS_STATUSES,
  PRODUCTION_SUBJECT_IDENTITY,
  RESULT_STATUSES,
  assertDistinctOracleIdentity,
  assertIndependentText,
  assertIndependentProvenance,
} from './oracle-policy.mjs';
import {
  canonicalStringify,
  createOracleResult,
  maskValue,
  normalizeDefinedMask,
  normalizeMachineState,
  normalizeOutcome,
  validateCorpusCase,
} from './oracle-schema.mjs';
import { validateCorpus } from './oracle-corpus.mjs';

const DEFAULT_PROVENANCE = Object.freeze({
  authorityId: 'hex-independent-reference-authority',
  authorityRole: 'independent-isa-reference',
  isaReference: 'versioned architecture reference semantics',
  referenceRevision: 'v1',
  executionSource: 'independent-reference-model',
  sourceKind: 'isa-specification-plus-independent-reference-model',
  toolchainIdentity: 'node-independent-reference-runtime',
  independentFromProduction: true,
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function boundedText(value, max = 4096) {
  return String(value ?? '').slice(0, max);
}

function diagnostic(code, detail = null) {
  return detail == null ? { code } : { code, detail: boundedText(detail) };
}

function checkCancelled(signal) {
  return Boolean(signal?.aborted);
}

function toHex(value, widthBits = 64) {
  return `0x${unsignedN(value, widthBits).toString(16).padStart(Math.ceil(widthBits / 4), '0')}`;
}

function cloneState(state) {
  return {
    registers: { ...state.registers },
    flags: { ...state.flags },
    vectors: { ...state.vectors },
    memory: state.memory.map((entry) => ({ ...entry })),
  };
}

function stateForOperation(caseValue) {
  const operation = caseValue.operation;
  const initial = normalizeMachineState(caseValue.initialState, 'oracle-initial-state');
  if (!(operation.lhs in initial.registers) || !(operation.rhs in initial.registers)) {
    throw new TypeError('oracle-input-register-missing');
  }
  const result = addWithFlags(
    BigInt(initial.registers[operation.lhs]),
    BigInt(initial.registers[operation.rhs]),
    operation.widthBits,
    BigInt(operation.carryIn),
  );
  const state = cloneState(initial);
  state.registers[operation.destination] = toHex(result.result, operation.widthBits);
  if (operation.setsFlags) state.flags = { N: result.N, Z: result.Z, C: result.C, V: result.V };
  return state;
}

export function createReferenceOracle({
  identity = INDEPENDENT_ORACLE_IDENTITY,
  version = INDEPENDENT_ORACLE_VERSION,
  source = 'offline-independent-reference-model',
  toolchainIdentity = 'node-independent-reference-runtime',
  provenance = DEFAULT_PROVENANCE,
} = {}) {
  const oracleIdentity = assertDistinctOracleIdentity(identity, 'oracle-adapter-identity');
  const oracleVersion = String(version);
  const oracleSource = String(source);
  const oracleToolchain = String(toolchainIdentity);
  const oracleProvenance = assertIndependentProvenance(provenance, { oracleIdentity, code: 'oracle-adapter-provenance' });
  return Object.freeze({
    identity: oracleIdentity,
    version: oracleVersion,
    source: oracleSource,
    toolchainIdentity: oracleToolchain,
    provenance: oracleProvenance,
    async evaluate(caseValue, { signal } = {}) {
      if (checkCancelled(signal)) return Object.freeze({ status: 'cancelled', reason: 'cancelled-before-reference-evaluation' });
      const state = stateForOperation(caseValue);
      if (checkCancelled(signal)) return Object.freeze({ status: 'cancelled', reason: 'cancelled-after-reference-evaluation' });
      return Object.freeze({ outcome: caseValue.expectedOutcome, state });
    },
  });
}

function compareMap(expected, observed, mask, section, mismatches, counts) {
  for (const [key, maskText] of Object.entries(mask)) {
    const maskNumber = section === 'flags' ? BigInt(maskText) : maskValue(maskText);
    if (maskNumber === 0n) continue;
    counts[section] += 1;
    const expectedValue = expected?.[key];
    const observedValue = observed?.[key];
    if (expectedValue == null || observedValue == null) {
      mismatches.push({
        observable: `${section}.${key}`,
        mask: maskText,
        reason: 'observable-missing',
      });
      continue;
    }
    const expectedNumber = section === 'flags' ? BigInt(expectedValue) : BigInt(expectedValue);
    const observedNumber = section === 'flags' ? BigInt(observedValue) : BigInt(observedValue);
    if ((expectedNumber ^ observedNumber) & maskNumber) {
      mismatches.push({
        observable: `${section}.${key}`,
        expected: expectedValue,
        observed: observedValue,
        mask: maskText,
        reason: 'defined-bit-mismatch',
      });
    }
  }
}

function compareMemory(expected, observed, mask, mismatches, counts) {
  const observedById = new Map((observed ?? []).map((entry) => [`${entry.address}/${entry.widthBits}`, entry]));
  for (const entry of mask) {
    const maskNumber = maskValue(entry.value);
    if (maskNumber === 0n) continue;
    counts.memory += 1;
    const id = `${entry.address}/${entry.widthBits}`;
    const expectedEntry = (expected ?? []).find((item) => `${item.address}/${item.widthBits}` === id);
    const observedEntry = observedById.get(id);
    if (!expectedEntry || !observedEntry || ((BigInt(expectedEntry.value) ^ BigInt(observedEntry.value)) & maskNumber)) {
      mismatches.push({
        observable: `memory.${id}`,
        expected: expectedEntry?.value,
        observed: observedEntry?.value,
        mask: entry.value,
        reason: !expectedEntry || !observedEntry ? 'observable-missing' : 'defined-bit-mismatch',
      });
    }
  }
}

export function compareMachineState({ expectedState, observedState, definedMask }) {
  const expected = normalizeMachineState(expectedState, 'compare-expected-state');
  const observed = normalizeMachineState(observedState, 'compare-observed-state');
  const mask = normalizeDefinedMask(definedMask, expected, 'compare-defined-mask');
  const mismatches = [];
  const counts = { registers: 0, flags: 0, vectors: 0, memory: 0, outcome: 0, total: 0 };
  compareMap(expected.registers, observed.registers, mask.registers, 'registers', mismatches, counts);
  compareMap(expected.flags, observed.flags, mask.flags, 'flags', mismatches, counts);
  compareMap(expected.vectors, observed.vectors, mask.vectors, 'vectors', mismatches, counts);
  compareMemory(expected.memory, observed.memory, mask.memory, mismatches, counts);
  counts.total = counts.registers + counts.flags + counts.vectors + counts.memory;
  return Object.freeze({
    exact: mismatches.length === 0,
    mismatches: Object.freeze(mismatches),
    comparisonCounts: Object.freeze(counts),
  });
}

function statusForOutcome(expected, observed) {
  if (expected.kind === observed.kind) return 'exact/equivalent';
  if (observed.kind === 'unsupported') return 'unsupported';
  if (observed.kind === 'unavailable') return 'unavailable';
  if (observed.kind === 'cancelled') return 'cancelled';
  if (observed.kind === 'resource-limited') return 'resource-limited';
  if (expected.kind === 'normal' && ['trap', 'fault', 'exception', 'unpredictable'].includes(observed.kind)) return 'stricter-conservative';
  return 'mismatch';
}

function safeResult({
  caseValue,
  status,
  oracleIdentity = INDEPENDENT_ORACLE_IDENTITY,
  oracleVersion = INDEPENDENT_ORACLE_VERSION,
  oracleSource = 'offline-independent-reference-model',
  toolchainIdentity = 'node-independent-reference-runtime',
  provenance = DEFAULT_PROVENANCE,
  observedOutcome = { kind: 'unavailable', code: status },
  observedState = null,
  definedMask = caseValue.definedMask,
  comparisonCounts = { registers: 0, flags: 0, vectors: 0, memory: 0, outcome: 0, total: 0 },
  mismatches = [],
  diagnostics = [],
}) {
  const normalizedStatus = RESULT_STATUSES.includes(status) ? status : 'malformed';
  const safeIdentity = (() => {
    try { return assertDistinctOracleIdentity(oracleIdentity, 'oracle-result-identity'); }
    catch { return INDEPENDENT_ORACLE_IDENTITY; }
  })();
  const safeProvenance = (() => {
    try { return assertIndependentProvenance(provenance, { oracleIdentity: safeIdentity, code: 'oracle-result-provenance' }); }
    catch { return DEFAULT_PROVENANCE; }
  })();
  return createOracleResult({
    schemaVersion: 'machine-effects-independent-oracle-result/v1',
    caseId: caseValue.caseId,
    caseIdentity: caseValue.caseId,
    profileId: caseValue.profileId,
    oracleIdentity: safeIdentity,
    oracleVersion: String(oracleVersion || INDEPENDENT_ORACLE_VERSION),
    oracleSource: String(oracleSource || 'offline-independent-reference-model'),
    toolchainIdentity: String(toolchainIdentity || 'node-independent-reference-runtime'),
    provenance: safeProvenance,
    status: normalizedStatus,
    expectedOutcome: caseValue.expectedOutcome,
    observedOutcome,
    observedState,
    definedMask,
    comparisonCounts,
    mismatches,
    diagnostics: diagnostics.slice(0, ORACLE_BUDGETS.maxDiagnostics),
    passContribution: PASS_STATUSES.includes(normalizedStatus) ? 1 : 0,
  }, caseValue);
}

function oracleEnvelopeValid(oracle, caseValue) {
  if (!oracle || typeof oracle !== 'object' || typeof oracle.evaluate !== 'function') return diagnostic('oracle-adapter-not-integrated');
  try {
    assertDistinctOracleIdentity(oracle.identity, 'oracle-adapter-identity');
    assertIndependentText(oracle.source, 'oracle-adapter-source');
    assertIndependentText(oracle.toolchainIdentity, 'oracle-adapter-toolchain-identity');
    assertIndependentProvenance(oracle.provenance, { oracleIdentity: oracle.identity, code: 'oracle-adapter-provenance' });
  } catch (error) {
    return diagnostic('oracle-adapter-provenance-invalid', error.message);
  }
  if (oracle.identity !== caseValue.oracleIdentity) return diagnostic('oracle-adapter-identity-mismatch');
  if (String(oracle.version) !== caseValue.oracleVersion) return diagnostic('oracle-adapter-version-mismatch');
  return null;
}

export async function runIndependentComparison({
  corpusCase,
  subject = null,
  oracle = null,
  signal = null,
  budgets = ORACLE_BUDGETS,
} = {}) {
  const caseValue = validateCorpusCase(corpusCase);
  const effectiveBudgets = { ...ORACLE_BUDGETS, ...(budgets ?? {}) };
  const startedAt = Date.now();
  if (!Number.isFinite(effectiveBudgets.timeoutMs) || effectiveBudgets.timeoutMs <= 0
    || !Number.isFinite(effectiveBudgets.maxInputBytes) || effectiveBudgets.maxInputBytes <= 0
    || !Number.isFinite(effectiveBudgets.maxOutputBytes) || effectiveBudgets.maxOutputBytes <= 0
    || !Number.isFinite(effectiveBudgets.maxMemoryBytes) || effectiveBudgets.maxMemoryBytes <= 0) {
    return safeResult({ caseValue, status: 'resource-limited', diagnostics: [diagnostic('timeout-budget-invalid')] });
  }
  if (Buffer.byteLength(canonicalStringify(caseValue), 'utf8') > effectiveBudgets.maxInputBytes) {
    return safeResult({ caseValue, status: 'resource-limited', diagnostics: [diagnostic('input-budget-exceeded')] });
  }
  if (checkCancelled(signal)) return safeResult({ caseValue, status: 'cancelled', diagnostics: [diagnostic('cancelled-before-run')] });
  const adapter = oracle ?? createReferenceOracle({
    identity: caseValue.oracleIdentity,
    version: caseValue.oracleVersion,
    toolchainIdentity: caseValue.provenance.toolchainIdentity,
    provenance: caseValue.provenance,
  });
  const adapterError = oracleEnvelopeValid(adapter, caseValue);
  if (adapterError) return safeResult({ caseValue, status: 'malformed', diagnostics: [adapterError] });
  if (typeof subject !== 'function') return safeResult({ caseValue, status: 'not-integrated', diagnostics: [diagnostic('production-subject-not-integrated')] });
  let oracleObservation;
  try {
    oracleObservation = await adapter.evaluate(caseValue, { signal, budgets: effectiveBudgets });
  } catch (error) {
    return safeResult({ caseValue, status: 'unavailable', diagnostics: [diagnostic('oracle-evaluation-error', error.message)] });
  }
  if (oracleObservation?.status === 'cancelled') return safeResult({
    caseValue,
    status: 'cancelled',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('oracle-cancelled', oracleObservation.reason)],
  });
  if (Date.now() - startedAt > effectiveBudgets.timeoutMs) return safeResult({
    caseValue,
    status: 'resource-limited',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('time-budget-exceeded')],
  });
  if (!oracleObservation?.state || !oracleObservation?.outcome) return safeResult({
    caseValue,
    status: 'partial',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('oracle-partial-observation')],
  });
  let oracleState;
  try { oracleState = normalizeMachineState(oracleObservation.state, 'oracle-observed-state'); }
  catch (error) {
    return safeResult({
      caseValue,
      status: 'malformed',
      oracleIdentity: adapter.identity,
      oracleVersion: adapter.version,
      oracleSource: adapter.source,
      toolchainIdentity: adapter.toolchainIdentity,
      provenance: adapter.provenance,
      diagnostics: [diagnostic('oracle-state-malformed', error.message)],
    });
  }
  if (Buffer.byteLength(canonicalStringify(oracleState), 'utf8') > effectiveBudgets.maxMemoryBytes) return safeResult({
    caseValue,
    status: 'resource-limited',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('memory-budget-exceeded')],
  });
  if (caseValue.expectedState == null) return safeResult({
    caseValue,
    status: 'partial',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('expected-state-missing')],
  });
  const expectedCheck = compareMachineState({
    expectedState: caseValue.expectedState,
    observedState: oracleState,
    definedMask: caseValue.definedMask,
  });
  if (!expectedCheck.exact || oracleObservation.outcome.kind !== caseValue.expectedOutcome.kind) return safeResult({
    caseValue,
    status: 'malformed',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    observedOutcome: oracleObservation.outcome,
    observedState: oracleState,
    comparisonCounts: expectedCheck.comparisonCounts,
    mismatches: expectedCheck.mismatches,
    diagnostics: [diagnostic('oracle-disagrees-with-independent-expected-artifact')],
  });
  if (checkCancelled(signal)) return safeResult({
    caseValue,
    status: 'cancelled',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('cancelled-before-subject-comparison')],
  });
  let subjectObservation;
  try { subjectObservation = await subject({ caseValue, oracleObservation, signal, budgets }); }
  catch (error) {
    return safeResult({
      caseValue,
      status: 'not-integrated',
      oracleIdentity: adapter.identity,
      oracleVersion: adapter.version,
      oracleSource: adapter.source,
      toolchainIdentity: adapter.toolchainIdentity,
      provenance: adapter.provenance,
      diagnostics: [diagnostic('production-subject-error', error.message)],
    });
  }
  if (!subjectObservation || typeof subjectObservation !== 'object') return safeResult({
    caseValue,
    status: 'not-integrated',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('production-subject-observation-missing')],
  });
  if (Date.now() - startedAt > effectiveBudgets.timeoutMs) return safeResult({
    caseValue,
    status: 'resource-limited',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('time-budget-exceeded')],
  });
  if ('oracleIdentity' in subjectObservation || 'oracleVersion' in subjectObservation) return safeResult({
    caseValue,
    status: 'malformed',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('production-subject-cannot-provide-oracle-identity')],
  });
  if (subjectObservation.subjectRole !== 'production-machine-effects-subject'
    || typeof subjectObservation.subjectIdentity !== 'string'
    || subjectObservation.subjectIdentity.trim() === ''
    || subjectObservation.subjectIdentity === adapter.identity) return safeResult({
    caseValue,
    status: 'malformed',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('production-subject-identity-invalid')],
  });
  if (/(?:expected[-_ ]?table|self[-_ ]?oracle|production-derived)/i.test(canonicalStringify(subjectObservation))) return safeResult({
    caseValue,
    status: 'malformed',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('production-subject-derived-evidence-forbidden')],
  });
  let observedOutcome;
  try { observedOutcome = normalizeOutcome(subjectObservation.outcome, 'production-subject-outcome'); }
  catch (error) {
    return safeResult({
      caseValue,
      status: 'malformed',
      oracleIdentity: adapter.identity,
      oracleVersion: adapter.version,
      oracleSource: adapter.source,
      toolchainIdentity: adapter.toolchainIdentity,
      provenance: adapter.provenance,
      diagnostics: [diagnostic('production-subject-outcome-malformed', error.message)],
    });
  }
  const observedState = subjectObservation.state;
  if (!observedOutcome || !observedState) return safeResult({
    caseValue,
    status: 'partial',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('production-subject-partial-observation')],
  });
  let comparison;
  try {
    comparison = compareMachineState({ expectedState: oracleState, observedState, definedMask: caseValue.definedMask });
  } catch (error) {
    return safeResult({
      caseValue,
      status: 'malformed',
      oracleIdentity: adapter.identity,
      oracleVersion: adapter.version,
      oracleSource: adapter.source,
      toolchainIdentity: adapter.toolchainIdentity,
      provenance: adapter.provenance,
      observedOutcome,
      observedState: null,
      diagnostics: [diagnostic('production-subject-state-malformed', error.message)],
    });
  }
  if (Buffer.byteLength(canonicalStringify(subjectObservation), 'utf8') > effectiveBudgets.maxOutputBytes) return safeResult({
    caseValue,
    status: 'resource-limited',
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    diagnostics: [diagnostic('output-budget-exceeded')],
  });
  const comparisonCounts = {
    ...comparison.comparisonCounts,
    outcome: 1,
    total: comparison.comparisonCounts.total + 1,
  };
  const outcomeStatus = statusForOutcome(caseValue.expectedOutcome, observedOutcome);
  const status = outcomeStatus === 'exact/equivalent' && comparison.exact
    ? 'exact/equivalent'
    : outcomeStatus === 'exact/equivalent'
      ? 'mismatch'
      : outcomeStatus;
  return safeResult({
    caseValue,
    status,
    oracleIdentity: adapter.identity,
    oracleVersion: adapter.version,
    oracleSource: adapter.source,
    toolchainIdentity: adapter.toolchainIdentity,
    provenance: adapter.provenance,
    observedOutcome,
    observedState,
    comparisonCounts,
    mismatches: comparison.mismatches,
    diagnostics: status === 'exact/equivalent' ? [] : [diagnostic(`comparison-${status}`)],
  });
}

export const runOracleCase = runIndependentComparison;

export async function runCorpus(corpus, options = {}) {
  const normalizedCorpus = validateCorpus(corpus);
  const budgets = { ...ORACLE_BUDGETS, ...(options.budgets ?? {}) };
  if (normalizedCorpus.cases.length > budgets.maxCases) {
    return Object.freeze({
      corpusId: normalizedCorpus.corpusId,
      results: Object.freeze([]),
      counts: Object.freeze({ total: normalizedCorpus.cases.length, pass: 0, blocking: 0, gaps: 0 }),
      status: 'resource-limited',
      diagnostics: Object.freeze([diagnostic('case-count-budget-exceeded')]),
    });
  }
  const results = [];
  for (const caseValue of normalizedCorpus.cases) {
    if (checkCancelled(options.signal)) {
      results.push(await runIndependentComparison({ corpusCase: caseValue, ...options, budgets }));
      break;
    }
    results.push(await runIndependentComparison({ corpusCase: caseValue, ...options, budgets }));
  }
  const pass = results.filter((result) => PASS_STATUSES.includes(result.status)).length;
  const blocking = results.filter((result) => BLOCKING_STATUSES.includes(result.status)).length;
  const gaps = results.filter((result) => ['unsupported', 'unavailable'].includes(result.status)).length;
  return Object.freeze({
    corpusId: normalizedCorpus.corpusId,
    results: Object.freeze(results),
    counts: Object.freeze({ total: results.length, pass, blocking, gaps }),
    status: blocking > 0 ? 'mismatch' : results.length < normalizedCorpus.cases.length ? 'cancelled' : 'exact/equivalent',
    diagnostics: Object.freeze([]),
  });
}

export function productionSubjectObservation({ state, outcome = { kind: 'normal' }, subjectIdentity = PRODUCTION_SUBJECT_IDENTITY } = {}) {
  if (!state) throw new TypeError('production-subject-state-required');
  return Object.freeze({
    subjectIdentity: String(subjectIdentity),
    subjectRole: 'production-machine-effects-subject',
    outcome,
    state,
  });
}
