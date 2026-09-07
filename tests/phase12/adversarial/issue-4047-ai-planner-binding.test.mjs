import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTurnSnapshot } from '../../../js/ai/control/snapshot.js';
import { assertLiveBindingsUnchanged } from '../../../js/ai/control/runtime-support.js';
import { AIRuntime } from '../../../js/ai/runtime.js';

const source = await readFile(new URL('../../../js/ai/control/turn-executor.js', import.meta.url), 'utf8');
const guard = 'assertLiveBindingsUnchanged(this.localContext, snapshot);';
const plannerBranch = source.indexOf('if (this.planner && shouldRunPlanner(request, snapshot, intent))');
const plannerAwait = source.indexOf('plan = await this.planner(', plannerBranch);
const ingest = source.indexOf('const plannedEvidence = this.evidenceStore.ingestPlan(plan);', plannerAwait);
const caughtDecision = source.indexOf('if (!decision) decision = deterministicDecision(plan, request, normalized);', ingest);
const finalize = source.indexOf('const result = this.finalize(', caughtDecision);

assert.ok(plannerBranch >= 0 && plannerAwait > plannerBranch && ingest > plannerAwait, 'planner path markers must remain discoverable');
assert.ok(
  source.slice(plannerBranch, plannerAwait).includes(guard),
  'live binding must be checked immediately before starting the deterministic planner',
);
assert.ok(
  source.slice(plannerAwait, ingest).includes(guard),
  'live binding must be rechecked after planner completion and before evidence ingestion',
);

const finalGuard = source.lastIndexOf(guard, finalize);
assert.ok(
  caughtDecision >= 0 && finalize > caughtDecision && finalGuard > caughtDecision,
  'live binding must be rechecked after planner/model error handling and before finalization',
);

const stable = { binaryHash: 'A', projectId: 'P1' };
const stableSnapshot = createTurnSnapshot(stable, {});
assert.doesNotThrow(() => assertLiveBindingsUnchanged(stable, stableSnapshot));

const binaryDrift = { binaryHash: 'A', projectId: 'P1' };
const binarySnapshot = createTurnSnapshot(binaryDrift, {});
binaryDrift.binaryHash = 'B';
assert.throws(
  () => assertLiveBindingsUnchanged(binaryDrift, binarySnapshot),
  (error) => error?.type === 'scope_violation',
  'binary drift must fail closed',
);

const projectDrift = { binaryHash: 'A', projectId: 'P1' };
const projectSnapshot = createTurnSnapshot(projectDrift, {});
projectDrift.projectId = 'P2';
assert.throws(
  () => assertLiveBindingsUnchanged(projectDrift, projectSnapshot),
  (error) => error?.type === 'scope_violation',
  'project drift must fail closed',
);

// Behavioral: real executeTurn must fail closed on planner-induced drift.
// Provider-less so the planner path is the only evidence source; the planner
// stub mutates the live binding mid-await, then resolves a stale plan.
function makeDriftRuntime(local, mutate) {
  const runtime = new AIRuntime({
    context: local,
    provider: null,
    planner: async () => {
      mutate();
      return { candidates: [], best: null, missingEvidence: [] };
    },
  });
  let ingestCalls = 0;
  const origIngest = runtime.evidenceStore.ingestPlan.bind(runtime.evidenceStore);
  runtime.evidenceStore.ingestPlan = (plan) => {
    ingestCalls++;
    return origIngest(plan);
  };
  return {
    runtime,
    ingestCalls: () => ingestCalls,
    assistantMessages: () => runtime.sessionStore.list()
      .flatMap((session) => session.messages || [])
      .filter((message) => message.role === 'assistant'),
  };
}

{
  const local = { binaryHash: 'A', projectId: 'P1' };
  const probe = makeDriftRuntime(local, () => {
    local.binaryHash = 'B';
  });
  await assert.rejects(
    () => probe.runtime.turn({ mode: 'agent', goal: 'find function foo' }),
    (error) => error?.type === 'scope_violation',
    'provider-less binary drift must escape as scope_violation',
  );
  assert.equal(probe.ingestCalls(), 0, 'drifted plan must never be ingested');
  assert.equal(probe.assistantMessages().length, 0, 'drift must publish no assistant evidence');
}

{
  const local = { binaryHash: 'A', projectId: 'P1' };
  const probe = makeDriftRuntime(local, () => {
    local.projectId = 'P2';
  });
  await assert.rejects(
    () => probe.runtime.turn({ mode: 'agent', goal: 'find function foo' }),
    (error) => error?.type === 'scope_violation',
    'provider-less project drift must escape as scope_violation',
  );
  assert.equal(probe.ingestCalls(), 0, 'drifted plan must never be ingested');
  assert.equal(probe.assistantMessages().length, 0, 'drift must publish no assistant evidence');
}

{
  // Latch: an error onActivity that restores the bindings must not convert
  // the violation into a fallback decision. The guard rethrows before any
  // error activity, so restoration cannot mask the drift.
  const local = { binaryHash: 'A', projectId: 'P1' };
  const probe = makeDriftRuntime(local, () => {
    local.binaryHash = 'B';
  });
  await assert.rejects(
    () => probe.runtime.turn(
      { mode: 'agent', goal: 'find function foo' },
      { onActivity: (event) => { if (event?.type === 'error') local.binaryHash = 'A'; } },
    ),
    (error) => error?.type === 'scope_violation',
    'binding restoration via error onActivity must not mask scope_violation',
  );
  assert.equal(probe.ingestCalls(), 0, 'restored plan must never be ingested');
  assert.equal(probe.assistantMessages().length, 0, 'restored drift must publish no assistant evidence');
}

{
  // Stable control: unchanged bindings complete normally through the same fixture.
  const local = { binaryHash: 'A', projectId: 'P1' };
  const runtime = new AIRuntime({
    context: local,
    provider: null,
    planner: async () => ({ candidates: [], best: null, missingEvidence: [] }),
  });
  const result = await runtime.turn({ mode: 'agent', goal: 'find function foo' });
  assert.ok(result?.sessionId, 'stable turn must finalize with a session');
  assert.equal(runtime.sessionStore.list().flatMap((s) => s.messages || []).filter((m) => m.role === 'assistant').length, 1);
}

console.log('issue-4047-ai-planner-binding: ok');
