// Issue #8929 regression: a `verified` evidence record minted against an older
// analysis revision must not authorize a new mutation proposal in the current
// revision.
//
// `ObservationStore.binding()` already folds `analysisRevision` into the binding
// key, and `EvidenceStore` keeps that key on each record as `sourceBinding`, so
// stale provenance was always observable. `ProposalStore.create()` only checked
// `status === 'verified'`, and `AIRuntime`'s proposal binding omitted
// `analysisRevision`, so:
//   - r1 verified evidence could authorize an r2 mutation, and
//   - a proposal created at r1 could still apply after the revision changed.
//
// The fix requires authority-bearing evidence to still carry the current
// canonical binding, and folds `analysisRevision` into the proposal binding.
import assert from 'node:assert/strict';
import test from 'node:test';

import { AIRuntime } from '../js/ai/runtime.js';
import { EvidenceStore } from '../js/ai/evidence.js';
import { ProposalStore } from '../js/ai/proposals.js';
import { createHexToolRegistry } from '../js/ai/tools/registry.js';
import { sealPersistedConfirmedEnvelope } from '../js/ai/session-core/persisted-confirmed.js';

// Only `analysisRevision` differs between these contexts: binary/project/
// runtime identity is pinned so the test isolates revision-bound staleness.
function makeContext(analysisRevision) {
  return {
    binaryId: 'bin-a',
    projectId: 'proj-a',
    runtimeSessionId: 'rt-a',
    analysisRevision,
    runtimePlatform: {
      async verifyHypothesis() {
        return {
          verdict: { status: 'confirmed', supported: 3, contradicted: 0, total: 3 },
          coverage: { complete: true, truncated: false, cancelled: false, unsupported: 0, planned: 3, executed: 3 },
          cases: [0, 1, 2].map((i) => ({ id: `case-${i}`, comparison: { status: 'supported' } })),
          evidence: [`rt-proof-${analysisRevision}`],
          functionAddress: '0x1000',
        };
      },
    },
  };
}

const draft = (evidenceIds) => ({
  kind: 'rename',
  target: { address: '0x1000' },
  before: { name: 'sub_1000' },
  after: { name: 'meaning' },
  evidenceIds,
});

async function mintVerified(registry) {
  const out = await registry.execute('verify_runtime_hypothesis', { hypothesis: { claim: 'x' } }, { scope: 'runtime' });
  return out.evidence.find((item) => item.status === 'verified');
}

test('#8929 r1 verified evidence is rejected once the analysis revision moved to r2', async () => {
  const context = makeContext('r1');
  const evidenceStore = new EvidenceStore();
  const registry = createHexToolRegistry(context, { evidenceStore });
  const runtime = new AIRuntime({ context, evidenceStore, planner: false });

  const r1 = await mintVerified(registry);
  const r1Binding = registry.observationStore.binding().key;
  assert.equal(r1.sourceBinding, r1Binding, 'verifier evidence carries its revision-bound provenance');

  // (1) The same revision still authorizes a proposal.
  const atR1 = runtime.proposalStore.create(draft([r1.id]));
  assert.deepEqual(atR1.evidenceIds, [r1.id]);

  // (2) Only the analysis revision changes.
  context.analysisRevision = 'r2';
  const r2Registry = createHexToolRegistry(context, { evidenceStore });
  const r2Binding = r2Registry.observationStore.binding().key;
  assert.notEqual(r1Binding, r2Binding, 'the revision change must move the canonical binding');

  assert.throws(
    () => runtime.proposalStore.create(draft([r1.id])),
    (error) => error?.type === 'invalid_tool_call',
    'stale r1 evidence must not authorize an r2 mutation',
  );

  // (3) Fresh r2 evidence still authorizes an r2 proposal.
  const r2 = await mintVerified(r2Registry);
  assert.equal(r2.sourceBinding, r2Binding);
  const atR2 = runtime.proposalStore.create(draft([r2.id]));
  assert.deepEqual(atR2.evidenceIds, [r2.id]);
});

