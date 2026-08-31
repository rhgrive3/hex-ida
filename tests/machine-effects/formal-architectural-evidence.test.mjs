import assert from 'node:assert/strict';
import test from 'node:test';

import {
  architecturalEvidenceInventory,
  assessArchitecturalEvidence,
  createArchitecturalEvidence,
  validateArchitecturalEvidence,
} from '../../tools/validation/machine-effects/oracle-evidence-v2.mjs';
import { architecturalInput, clone } from './fixtures/evidence-v2-cases.mjs';

test('formal architectural evidence binds exact identity and complete observables', () => {
  const evidence = createArchitecturalEvidence(architecturalInput());
  assert.deepEqual(validateArchitecturalEvidence(evidence), evidence);
  const result = assessArchitecturalEvidence({ evidence, subject: { profileId: evidence.profileId, observables: evidence.expectedObservables } });
  assert.equal(result.status, 'exact/equivalent');
  assert.equal(result.passContribution, 1);
});

test('formal disagreement blocks exact authorization', () => {
  const evidence = createArchitecturalEvidence(architecturalInput());
  const result = assessArchitecturalEvidence({ evidence, subject: { profileId: evidence.profileId, observables: { ...evidence.expectedObservables, 'flag:N': '0' } } });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.exactAuthorized, false);
});

test('stale, wrong profile/version, malformed, and incomplete artifacts fail closed', () => {
  const evidence = createArchitecturalEvidence(architecturalInput());
  const stale = clone(evidence); stale.evidenceId = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateArchitecturalEvidence(stale), /stale-evidence-identity/);
  const forgedArtifact = clone(evidence); forgedArtifact.artifact.toolOutput = 'forged output';
  assert.throws(() => validateArchitecturalEvidence(forgedArtifact), /artifact-digest-mismatch/);
  const wrongVersion = architecturalInput(); wrongVersion.source.modelCommit = 'deadbeef'; wrongVersion.freshness.generatedFrom = 'deadbeef';
  assert.throws(() => createArchitecturalEvidence(wrongVersion), /unsupported-profile-version/);
  const wrongProfile = architecturalInput({ profileId: 'arm64:sve' });
  assert.throws(() => createArchitecturalEvidence(wrongProfile), /unsupported-profile/);
  const malformed = clone(evidence); malformed.unexpected = true;
  assert.throws(() => validateArchitecturalEvidence(malformed), /unknown-field/);
  const incomplete = architecturalInput({ completeness: 'partial', observables: { declared: ['register:x0', 'flag:N'], known: ['register:x0'], undefined: [], implementationDefined: [], unobserved: [] }, expectedObservables: { 'register:x0': '0x0' } });
  const partialEvidence = createArchitecturalEvidence(incomplete);
  assert.equal(assessArchitecturalEvidence({ evidence: partialEvidence, subject: { profileId: partialEvidence.profileId, observables: partialEvidence.expectedObservables } }).status, 'partial');
});

test('production architecture inventory is four profiles with honest exact boundaries', () => {
  const inventory = architecturalEvidenceInventory();
  assert.deepEqual(inventory.map((item) => item.profileId), ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc']);
  assert.equal(inventory.every((item) => item.productionSupport === 'declared-by-a2' && item.exactBoundary), true);
  assert.equal(inventory.find((item) => item.profileId === 'arm64e:a64+pac').independentEvidence, 'partial');
});
