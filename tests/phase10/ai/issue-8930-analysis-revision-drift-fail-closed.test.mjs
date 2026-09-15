import assert from 'node:assert/strict';
import test from 'node:test';

import { AIRuntime } from '../../../js/ai/runtime.js';
import { createTurnSnapshot, createSnapshotContext, resolveAnalysisRevision } from '../../../js/ai/control/snapshot.js';
import { assertAnalysisRevisionUnchanged } from '../../../js/ai/control/turn-executor.js';

function makeLocal(extra = {}) {
  return {
    binaryHash: 'hash-a',
    binaryId: 'bin-a',
    projectId: 'proj-a',
    currentAddress: 0x1000n,
    analysisRevision: 'r1',
    ...extra,
  };
}

function finalDecision(extra = {}) {
  return {
    type: 'final', answer: 'ok', confidence: 0.2,
    evidenceIds: [], hypothesisIds: [], hypotheses: [],
    suggestedActions: [], proposals: [], followups: [],
    ...extra,
  };
}

function assistantMessages(runtime) {
  return runtime.sessionStore.list()
    .flatMap((session) => session.messages || [])
    .filter((message) => message.role === 'assistant');
}

test('#8930 snapshot captures canonical analysis revision and snapshot context pins it', () => {
  const local = makeLocal({ analysisRevision: 'r1' });
  const snapshot = createTurnSnapshot(local, { scope: 'auto' });
  local.analysisRevision = 'r2';
  const context = createSnapshotContext(local, snapshot);
  assert.equal(snapshot.analysisRevision, 'r1');
  assert.equal(context.analysisRevision, 'r1');
  assert.throws(() => assertAnalysisRevisionUnchanged(local, snapshot), (error) => error?.type === 'scope_violation');
});

test('#8930 structured/malformed analysis revision is never String-coerced into authority', () => {
  assert.equal(resolveAnalysisRevision({ analysisRevision: { id: 'r1' } }), null);
  assert.equal(resolveAnalysisRevision({ analysisRevision: ['r1'] }), null);
  assert.equal(resolveAnalysisRevision({ analysisRevision: NaN }), null);
  assert.equal(resolveAnalysisRevision({ analysisRevision: 7 }), '7');
  assert.equal(resolveAnalysisRevision({ analysisRevision: 7n }), '7');
});

test('#8930 planner await drift fails before plan/evidence ingestion and assistant persistence', async () => {
  const local = makeLocal();
  const runtime = new AIRuntime({
    context: local,
    provider: null,
    planner: async () => {
      await Promise.resolve();
      local.analysisRevision = 'r2';
      return { candidates: [], best: null, missingEvidence: [], evidence: [], stats: { analyzedFunctions: 0, disassembly: 0 } };
    },
  });
  let ingests = 0;
  const original = runtime.evidenceStore.ingestPlan.bind(runtime.evidenceStore);
  runtime.evidenceStore.ingestPlan = (...args) => { ingests++; return original(...args); };
  await assert.rejects(
    () => runtime.turn({ mode: 'agent', goal: 'find function foo', scope: 'project' }),
    (error) => error?.type === 'scope_violation',
  );
  assert.equal(ingests, 0);
  assert.equal(assistantMessages(runtime).length, 0);
});

test('#8930 model await drift rejects the model result before adoption', async () => {
  const local = makeLocal();
  const runtime = new AIRuntime({
    context: local,
    planner: false,
    provider: {
      getCapabilities() { return { contextTokens: 32768, maxOutputTokens: 4096, maxTools: 10, maxRequestBytes: 65536 }; },
      async nextTurn() {
        await Promise.resolve();
        local.analysisRevision = 'r2';
        return finalDecision();
      },
    },
  });
  await assert.rejects(
    () => runtime.turn({ mode: 'agent', goal: 'explain this function', scope: 'auto', budget: { maxModelCalls: 1 } }),
    (error) => error?.type === 'scope_violation',
  );
  assert.equal(assistantMessages(runtime).length, 0);
});

