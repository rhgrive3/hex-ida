import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTurnSnapshot } from '../../../js/ai/control/snapshot.js';
import { assertLiveBindingsUnchanged } from '../../../js/ai/control/runtime-support.js';
import { AIRuntime } from '../../../js/ai/runtime.js';

const source = await readFile(new URL('../../../js/ai/control/turn-executor.js', import.meta.url), 'utf8');
const guard = 'assertLiveBindingsUnchanged(this.localContext, snapshot);';
const plannerBranch = source.indexOf('if (this.planner && shouldRunPlanner(request, snapshot, intent))');
const plannerAwait = source.indexOf('plan = await this.planner(', plannerBranch);
const ingest = source.indexOf('const plannedEvidence = evidenceStore.ingestPlan(plan);', plannerAwait);
const caughtDecision = source.indexOf('if (!decision) decision = deterministicDecision(plan, request, normalized);', ingest);
const finalize = source.indexOf('const result = await this.finalize(', caughtDecision);

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
  // A binding switch while the first final persistence operation is pending
  // must fail closed before later memory/result writes or a normal return.
  const local = { binaryHash: 'A', projectId: 'P1' };
  const runtime = new AIRuntime({
    context: local,
    provider: null,
    planner: async () => ({ candidates: [], best: null, missingEvidence: [] }),
  });
  const originalAppend = runtime.sessionStore.appendMessage.bind(runtime.sessionStore);
  const originalUpdateMemory = runtime.sessionStore.updateMemory.bind(runtime.sessionStore);
  const originalUpdate = runtime.sessionStore.update.bind(runtime.sessionStore);
  let finalMemoryWrites = 0;
  let finalResultWrites = 0;
  runtime.sessionStore.appendMessage = async (id, message) => {
    if (message.role === 'assistant') {
      await Promise.resolve();
      local.binaryHash = 'B';
    }
    return originalAppend(id, message);
  };
  runtime.sessionStore.updateMemory = async (id, patch) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'confirmedFacts')) finalMemoryWrites++;
    return originalUpdateMemory(id, patch);
  };
  runtime.sessionStore.update = async (id, patch) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'confirmedFindings')) finalResultWrites++;
    return originalUpdate(id, patch);
  };
  await assert.rejects(
    () => runtime.turn({ mode: 'agent', goal: 'find function foo' }),
    (error) => error?.type === 'scope_violation',
    'post-finalization binding drift must escape as scope_violation',
  );
  assert.equal(finalMemoryWrites, 0, 'binding drift must stop before final memory update');
  assert.equal(finalResultWrites, 0, 'binding drift must stop before final result update');
}

{
  // A rejected final write still runs the post-write binding guard. When the
  // binding drifted before rejection, scope_violation must win over the write
  // error rather than allowing stale completion to escape.
  const local = { binaryHash: 'A', projectId: 'P1' };
  const runtime = new AIRuntime({
    context: local,
    provider: null,
    planner: async () => ({ candidates: [], best: null, missingEvidence: [] }),
  });
  const originalAppend = runtime.sessionStore.appendMessage.bind(runtime.sessionStore);
  const writeError = new Error('append failed');
  runtime.sessionStore.appendMessage = async (id, message) => {
    if (message.role === 'assistant') {
      local.binaryHash = 'B';
      throw writeError;
    }
    return originalAppend(id, message);
  };
  await assert.rejects(
    () => runtime.turn({ mode: 'agent', goal: 'find function foo' }),
    (error) => error?.type === 'scope_violation',
    'binding drift on a rejected final write must fail closed',
  );
}

{
  // If the binding is stable, the original persistence rejection must remain
  // observable to the caller.
  const local = { binaryHash: 'A', projectId: 'P1' };
  const runtime = new AIRuntime({
    context: local,
    provider: null,
    planner: async () => ({ candidates: [], best: null, missingEvidence: [] }),
  });
  const originalAppend = runtime.sessionStore.appendMessage.bind(runtime.sessionStore);
  const writeError = new Error('append failed');
  runtime.sessionStore.appendMessage = async (id, message) => {
    if (message.role === 'assistant') throw writeError;
    return originalAppend(id, message);
  };
  await assert.rejects(
    () => runtime.turn({ mode: 'agent', goal: 'find function foo' }),
    (error) => error === writeError,
    'stable rejected final write must preserve the original rejection',
  );
}

{
  // A runtime identity observed after the snapshot must not be re-read into
  // the old turn's memory anchor.
  const local = { binaryHash: 'A', projectId: 'P1', runtimeSessionKnown: false };
  const runtime = new AIRuntime({
    context: local,
    provider: null,
    planner: async () => ({ candidates: [], best: null, missingEvidence: [] }),
  });
  const originalUpdateMemory = runtime.sessionStore.updateMemory.bind(runtime.sessionStore);
  let finalMemoryPatch = null;
  runtime.sessionStore.updateMemory = async (id, patch) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'confirmedFacts')) {
      local.runtimeSessionKnown = true;
      local.runtimeSessionId = 'runtime-new';
      finalMemoryPatch = patch;
    }
    return originalUpdateMemory(id, patch);
  };
  const result = await runtime.turn({ mode: 'agent', goal: 'find function foo' });
  assert.ok(result?.sessionId, 'stable binary/project turn must complete');
  assert.equal(finalMemoryPatch?.anchor?.runtimeSessionId, null,
    'final memory must retain snapshot-only unknown runtime identity');
  assert.equal(finalMemoryPatch?.anchor?.runtimeSessionState, 'unknown',
    'final memory must retain snapshot-only runtime state');
}

{
  // Stable control: unchanged bindings complete normally through the same fixture.
  const local = { binaryHash: 'A', projectId: 'P1' };
  const probe = makeDriftRuntime(local, () => {});
  const result = await probe.runtime.turn({ mode: 'agent', goal: 'find function foo' });
  assert.ok(result?.sessionId, 'stable turn must finalize with a session');
  assert.equal(probe.ingestCalls(), 1, 'stable plan must reach the turn-local evidence store');
  assert.equal(probe.assistantMessages().length, 1);
}

console.log('issue-4047-ai-planner-binding: ok');
