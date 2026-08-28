import assert from 'node:assert/strict';

import {
  createReferenceOracle,
  productionSubjectObservation,
  runIndependentComparison,
} from '../../tools/validation/machine-effects/oracle-runner.mjs';
import { createCorpus } from '../../tools/validation/machine-effects/oracle-corpus.mjs';
import {
  createCorpusCase,
  createOracleResult,
  validateCorpusCase,
} from '../../tools/validation/machine-effects/oracle-schema.mjs';
import { DETERMINISTIC_ADD_CASE } from './fixtures/independent-oracle-cases.mjs';

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

expectRejected((value) => { value.provenance.executionSource = 'production-machine-effects-evaluator'; }, /production-derived/);
expectRejected((value) => { value.provenance.sourceKind = 'production-expected-tables'; }, /production-derived/);
expectRejected((value) => { value.provenance.toolchainIdentity = 'production-machine-effects-evaluator'; }, /production-derived/);
expectRejected((value) => { value.expectedStateSource.reference = 'production expected table'; }, /production-derived/);
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

const productionSource = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: {
    ...createReferenceOracle({
      identity: corpusCase.oracleIdentity,
      version: corpusCase.oracleVersion,
      provenance: corpusCase.provenance,
    }),
    source: 'production evaluator',
  },
});
assert.equal(productionSource.status, 'malformed');
assert.equal(productionSource.passContribution, 0);

const malformedOracleOutcome = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: {
    ...createReferenceOracle({
      identity: corpusCase.oracleIdentity,
      version: corpusCase.oracleVersion,
      provenance: corpusCase.provenance,
    }),
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
    ...createReferenceOracle({
      identity: corpusCase.oracleIdentity,
      version: corpusCase.oracleVersion,
      provenance: corpusCase.provenance,
    }),
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

const partialOracle = await runIndependentComparison({
  corpusCase,
  subject: validSubject,
  oracle: {
    ...createReferenceOracle({
      identity: corpusCase.oracleIdentity,
      version: corpusCase.oracleVersion,
      provenance: corpusCase.provenance,
    }),
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

console.log('machine-effects independent oracle negative matrix: PASS (26 rejection/blocking cases)');
