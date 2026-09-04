import assert from 'node:assert/strict';

import {
  createReferenceOracle,
  productionSubjectObservation,
  runCorpus,
  runIndependentComparison,
} from '../../tools/validation/machine-effects/oracle-runner.mjs';
import { createCorpus } from '../../tools/validation/machine-effects/oracle-corpus.mjs';
import {
  createCorpusCase,
  createOracleResult,
  validateCorpusCase,
} from '../../tools/validation/machine-effects/oracle-schema.mjs';
import { DETERMINISTIC_ADD_CASE, INDEPENDENT_ORACLE_CASE_FIXTURES } from './fixtures/independent-oracle-cases.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rawCase(mutator = null) {
  const value = clone(DETERMINISTIC_ADD_CASE);
  if (mutator) mutator(value);
  return value;
}

function expectRejected(mutator, pattern) {
  assert.throws(() => validateCorpusCase(rawCase(mutator)), pattern);
}

expectRejected((value) => { value.provenance.executionSource = 'production-machine-effects-evaluator'; }, /executionSource-mismatch/);
expectRejected((value) => { value.provenance.sourceKind = 'production-expected-tables'; }, /sourceKind-mismatch/);
expectRejected((value) => { value.provenance.toolchainIdentity = 'production-machine-effects-evaluator'; }, /toolchainIdentity-mismatch/);
expectRejected((value) => { value.expectedStateSource.reference = 'production expected table'; }, /isaReference-mismatch/);
expectRejected((value) => { value.oracleIdentity = 'production-machine-effects-evaluator'; }, /production-derived/);
expectRejected((value) => { value.undefinedMask.registers.x0 = '0x0000000000000001'; }, /undefined-bit-marked-defined/);
expectRejected((value) => { value.unobservedMask.vectors.v0 = '0x1'; }, /unobserved-bit-marked-defined/);
expectRejected((value) => { value.unexpected = true; }, /unknown-field/);
expectRejected((value) => { delete value.expectedState; }, /missing-field/);
expectRejected((value) => { delete value.initialState.registers.x2; }, /state-register-missing/);
expectRejected((value) => { value.initialState.memory.push({ address: '0x10', value: '0xff', widthBits: 8 }); value.initialState.memory.push({ address: '0x10', value: '0xff', widthBits: 8 }); }, /memory-duplicate/);
expectRejected((value) => { value.caseId = `sha256:${'0'.repeat(64)}`; }, /stale-identity/);
expectRejected((value) => { value.expectedState = null; }, /normal-state-required/);

const corpusCase = createCorpusCase(DETERMINISTIC_ADD_CASE);
function referenceOracle(overrides = {}) {
  return createReferenceOracle({
    identity: corpusCase.oracleIdentity,
    version: corpusCase.oracleVersion,
    source: corpusCase.expectedStateSource.executionSource,
    toolchainIdentity: corpusCase.provenance.toolchainIdentity,
    provenance: corpusCase.provenance,
    ...overrides,
  });
}
assert.throws(() => createCorpus([DETERMINISTIC_ADD_CASE], {
  generatorIdentity: 'production-machine-effects-evaluator',
}), /production-derived/);
assert.throws(() => createCorpus([DETERMINISTIC_ADD_CASE], {
  generatorIdentity: corpusCase.oracleIdentity,
}), /oracle-identity-collision/);
const validSubject = () => productionSubjectObservation({ state: corpusCase.expectedState });

const identityMismatch = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: createReferenceOracle({
    identity: 'independent-other-oracle',
    version: corpusCase.oracleVersion,
    provenance: {
      ...corpusCase.provenance,
      authorityId: 'other-independent-authority',
      isaReference: 'other ISA reference',
    },
  }),
});
assert.equal(identityMismatch.status, 'malformed');
assert.equal(identityMismatch.passContribution, 0);

const versionMismatch = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: createReferenceOracle({
    identity: corpusCase.oracleIdentity,
    version: '9.9.9',
    provenance: corpusCase.provenance,
  }),
});
assert.equal(versionMismatch.status, 'malformed');
assert.equal(versionMismatch.passContribution, 0);

