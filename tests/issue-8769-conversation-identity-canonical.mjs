// Issue #8769 regression: conversation identity used for AI session/memory/job
// binding must be a canonical primitive value (null or a non-empty string).
// Generic String() coercion let a structured value such as ['A'] alias into the
// legitimate conversation 'A': it could resume A's InvestigationSession,
// delete/forget A's binding, enter AgentJob checkpoints, and flow back through
// the resume/binding paths. The shared contract now lives in
// js/ai/conversation-identity.js and is enforced at every declared boundary.
import assert from 'node:assert/strict';
import { canonicalConversationId, isCanonicalConversationId } from '../js/ai/conversation-identity.js';
import { createInvestigationSession } from '../js/ai/session-core/index.js';
import { AgentJobManager } from '../js/ai/jobs/index.js';
import { createAiEngine } from '../js/ai/ui/bridge.js';

// 1. The shared canonicalizer itself: primitive-only, never calls toString().
assert.equal(canonicalConversationId(null), null);
assert.equal(canonicalConversationId(undefined), null);
assert.equal(canonicalConversationId('A'), 'A');
assert.equal(isCanonicalConversationId('A'), true);
assert.equal(isCanonicalConversationId(''), false);
assert.equal(isCanonicalConversationId(['A']), false);
for (const invalid of [['A'], {}, 42, true, Symbol('A'), '', { toString: () => 'A' }]) {
  assert.throws(() => canonicalConversationId(invalid), TypeError, `structured/typed value must be rejected: ${typeof invalid}`);
}
let toStringCalls = 0;
assert.throws(() => canonicalConversationId({ toString() { toStringCalls += 1; return 'A'; } }), TypeError);
assert.equal(toStringCalls, 0, 'rejection must not invoke attacker-controlled toString()');

// 2. createInvestigationSession accepts canonical IDs only.
{
  const session = createInvestigationSession({ binaryId: 'bin', projectId: null, conversationId: 'A' });
  assert.equal(session.conversationId, 'A');
  assert.equal(createInvestigationSession({ binaryId: 'bin', conversationId: null }).conversationId, null);
  assert.throws(() => createInvestigationSession({ binaryId: 'bin', conversationId: ['A'] }), TypeError);
  assert.throws(() => createInvestigationSession({ binaryId: 'bin', conversationId: 7 }), TypeError);
}

// 3. AgentJobManager.create rejects structured conversation IDs, persists
//    canonical ones, and validateCheckpoint refuses structured resume input.
{
  const saved = new Map();
  const jobs = new AgentJobManager({
    runtime: { async turn() { return { sessionId: 'session-1', evidence: [], hypotheses: [], activity: [] }; } },
    persistence: {
      async save(job) { saved.set(job.id, job); },
      async load(id) { return saved.get(id) || null; },
    },
  });
  await assert.rejects(() => jobs.create({ goal: 'g', conversationId: ['A'] }), TypeError);
  await assert.rejects(() => jobs.create({ goal: 'g', conversationId: { toString: () => 'A' } }), TypeError);
  const created = await jobs.create({ goal: 'g', conversationId: 'A' });
  assert.equal(created.conversationId, 'A');
  saved.set('tampered', { ...created, id: 'tampered', conversationId: ['A'] });
  assert.equal(await jobs.load('tampered'), null, 'a persisted checkpoint with a structured conversationId must not validate');
  saved.set('numeric', { ...created, id: 'numeric', conversationId: 7 });
  assert.equal(await jobs.load('numeric'), null);
}

// 4. The UI bridge boundary: run/delete/forget/persisted-exact-match.
{
  const calls = [];
  const app = {
    store: { get(key) { if (key === 'fileInfo') return { name: 'fixture' }; if (key === 'sliceIndex') return 0; if (key === 'regions') return []; return null; } },
    notes: { structs: [] }, symbols: null, recognition: { records: [] }, stringIndex: [],
    workspace: {
      project: {
        id: 'project-1',
        findings: {
          investigationSessions: [{
            id: 'session-A', conversationId: 'A', binaryId: 'fixture:0', projectId: null,
            investigationMemory: { goal: 'A only', confirmedFacts: [], activeHypotheses: [] },
            messages: [{ role: 'user', content: 'A question' }],
          }],
        },
      },
      autosave() {},
    },
  };
  const core = {
    async turn(input) { calls.push({ ...input }); return { sessionId: input.sessionId || 'session-new', answer: 'ok' }; },
  };
  const engine = createAiEngine(app, { loadCore: async () => core });
  const base = { question: 'test', mode: 'chat', style: 'analyst', scope: 'auto' };

  // Canonical resume keeps working (#8769 acceptance 1/10).
  await engine.run({ ...base, conversationId: 'A' });
  assert.equal(calls[0].sessionId, 'session-A', 'canonical A still exact-matches its persisted session');

  // Structured identities never alias into A (acceptance 2/4).
  await assert.rejects(() => engine.run({ ...base, conversationId: ['A'] }), TypeError);
  await assert.rejects(() => engine.run({ ...base, conversationId: { toString: () => 'A' } }), TypeError);
  await assert.rejects(() => engine.run({ ...base, conversationId: 65 }), TypeError);
  assert.equal(calls.length, 1, 'rejected identities must not reach the runtime at all');

  // Delete/forget must not touch canonical bindings (acceptance 5).
  await assert.rejects(() => engine.deleteSession(['A']), TypeError);
  assert.throws(() => engine.forgetAIConversation(['A']), TypeError);
  calls.length = 0;
  await engine.run({ ...base, conversationId: 'A' });
  assert.equal(calls[0].sessionId, 'session-A', 'the canonical binding must survive structured delete attempts');

  // createAgentJob binds canonical IDs only (acceptance 7/9).
  await assert.rejects(() => engine.createAgentJob({ goal: 'g', conversationId: ['A'] }), TypeError);
}

// 5. bindJobSession only maps validated canonical checkpoint identities.
{
  const calls = [];
  const app = {
    store: { get(key) { if (key === 'fileInfo') return { name: 'fixture' }; if (key === 'sliceIndex') return 0; if (key === 'regions') return []; return null; } },
    notes: { structs: [] }, symbols: null, recognition: { records: [] }, stringIndex: [],
  };
  const core = {
    async turn(input) { calls.push({ ...input }); return { sessionId: input.sessionId || 'session-run', answer: 'ok' }; },
    createJob: async (input) => { calls.push({ create: true, conversationId: input.conversationId }); return { id: 'job-1', conversationId: input.conversationId }; },
    runJobSlice: async () => ({ id: 'job-1', sessionId: 'session-from-job', conversationId: ['A'] }),
  };
  const engine = createAiEngine(app, { loadCore: async () => core });
  await assert.rejects(() => engine.runAgentJobSlice('job-1'), TypeError, 'a structured checkpoint identity must not be bound');
}

console.log('issue-8769 canonical conversation identity: ok');
