import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRuntimeEvidenceRecord,
  evidenceFromExperiment,
  traceToSemanticFacts,
} from '../../../js/runtime-evidence/index.js';

const malformedIdentities = () => [
  ['session-A'],
  { value: 'session-A' },
  { toString() { throw new Error('must-not-coerce'); } },
  true,
  false,
  1,
  1n,
  new String('session-A'),
];

function assertProvenanceIdentityRejected(invoke, field) {
  for (const value of malformedIdentities()) {
    assert.throws(
      () => invoke(value),
      (error) => error instanceof TypeError
        && error.message === `runtime provenance ${field} must be a non-empty string`,
    );
  }
}

test('#4737 canonical primitive provenance ids preserve the existing observation group', () => {
  const record = createRuntimeEvidenceRecord({
    sessionId: 'session-A',
    experimentId: 'experiment-A',
    caseId: 'case-A',
    kind: 'observation',
  });

  assert.equal(record.provenance.observationGroup, 'runtime:session-A:experiment-A:case-A');
  assert.equal(record.id, 'runtime:session-A:experiment-A:case-A:observation');
});

test('#4737 structured session identity cannot alias a canonical observation group', () => {
  assertProvenanceIdentityRejected(
    (sessionId) => createRuntimeEvidenceRecord({ sessionId, experimentId: 'exp', caseId: 'case' }),
    'sessionId',
  );
});

test('#4737 structured experiment/case identities cannot alias canonical provenance', () => {
  assertProvenanceIdentityRejected(
    (experimentId) => createRuntimeEvidenceRecord({ sessionId: 'session', experimentId, caseId: 'case' }),
    'experimentId',
  );
  assertProvenanceIdentityRejected(
    (caseId) => createRuntimeEvidenceRecord({ sessionId: 'session', experimentId: 'exp', caseId }),
    'caseId',
  );
});

test('#4737 explicit provenanceGroup is typed authority, not a String-coercible value', () => {
  assertProvenanceIdentityRejected(
    (provenanceGroup) => createRuntimeEvidenceRecord({ provenanceGroup, kind: 'observation' }),
    'provenanceGroup',
  );
});

test('#4737 experiment producer rejects structured correlation ids before grouping', () => {
  const base = {
    experiment: { id: 'experiment', binaryHash: 'hash', functionAddress: 0x1000n },
    testCase: { id: 'case', input: null, initialState: null },
    observation: { returnValue: 1n, registerDelta: [], memoryDelta: [], memoryAfter: [], stop: { kind: 'return' }, branches: [] },
    comparison: { status: 'supported' },
  };

  assertProvenanceIdentityRejected(
    (sessionId) => evidenceFromExperiment({ ...base, sessionId }),
    'sessionId',
  );
  assertProvenanceIdentityRejected(
    (id) => evidenceFromExperiment({ ...base, experiment: { ...base.experiment, id } }),
    'experimentId',
  );
  assertProvenanceIdentityRejected(
    (id) => evidenceFromExperiment({ ...base, testCase: { ...base.testCase, id } }),
    'caseId',
  );
});

test('#4737 trace provenance rejects structured session/trace ids instead of aliasing them', () => {
  const trace = [{ type: 'return', value: 1n }];
  assertProvenanceIdentityRejected(
    (sessionId) => traceToSemanticFacts(trace, { sessionId, traceId: 'trace' }),
    'sessionId',
  );
  assertProvenanceIdentityRejected(
    (traceId) => traceToSemanticFacts(trace, { sessionId: 'session', traceId }),
    'traceId',
  );
});


test('#4737 provenance authority is snapshotted once before validation and use', () => {
  let recordReads = 0;
  const recordInput = {
    get sessionId() {
      recordReads++;
      return recordReads === 1 ? ['session-A'] : 'session-A';
    },
    experimentId: 'exp',
    caseId: 'case',
  };
  assert.throws(
    () => createRuntimeEvidenceRecord(recordInput),
    (error) => error instanceof TypeError
      && error.message === 'runtime provenance sessionId must be a non-empty string',
  );
  assert.equal(recordReads, 1);

  let traceReads = 0;
  const context = {
    get traceId() {
      traceReads++;
      return traceReads === 1 ? { id: 'trace' } : 'trace';
    },
    sessionId: 'session',
  };
  assert.throws(
    () => traceToSemanticFacts([{ type: 'return', value: 1n }], context),
    (error) => error instanceof TypeError
      && error.message === 'runtime provenance traceId must be a non-empty string',
  );
  assert.equal(traceReads, 1);
});

test('#4737 nullish defaults and function-address fallback remain compatible', () => {
  assert.equal(
    createRuntimeEvidenceRecord({ kind: 'observation' }).provenance.observationGroup,
    'runtime:session:observation:case',
  );
  assert.equal(
    createRuntimeEvidenceRecord({ function: 0x1000n, kind: 'observation' }).provenance.observationGroup,
    'runtime:session:4096:case',
  );
  assert.equal(
    traceToSemanticFacts([{ type: 'return', value: 1n }]).facts[0].provenance.observationGroup,
    'trace:session:trace',
  );
});