const productionIdentity = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: {
    identity: 'production-machine-effects-evaluator',
    version: corpusCase.oracleVersion,
    source: 'production evaluator',
    toolchainIdentity: corpusCase.provenance.toolchainIdentity,
    provenance: corpusCase.provenance,
    evaluate: async () => ({ outcome: corpusCase.expectedOutcome, state: corpusCase.expectedState }),
  },
});
assert.equal(productionIdentity.status, 'malformed');
assert.equal(productionIdentity.passContribution, 0);

const sourceLabelIsNotAuthority = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: {
    ...referenceOracle(),
    source: 'production-looking descriptive label',
  },
});
assert.equal(sourceLabelIsNotAuthority.status, 'exact/equivalent');
assert.equal(sourceLabelIsNotAuthority.passContribution, 1);

const malformedOracleOutcome = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: {
    ...referenceOracle(),
    async evaluate() { return { outcome: { kind: 'not-a-real-outcome' }, state: corpusCase.expectedState }; },
  },
});
assert.equal(malformedOracleOutcome.status, 'malformed');
assert.equal(malformedOracleOutcome.passContribution, 0);

const malformedSubjectOutput = await runIndependentComparison({
  corpusCase,
  subject: () => {
    const output = { ...productionSubjectObservation({ state: corpusCase.expectedState }) };
    output.circular = output;
    return output;
  },
});
assert.equal(malformedSubjectOutput.status, 'malformed');
assert.equal(malformedSubjectOutput.passContribution, 0);

function subjectEnvelope() {
  return {
    subjectIdentity: 'production-machine-effects-evaluator',
    subjectRole: 'production-machine-effects-subject',
    outcome: corpusCase.expectedOutcome,
    state: corpusCase.expectedState,
  };
}

for (const property of ['subjectIdentity', 'subjectRole', 'outcome', 'state']) {
  let getterCalls = 0;
  const accessorSubject = () => {
    const envelope = subjectEnvelope();
    Object.defineProperty(envelope, property, {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('getter-must-not-run');
      },
    });
    return envelope;
  };
  const accessorResult = await runIndependentComparison({ corpusCase, subject: accessorSubject });
  assert.equal(accessorResult.status, 'malformed', `accessor ${property}`);
  assert.equal(accessorResult.passContribution, 0, `accessor ${property}`);
  assert.equal(getterCalls, 0, `accessor ${property} was invoked`);
  const accessorCorpus = await runCorpus(createCorpus([DETERMINISTIC_ADD_CASE]), { subject: accessorSubject });
  assert.equal(accessorCorpus.results[0].status, 'malformed', `corpus accessor ${property}`);
  assert.equal(accessorCorpus.counts.pass, 0, `corpus accessor ${property}`);
  assert.equal(accessorCorpus.status, 'mismatch', `corpus accessor ${property}`);
  assert.equal(getterCalls, 0, `corpus accessor ${property} was invoked`);
}

