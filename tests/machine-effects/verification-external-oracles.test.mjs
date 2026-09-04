import assert from 'node:assert/strict';
import {
  assertExternalOraclePolicy,
  createExternalOracleEvidence,
  inspectExternalOracleInfrastructure,
} from '../../tools/validation/machine-effects/external-oracles.mjs';

const report = inspectExternalOracleInfrastructure();
assert.equal(report.defaultNetworkRequired, false);
assert.equal(assertExternalOraclePolicy(report), true);

const byId = new Map(report.entries.map((entry) => [entry.id, entry]));
assert.equal(byId.get('compiler-truth').available, true);
assert.equal(byId.get('compiler-truth').role, 'independent-source-and-concrete-vector-evidence');
assert.equal(byId.get('ghidra-differential').available, true);
assert.equal(byId.get('ghidra-differential').semanticAuthority, 'not-absolute-isa-truth');
assert.equal(byId.get('capstone').available, true);
assert.equal(byId.get('capstone').semanticAuthority, 'disassembly-text-does-not-prove-semantics');
assert.equal(byId.get('formal-architectural-models').available, true);
assert.equal(byId.get('formal-architectural-models').semanticAuthority, 'complete-artifact-observable-partition-only');
assert.equal(byId.get('formal-architectural-models').checkedInEvidenceAvailable, false);
assert.equal(byId.get('formal-architectural-models').regenerationStatus, 'not-verified');
assert.equal(byId.get('herdtools7-aarch64-memory-model').available, true);
assert.equal(byId.get('herdtools7-aarch64-memory-model').semanticAuthority, 'declared-litmus-outcome-universe-only');
assert.equal(byId.get('herdtools7-aarch64-memory-model').regenerationStatus, 'not-verified');

const compilerEvidence = createExternalOracleEvidence({
  oracleId:'compiler-truth',
  subject:'signed max source manifest',
  verdict:'supports',
  details:{ vectors:9 },
});
assert.equal(compilerEvidence.semanticAuthority, 'source-manifest-and-independent-evaluation-only');

const ghidraEvidence = createExternalOracleEvidence({
  oracleId:'ghidra-differential',
  subject:'function output comparison',
  verdict:'diagnostic',
});
assert.equal(ghidraEvidence.role, 'external-differential-diagnostic');

assert.throws(() => createExternalOracleEvidence({ oracleId:'capstone', subject:'add', verdict:'proves-semantics' }), /invalid-external-oracle-verdict/);

console.log('machine-effects external oracle policy: PASS');
