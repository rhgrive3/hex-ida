import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_ORDERINGS,
  assessArchitecturalEvidence,
  createMemoryOutcomeEvidence,
} from '../../tools/validation/machine-effects/oracle-evidence-v2.mjs';
import { clone, memoryInput } from './fixtures/evidence-v2-cases.mjs';

test('all six ordering identities have explicit outcome evidence boundaries', () => {
  assert.deepEqual(EVIDENCE_ORDERINGS, ['relaxed', 'acquire', 'release', 'acq-rel', 'seq-cst', 'unknown']);
  for (const ordering of EVIDENCE_ORDERINGS) {
    const evidence = createMemoryOutcomeEvidence(memoryInput(ordering));
    const result = assessArchitecturalEvidence({
      evidence,
      subject: { profileId: evidence.profileId, ordering, observables: evidence.expectedObservables, ...evidence.memoryModel },
    });
    assert.equal(result.status, ordering === 'unknown' ? 'partial' : 'exact/equivalent');
  }
});

test('ordering strengthening and weakening are mismatches', () => {
  const evidence = createMemoryOutcomeEvidence(memoryInput('acquire'));
  for (const ordering of ['relaxed', 'seq-cst', 'release']) {
    assert.equal(assessArchitecturalEvidence({ evidence, subject: { profileId: evidence.profileId, ordering, observables: evidence.expectedObservables } }).status, 'mismatch');
  }
});

test('permitted/forbidden strengthening and weakening are mismatches', () => {
  const evidence = createMemoryOutcomeEvidence(memoryInput('seq-cst'));
  const exactSubject = { profileId: evidence.profileId, ordering: evidence.memoryModel.ordering, observables: evidence.expectedObservables, ...evidence.memoryModel };
  assert.equal(assessArchitecturalEvidence({ evidence, subject: exactSubject }).status, 'exact/equivalent');
  assert.equal(assessArchitecturalEvidence({ evidence, subject: { ...exactSubject, permittedOutcomes: evidence.memoryModel.outcomeUniverse, forbiddenOutcomes: [] } }).status, 'mismatch');
  assert.equal(assessArchitecturalEvidence({ evidence, subject: { ...exactSubject, permittedOutcomes: [], forbiddenOutcomes: evidence.memoryModel.outcomeUniverse } }).status, 'mismatch');
});

test('malformed ordering, atomic mismatch, unsupported combinations, and incomplete universe fail closed', () => {
  assert.throws(() => createMemoryOutcomeEvidence(memoryInput('bogus')), /malformed-ordering/);
  assert.throws(() => createMemoryOutcomeEvidence(memoryInput('acquire', { memoryModel: { ...memoryInput('acquire').memoryModel, atomic: false } })), /atomic-non-atomic-mismatch/);
  assert.throws(() => createMemoryOutcomeEvidence(memoryInput('unknown', { completeness: 'complete' })), /unknown-ordering-cannot-be-complete/);
  const incomplete = memoryInput('seq-cst');
  incomplete.memoryModel = { ...incomplete.memoryModel, forbiddenOutcomes: [] };
  assert.throws(() => createMemoryOutcomeEvidence(incomplete), /outcome-universe-incomplete/);
  const overlap = clone(memoryInput('seq-cst'));
  overlap.memoryModel.permittedOutcomes.push('r0=0,r1=0');
  assert.throws(() => createMemoryOutcomeEvidence(overlap), /outcome-partition-overlap/);
});
