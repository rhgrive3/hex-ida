import assert from 'node:assert/strict';
import { AIRuntime } from '../../js/ai/runtime.js';
import { EvidenceStore } from '../../js/ai/evidence.js';
import { HypothesisStore } from '../../js/ai/hypothesis.js';

const savedEvidence = {
  id: 'ev_saved',
  kind: 'observation',
  status: 'verified',
  title: 'saved deterministic finding',
  sourceTool: 'deterministic-test',
};
const session = {
  id: 'persisted-1',
  confirmedFindings: [savedEvidence],
  hypotheses: [{
    id: 'hyp_saved',
    claim: 'saved hypothesis',
    confidence: 0.8,
    status: 'verified',
    supportEvidenceIds: ['ev_saved'],
    contradictionEvidenceIds: [],
    missingEvidence: [],
  }],
};

// Ordinary input is still untrusted and cannot manufacture verification authority.
assert.equal(new EvidenceStore([savedEvidence]).get('ev_saved')?.status, 'supported');

// Runtime-owned persisted confirmed findings retain their deterministic authority.
const restoredDirect = new EvidenceStore().restorePersistedConfirmed([savedEvidence]);
assert.equal(restoredDirect.get('ev_saved')?.status, 'verified');

// #1701/#1702: the first namespace opened by a fresh runtime hydrates persisted state.
const runtime = new AIRuntime({ planner: false });
const restored = runtime.storesFor(session, 'bin-1');
assert.equal(restored.evidenceStore.get('ev_saved')?.status, 'verified');
assert.equal(restored.hypothesisStore.get('hyp_saved')?.status, 'verified');

// Explicitly injected stores preserve the existing constructor contract.
const injectedEvidence = new EvidenceStore();
const injectedHypotheses = new HypothesisStore(injectedEvidence);
const injectedRuntime = new AIRuntime({
  evidenceStore: injectedEvidence,
  hypothesisStore: injectedHypotheses,
  planner: false,
});
const injected = injectedRuntime.storesFor(session, 'bin-1');
assert.equal(injected.evidenceStore, injectedEvidence);
assert.equal(injected.hypothesisStore, injectedHypotheses);

console.log('AI persisted session hydration regressions: PASS');