test('#8929 revision drift between create and apply fails closed', async () => {
  const context = makeContext('r1');
  const evidenceStore = new EvidenceStore();
  const registry = createHexToolRegistry(context, { evidenceStore });
  const runtime = new AIRuntime({ context, evidenceStore, planner: false });
  const r1 = await mintVerified(registry);

  const proposal = runtime.proposalStore.create(draft([r1.id]));
  const { approvalToken } = runtime.proposalStore.approve(proposal.id);

  context.analysisRevision = 'r2';
  let applied = false;
  await assert.rejects(
    () => runtime.proposalStore.apply(proposal.id, {
      approvalToken, currentState: proposal.before, apply: async () => { applied = true; },
    }),
    (error) => error?.type === 'scope_violation',
    'a proposal bound to r1 must not apply at r2',
  );
  assert.equal(applied, false);
});

test('#8929 persisted r1 finding restored at r2 is not mutation authority', async () => {
  const r1Context = makeContext('r1');
  const evidenceStore = new EvidenceStore();
  const registry = createHexToolRegistry(r1Context, { evidenceStore });
  const r1 = await mintVerified(registry);

  // Persist exactly what a session stores: the sealed confirmed-findings
  // envelope of the r1 verified records.
  const confirmed = sealPersistedConfirmedEnvelope(evidenceStore.byStatus('verified').map((record) => ({ ...record })));

  const r2Context = makeContext('r2');
  const restored = new EvidenceStore();
  restored.restorePersistedConfirmed(confirmed);
  const restoredRegistry = createHexToolRegistry(r2Context, { evidenceStore: restored });
  const runtime = new AIRuntime({ context: r2Context, evidenceStore: restored, planner: false });

  const restoredRecord = restored.get(r1.id);
  assert.equal(restoredRecord.status, 'verified', 'the sealed finding restores as verified');
  assert.equal(restoredRecord.sourceBinding, r1.sourceBinding, 'restore preserves the r1 provenance');
  assert.notEqual(restoredRegistry.observationStore.binding().key, r1.sourceBinding);

  assert.throws(
    () => runtime.proposalStore.create(draft([r1.id])),
    (error) => error?.type === 'invalid_tool_call',
    'a restored stale finding must not authorize a current-revision mutation',
  );

  // A same-revision restored finding still authorizes (no blanket rejection).
  const sameRevision = new EvidenceStore();
  sameRevision.restorePersistedConfirmed(sealPersistedConfirmedEnvelope(
    evidenceStore.byStatus('verified').filter((record) => record.sourceBinding === r1.sourceBinding).map((record) => ({ ...record })),
  ));
  createHexToolRegistry(r1Context, { evidenceStore: sameRevision });
  const sameRuntime = new AIRuntime({ context: r1Context, evidenceStore: sameRevision, planner: false });
  const accepted = sameRuntime.proposalStore.create(draft([r1.id]));
  assert.deepEqual(accepted.evidenceIds, [r1.id]);
});

test('#8929 adapters without a binding resolver keep the legacy status contract', () => {
  const legacy = new ProposalStore({ evidenceStore: { get: (id) => (id === 'ev-1' ? { id, status: 'verified', sourceBinding: 'stale-binding' } : null) } });
  const proposal = legacy.create(draft(['ev-1']));
  assert.deepEqual(proposal.evidenceIds, ['ev-1']);

  // A configured resolver also requires provenance on the verified record itself.
  // Missing sourceBinding is not an implicit revision-invariant authority class.
  const missing = new ProposalStore({
    evidenceStore: { get: (id) => (id === 'ev-1' ? { id, status: 'verified' } : null) },
    currentEvidenceBinding: () => 'current-binding',
  });
  assert.throws(() => missing.create(draft(['ev-1'])), (error) => error?.type === 'invalid_tool_call');

  // A configured resolver that cannot prove a current binding fails closed.
  const strict = new ProposalStore({
    evidenceStore: { get: (id) => (id === 'ev-1' ? { id, status: 'verified', sourceBinding: 'stale-binding' } : null) },
    currentEvidenceBinding: () => '',
  });
  assert.throws(() => strict.create(draft(['ev-1'])), (error) => error?.type === 'invalid_tool_call');
});

console.log('issue #8929 stale verified evidence binding: PASS');