for (const property of ['subjectIdentity', 'subjectRole', 'outcome', 'state']) {
  const descriptorProxySubject = () => new Proxy(subjectEnvelope(), {
    getOwnPropertyDescriptor(target, key) {
      if (key === property) throw new Error('descriptor-trap');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const proxyCorpus = await runCorpus(createCorpus([DETERMINISTIC_ADD_CASE]), { subject: descriptorProxySubject });
  assert.equal(proxyCorpus.results[0].status, 'malformed', `descriptor proxy ${property}`);
  assert.equal(proxyCorpus.counts.pass, 0, `descriptor proxy ${property}`);
  assert.equal(proxyCorpus.status, 'mismatch', `descriptor proxy ${property}`);
}

const ownKeysProxyCorpus = await runCorpus(createCorpus([DETERMINISTIC_ADD_CASE]), {
  subject: () => new Proxy(subjectEnvelope(), {
    ownKeys() { throw new Error('own-keys-trap'); },
  }),
});
assert.equal(ownKeysProxyCorpus.results[0].status, 'malformed');
assert.equal(ownKeysProxyCorpus.counts.pass, 0);
assert.equal(ownKeysProxyCorpus.status, 'mismatch');

for (const property of ['kind', 'registers']) {
  let getterCalls = 0;
  const nestedAccessorSubject = () => {
    const envelope = subjectEnvelope();
    const parent = property === 'kind' ? { ...envelope.outcome } : { ...envelope.state };
    Object.defineProperty(parent, property, {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('nested-getter-must-not-run');
      },
    });
    if (property === 'kind') envelope.outcome = parent;
    else envelope.state = parent;
    return envelope;
  };
  const nestedCorpus = await runCorpus(createCorpus([DETERMINISTIC_ADD_CASE]), { subject: nestedAccessorSubject });
  assert.equal(nestedCorpus.results[0].status, 'malformed', `nested accessor ${property}`);
  assert.equal(nestedCorpus.counts.pass, 0, `nested accessor ${property}`);
  assert.equal(getterCalls, 0, `nested accessor ${property} was invoked`);
}

let thrownMessageGetterCalls = 0;
const hostileThrownValue = Object.create(null);
Object.defineProperty(hostileThrownValue, 'message', {
  get() {
    thrownMessageGetterCalls += 1;
    throw new Error('message-getter-must-not-run');
  },
});
const hostileThrowSubject = () => { throw hostileThrownValue; };
const hostileThrowResult = await runIndependentComparison({ corpusCase, subject: hostileThrowSubject });
assert.equal(hostileThrowResult.status, 'malformed');
assert.equal(hostileThrowResult.passContribution, 0);
assert.deepEqual(hostileThrowResult.diagnostics, [{ code: 'production-subject-error' }]);
assert.equal(thrownMessageGetterCalls, 0, 'thrown message getter was invoked');
const hostileThrowCorpus = await runCorpus(createCorpus([DETERMINISTIC_ADD_CASE]), { subject: hostileThrowSubject });
assert.equal(hostileThrowCorpus.results[0].status, 'malformed');
assert.equal(hostileThrowCorpus.counts.pass, 0);
assert.equal(hostileThrowCorpus.status, 'mismatch');
assert.equal(thrownMessageGetterCalls, 0, 'corpus read thrown message getter');

const safeThrownValue = Object.create(null);
Object.defineProperty(safeThrownValue, 'message', { value: 'safe-own-message' });
const safeThrowResult = await runIndependentComparison({
  corpusCase,
  subject: () => { throw safeThrownValue; },
});
assert.deepEqual(safeThrowResult.diagnostics, [{ code: 'production-subject-error', detail: 'safe-own-message' }]);

const throwingMessageDescriptor = new Proxy({}, {
  getOwnPropertyDescriptor() { throw new Error('message-descriptor-trap'); },
});
const descriptorThrowCorpus = await runCorpus(createCorpus([DETERMINISTIC_ADD_CASE]), {
  subject: () => { throw throwingMessageDescriptor; },
});
assert.equal(descriptorThrowCorpus.results[0].status, 'malformed');
assert.deepEqual(descriptorThrowCorpus.results[0].diagnostics, [{ code: 'production-subject-error' }]);
assert.equal(descriptorThrowCorpus.status, 'mismatch');

const oversizedFanoutTarget = Object.fromEntries(
  Array.from({ length: 8193 }, (_, index) => [`leaf${index}`, index]),
);
let oversizedFanoutDescriptorReads = 0;
const oversizedFanout = new Proxy(oversizedFanoutTarget, {
  getOwnPropertyDescriptor(target, key) {
    oversizedFanoutDescriptorReads += 1;
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
});
const oversizedFanoutCorpus = await runCorpus(createCorpus([DETERMINISTIC_ADD_CASE]), {
  subject: () => ({ ...subjectEnvelope(), state: oversizedFanout }),
});
assert.equal(oversizedFanoutCorpus.results[0].status, 'malformed');
assert.equal(oversizedFanoutCorpus.counts.pass, 0);
assert.equal(oversizedFanoutCorpus.status, 'mismatch');
assert.equal(oversizedFanoutDescriptorReads, 0, 'oversized fanout traversed descriptors beyond the node cap');

const leftSibling = Array.from({ length: 5000 }, () => 0);
const rightSiblingTarget = Array.from({ length: 5000 }, () => 0);
let rightSiblingDescriptorReads = 0;
const rightSibling = new Proxy(rightSiblingTarget, {
  getOwnPropertyDescriptor(target, key) {
    rightSiblingDescriptorReads += 1;
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
});
const sharedBudgetCorpus = await runCorpus(createCorpus([DETERMINISTIC_ADD_CASE]), {
  subject: () => ({ ...subjectEnvelope(), state: { leftSibling, rightSibling } }),
});
assert.equal(sharedBudgetCorpus.results[0].status, 'malformed');
assert.equal(sharedBudgetCorpus.counts.pass, 0);
assert.equal(sharedBudgetCorpus.status, 'mismatch');
assert.equal(rightSiblingDescriptorReads, 0, 'sibling traversal did not share the global node budget');

const hugeSparseArray = [];
hugeSparseArray.length = 0xffffffff;
let hugeSparseDescriptorReads = 0;
const hugeSparseProxy = new Proxy(hugeSparseArray, {
  getOwnPropertyDescriptor(target, key) {
    hugeSparseDescriptorReads += 1;
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
});
const hugeSparseCorpus = await runCorpus(createCorpus([DETERMINISTIC_ADD_CASE]), {
  subject: () => ({
    ...subjectEnvelope(),
    state: { ...corpusCase.expectedState, memory: hugeSparseProxy },
  }),
});
assert.equal(hugeSparseCorpus.results[0].status, 'malformed');
assert.equal(hugeSparseCorpus.counts.pass, 0);
assert.equal(hugeSparseCorpus.status, 'mismatch');
assert.equal(hugeSparseDescriptorReads, 1, 'huge sparse array traversal continued after its length descriptor');

const notIntegrated = await runIndependentComparison({ corpusCase });
assert.equal(notIntegrated.status, 'not-integrated');
assert.equal(notIntegrated.passContribution, 0);

const unavailable = await runIndependentComparison({
  corpusCase,
  subject: () => productionSubjectObservation({ state: corpusCase.expectedState, outcome: { kind: 'unsupported' } }),
});
assert.equal(unavailable.status, 'unsupported');
assert.equal(unavailable.passContribution, 0);

const cancelled = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: {
    ...referenceOracle(),
    async evaluate() { return { status: 'cancelled', reason: 'test-cancel' }; },
  },
});
assert.equal(cancelled.status, 'cancelled');
assert.equal(cancelled.passContribution, 0);

const budgetLimited = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  budgets: { maxInputBytes: 1 },
});
assert.equal(budgetLimited.status, 'resource-limited');
assert.equal(budgetLimited.passContribution, 0);

const memoryLimited = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  budgets: { maxMemoryBytes: 1 },
});
assert.equal(memoryLimited.status, 'resource-limited');
assert.equal(memoryLimited.passContribution, 0);

