import assert from 'node:assert/strict';
import { AIRuntime } from '../../js/ai/runtime.js';
import { EvidenceStore } from '../../js/ai/evidence.js';
import { HypothesisStore } from '../../js/ai/hypothesis.js';
import { createCapabilityCatalog } from '../../js/ai/capabilities/catalog.js';
import { createCapabilityExecutor } from '../../js/ai/capabilities/executor.js';

// #1701/#1702 — a fresh AIRuntime hydrates its first resumed namespace,
// while ordinary evidence input still cannot manufacture verified authority.
{
  const savedEvidence = {
    id: 'ev_saved', kind: 'observation', status: 'verified',
    title: 'saved deterministic finding', sourceTool: 'deterministic-test',
  };
  const session = {
    id: 'persisted-1',
    confirmedFindings: [savedEvidence],
    hypotheses: [{
      id: 'hyp_saved', claim: 'saved hypothesis', confidence: 0.8,
      status: 'verified', supportEvidenceIds: ['ev_saved'],
      contradictionEvidenceIds: [], missingEvidence: [],
    }],
  };

  assert.equal(new EvidenceStore([savedEvidence]).get('ev_saved')?.status, 'supported');
  const restoredDirect = new EvidenceStore().restorePersistedConfirmed([savedEvidence]);
  assert.equal(restoredDirect.get('ev_saved')?.status, 'verified');

  const runtime = new AIRuntime({ planner: false });
  const restored = runtime.storesFor(session, 'bin-1');
  assert.equal(restored.evidenceStore.get('ev_saved')?.status, 'verified');
  assert.equal(restored.hypothesisStore.get('hyp_saved')?.status, 'verified');

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
}

// #1727 — declared capability schemas are enforced before execution, including
// the string|integer union now supported by the shared schema validator.
{
  const calls = [];
  const executor = createCapabilityExecutor({
    catalog: createCapabilityCatalog(),
    actionRunner: async (action) => calls.push(action),
  });
  await assert.rejects(
    executor.execute('navigation.open-function', { address: { not: 'an-address' } }),
    (error) => error?.type === 'invalid_tool_call',
  );
  assert.equal(calls.length, 0);
  await executor.execute('navigation.open-function', { address: '0x1000' });
  await executor.execute('navigation.open-function', { address: 4096 });
  assert.equal(calls.length, 2);
}
