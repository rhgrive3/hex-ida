import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  assessArchitecturalEvidence,
  createArchitecturalEvidenceFromArtifactRecord,
} from '../../tools/validation/machine-effects/oracle-evidence-v2.mjs';
import { validateFormalEvidenceArtifacts } from '../../tools/validation/machine-effects/generate-formal-evidence.mjs';

const manifest = validateFormalEvidenceArtifacts(JSON.parse(fs.readFileSync(
  new URL('../../tools/validation/machine-effects/generated/formal-evidence-artifacts.json', import.meta.url),
  'utf8',
)));

test('pinned Isla and Sail artifacts authorize only their declared observables', () => {
  assert.equal(manifest.identities.qemuAarch64.role, 'independent-concrete-execution');
  assert.equal(manifest.identities.qemuRiscv64.role, 'independent-concrete-execution');
  const records = manifest.records.filter((record) => record.kind === 'instruction-footprint');
  assert.deepEqual(records.map((record) => record.profileId), ['arm64:a64', 'riscv64:rv64imc']);
  for (const record of records) {
    const evidence = createArchitecturalEvidenceFromArtifactRecord(record);
    const result = assessArchitecturalEvidence({ evidence, subject: { profileId: record.profileId, observables: record.expectedObservables } });
    assert.equal(result.status, 'exact/equivalent', record.id);
    assert.equal(result.exactAuthorized, true, record.id);
    assert.match(record.artifact.toolOutput, /QEMU-(AARCH64|RISCV64) exit-status:8/, record.id);
  }
});

test('pinned herd artifacts classify five orderings without widening their litmus universe', () => {
  const records = manifest.records.filter((record) => record.kind === 'relaxed-memory-outcomes');
  assert.deepEqual(records.map((record) => record.memoryModel.ordering), ['relaxed', 'acquire', 'release', 'acq-rel', 'seq-cst']);
  for (const record of records) {
    const evidence = createArchitecturalEvidenceFromArtifactRecord(record);
    const result = assessArchitecturalEvidence({
      evidence,
      subject: {
        profileId: record.profileId,
        observables: record.expectedObservables,
        ordering: record.memoryModel.ordering,
        ...record.memoryModel,
      },
    });
    assert.equal(result.status, 'exact/equivalent', record.id);
    assert.equal(record.memoryModel.outcomeUniverse.length, 1, 'formal result is claim-local, not architecture-wide');
  }
});

test('generated artifact source, model, and payload mutations fail closed', () => {
  const identityDrift = structuredClone(manifest);
  identityDrift.identities.herdtools7.commit = '0'.repeat(40);
  assert.throws(() => validateFormalEvidenceArtifacts(identityDrift), /identity-drift/);

  const sourceDrift = structuredClone(manifest);
  sourceDrift.records[1].source.digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateFormalEvidenceArtifacts(sourceDrift), /source-digest/);

  const outputDrift = structuredClone(manifest);
  outputDrift.records[0].artifact.toolOutput = 'forged';
  assert.throws(() => validateFormalEvidenceArtifacts(outputDrift), /artifact-digest/);

  const denominatorShrink = structuredClone(manifest);
  denominatorShrink.records.pop();
  assert.throws(() => validateFormalEvidenceArtifacts(denominatorShrink), /record-denominator/);

  const unknownField = structuredClone(manifest);
  unknownField.records[0].trustMe = true;
  assert.throws(() => validateFormalEvidenceArtifacts(unknownField), /record-fields/);
});

test('synthetic self-consistent evidence is not a release-authorized generated artifact', async () => {
  const { createArchitecturalEvidence } = await import('../../tools/validation/machine-effects/oracle-evidence-v2.mjs');
  const { createOracleReport, assertReleaseReady } = await import('../../tools/validation/machine-effects/oracle-report.mjs');
  const { createCorpus } = await import('../../tools/validation/machine-effects/oracle-corpus.mjs');
  const { runIndependentComparison } = await import('../../tools/validation/machine-effects/oracle-runner.mjs');
  const { INDEPENDENT_ORACLE_CASE_FIXTURES } = await import('./fixtures/independent-oracle-cases.mjs');
  const { evidenceInputForOracleCase } = await import('./fixtures/evidence-v2-cases.mjs');
  const corpus = createCorpus([INDEPENDENT_ORACLE_CASE_FIXTURES[0]]);
  const result = await runIndependentComparison({
    corpusCase: corpus.cases[0],
    subject: ({ caseValue }) => ({ subjectIdentity: 'test-subject', subjectRole: 'production-machine-effects-subject', outcome: { kind: 'normal' }, state: caseValue.expectedState }),
  });
  const report = createOracleReport({
    productSha: '1'.repeat(40), baseSha: '2'.repeat(40), corpus, results: [result],
    toolchain: 'unit-test-toolchain',
    architecturalEvidence: [createArchitecturalEvidence(evidenceInputForOracleCase(corpus.cases[0]))],
  });
  assert.deepEqual(report.evidenceBreadth.unjustifiedExactCases, [result.caseId]);
  assert.throws(() => assertReleaseReady(report, { requireA2Preservation: false }), /report-incomplete-architectural-evidence/);
});