test('#8930 tool await drift fails before ToolRegistry publishes observation/evidence', async () => {
  const local = makeLocal({
    async searchFunctions() {
      await Promise.resolve();
      local.analysisRevision = 'r2';
      return { results: [], total: 0, complete: true };
    },
  });
  const runtime = new AIRuntime({
    context: local,
    planner: false,
    provider: {
      getCapabilities() { return { contextTokens: 32768, maxOutputTokens: 4096, maxTools: 10, maxRequestBytes: 65536 }; },
      async nextTurn() {
        return { type: 'tool', tool: 'search_functions', arguments: { query: 'foo' }, purpose: 'locate candidate' };
      },
    },
  });
  let evidenceIngests = 0;
  const originalIngest = runtime.evidenceStore.ingest.bind(runtime.evidenceStore);
  runtime.evidenceStore.ingest = (...args) => { evidenceIngests++; return originalIngest(...args); };
  await assert.rejects(
    () => runtime.turn({ mode: 'agent', goal: 'find foo', scope: 'auto', budget: { maxModelCalls: 2, maxToolCalls: 2 } }),
    (error) => error?.type === 'scope_violation',
  );
  assert.equal(evidenceIngests, 0, 'stale tool output must not enter EvidenceStore');
  assert.equal(assistantMessages(runtime).length, 0);
});

test('#8930 finalize/address-validation await drift rejects before proposal/action publication', async () => {
  const local = makeLocal({
    async addressExists() {
      await Promise.resolve();
      local.analysisRevision = 'r2';
      return true;
    },
  });
  const runtime = new AIRuntime({
    context: local,
    planner: false,
    provider: {
      getCapabilities() { return { contextTokens: 32768, maxOutputTokens: 4096, maxTools: 10, maxRequestBytes: 65536 }; },
      async nextTurn() {
        return finalDecision({
          suggestedActions: [{ kind: 'open-function', target: '0x1000' }],
          proposals: [{ kind: 'rename', target: '0x1000', before: 'old', after: 'new', evidenceIds: ['ev-stale'] }],
        });
      },
    },
  });
  let proposalCreates = 0;
  const originalCreate = runtime.proposalStore.create.bind(runtime.proposalStore);
  runtime.proposalStore.create = (...args) => { proposalCreates++; return originalCreate(...args); };
  await assert.rejects(
    () => runtime.turn({ mode: 'agent', goal: 'review target', scope: 'auto', budget: { maxModelCalls: 1 } }),
    (error) => error?.type === 'scope_violation',
  );
  assert.equal(proposalCreates, 0, 'drift during address validation must stop before ProposalStore publication');
  assert.equal(assistantMessages(runtime).length, 0);
});

test('#8930 persistence await drift cannot complete normally or continue later final writes', async () => {
  const local = makeLocal();
  const runtime = new AIRuntime({
    context: local,
    planner: false,
    provider: { async nextTurn() { return finalDecision(); } },
  });
  const originalAppend = runtime.sessionStore.appendMessage.bind(runtime.sessionStore);
  const originalUpdateMemory = runtime.sessionStore.updateMemory.bind(runtime.sessionStore);
  let finalMemoryWrites = 0;
  runtime.sessionStore.appendMessage = async (id, message) => {
    if (message.role === 'assistant') {
      await Promise.resolve();
      local.analysisRevision = 'r2';
    }
    return originalAppend(id, message);
  };
  runtime.sessionStore.updateMemory = async (id, patch) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'confirmedFacts')) finalMemoryWrites++;
    return originalUpdateMemory(id, patch);
  };
  await assert.rejects(
    () => runtime.turn({ mode: 'chat', goal: 'explain', scope: 'auto', budget: { maxModelCalls: 1 } }),
    (error) => error?.type === 'scope_violation',
  );
  assert.equal(finalMemoryWrites, 0, 'post-write freshness failure must stop later persistence');
});

test('#8930 unchanged revision preserves normal turn behavior', async () => {
  const local = makeLocal();
  const runtime = new AIRuntime({
    context: local,
    planner: false,
    provider: { async nextTurn() { return finalDecision(); } },
  });
  const result = await runtime.turn({ mode: 'chat', goal: 'explain', scope: 'auto', budget: { maxModelCalls: 1 } });
  assert.ok(result.sessionId);
  assert.equal(assistantMessages(runtime).length, 1);
});