const timedOutOracle = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: {
    ...referenceOracle(),
    async evaluate() { return new Promise(() => {}); },
  },
  budgets: { timeoutMs: 20 },
});
assert.equal(timedOutOracle.status, 'resource-limited');
assert.equal(timedOutOracle.passContribution, 0);

const timedOutSubject = await runIndependentComparison({
  corpusCase,
  subject: async () => new Promise(() => {}),
  budgets: { timeoutMs: 20 },
});
assert.equal(timedOutSubject.status, 'resource-limited');
assert.equal(timedOutSubject.passContribution, 0);

const cancellationController = new AbortController();
const cancelledPromise = runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: {
    ...referenceOracle(),
    async evaluate(_caseValue, { signal }) {
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
    },
  },
  signal: cancellationController.signal,
  budgets: { timeoutMs: 1000 },
});
cancellationController.abort('test-cancel');
const cancelledDuringRun = await cancelledPromise;
assert.equal(cancelledDuringRun.status, 'cancelled');
assert.equal(cancelledDuringRun.passContribution, 0);

const cancelledCorpusController = new AbortController();
cancelledCorpusController.abort('test-corpus-cancel');
const cancelledCorpus = await runCorpus(createCorpus(INDEPENDENT_ORACLE_CASE_FIXTURES), {
  subject: validSubject,
  signal: cancelledCorpusController.signal,
});
assert.equal(cancelledCorpus.results.length, INDEPENDENT_ORACLE_CASE_FIXTURES.length);
assert.equal(cancelledCorpus.counts.total, INDEPENDENT_ORACLE_CASE_FIXTURES.length);
assert.equal(cancelledCorpus.counts.pass, 0);
assert.equal(cancelledCorpus.counts.blocking, INDEPENDENT_ORACLE_CASE_FIXTURES.length);

const allUnavailableCorpus = await runCorpus(createCorpus(INDEPENDENT_ORACLE_CASE_FIXTURES), {
  subject: ({ caseValue }) => productionSubjectObservation({
    state: caseValue.expectedState,
    outcome: { kind: 'unavailable', code: 'tool-missing' },
  }),
});
assert.equal(allUnavailableCorpus.counts.pass, 0);
assert.equal(allUnavailableCorpus.counts.gaps, INDEPENDENT_ORACLE_CASE_FIXTURES.length);
assert.equal(allUnavailableCorpus.status, 'unavailable');

const allUnsupportedCorpus = await runCorpus(createCorpus(INDEPENDENT_ORACLE_CASE_FIXTURES), {
  subject: ({ caseValue }) => productionSubjectObservation({
    state: caseValue.expectedState,
    outcome: { kind: 'unsupported' },
  }),
});
assert.equal(allUnsupportedCorpus.counts.pass, 0);
assert.equal(allUnsupportedCorpus.counts.gaps, INDEPENDENT_ORACLE_CASE_FIXTURES.length);
assert.equal(allUnsupportedCorpus.status, 'unsupported');

let mixedGapIndex = 0;
const mixedGapCorpus = await runCorpus(createCorpus(INDEPENDENT_ORACLE_CASE_FIXTURES), {
  subject: ({ caseValue }) => {
    mixedGapIndex += 1;
    return productionSubjectObservation({
      state: caseValue.expectedState,
      outcome: mixedGapIndex === 1 ? caseValue.expectedOutcome : { kind: 'unavailable', code: 'tool-missing' },
    });
  },
});
assert.equal(mixedGapCorpus.counts.pass, 1);
assert.equal(mixedGapCorpus.counts.gaps, INDEPENDENT_ORACLE_CASE_FIXTURES.length - 1);
assert.equal(mixedGapCorpus.status, 'partial');

const partialOracle = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: {
    ...referenceOracle(),
    async evaluate() { return { outcome: corpusCase.expectedOutcome }; },
  },
});
assert.equal(partialOracle.status, 'partial');
assert.equal(partialOracle.passContribution, 0);

const validResult = await runIndependentComparison({ corpusCase, subject: validSubject });
assert.throws(() => createOracleResult({
  ...validResult,
  profileId: 'x86_64:long-64',
}, corpusCase), /profile-mismatch/);
const shrunkResult = clone(validResult);
shrunkResult.definedMask.registers.x0 = '0x0000000000000000';
assert.throws(() => createOracleResult(shrunkResult, corpusCase), /defined-mask-mismatch/);
const otherOracleResult = clone(validResult);
otherOracleResult.oracleIdentity = 'independent-other-oracle';
otherOracleResult.provenance = {
  ...otherOracleResult.provenance,
  authorityId: 'other-independent-authority',
  isaReference: 'other ISA reference',
};
assert.throws(() => createOracleResult(otherOracleResult, corpusCase), /oracle-identity-mismatch/);
assert.throws(() => createOracleResult({
  ...validResult,
  resultId: `sha256:${'0'.repeat(64)}`,
}), /stale-identity/);
assert.throws(() => createOracleResult({
  ...validResult,
  unknown: true,
}), /unknown-field/);
assert.throws(() => createOracleResult({
  ...validResult,
  diagnostics: Array.from({ length: 33 }, () => ({ code: 'too-many' })),
}, corpusCase), /diagnostics-invalid-count/);

console.log('machine-effects independent oracle negative matrix: PASS (fail-closed matrix)');
