// Regression for #5769: resolveBinaryIdentity() let a stale/incorrect
// request-side binaryIdentity override the live workbench identity, so the
// snapshot — and therefore session lookup, store namespace selection, session
// writes and planner evidence ingest — aliased another binary before any
// binding guard ran. Any request identity that disagrees with a strong live
// identity now fails closed with scope_violation before side effects,
// regardless of request confidence. A matching request keeps the strong live
// identity authoritative; request values keep their fallback contract only
// when the live context is unbound/weak.
import assert from 'node:assert/strict';
import { resolveBinaryIdentity } from '../js/ai/control/snapshot.js';
import { AIRuntime } from '../js/ai/runtime.js';
import { InvestigationSessionStore } from '../js/ai/session-core/index.js';

const REQUEST_A = { id: 'content:aaaa', kind: 'content-derived', confidence: 'strong', state: 'ready', hash: 'aaaa' };
const REQUEST_A_WEAK = { id: 'content:aaaa', kind: 'external', confidence: 'weak', state: 'ready' };
const REQUEST_B = { id: 'content:bbbb', kind: 'content-derived', confidence: 'strong', state: 'ready', hash: 'bbbb' };
const REQUEST_B_WEAK = { id: 'content:bbbb', kind: 'external', confidence: 'weak', state: 'ready' };
const liveContext = { binaryHash: 'bbbb', binaryId: 'B' };

// 1: live strong B + stale strong request A → scope_violation
assert.throws(
  () => resolveBinaryIdentity(liveContext, { binaryIdentity: REQUEST_A }),
  (error) => error.type === 'scope_violation',
  'a stale strong request identity must not override the live strong identity',
);

// 2: live strong B + stale weak request A → scope_violation
assert.throws(
  () => resolveBinaryIdentity(liveContext, { binaryIdentity: REQUEST_A_WEAK }),
  (error) => error.type === 'scope_violation',
  'a stale weak request identity must not override the live strong identity',
);

// 3: live strong B + matching strong request B → live B remains authoritative
assert.equal(
  resolveBinaryIdentity(liveContext, { binaryIdentity: REQUEST_B }).id,
  'content:bbbb',
);

// 4: matching weak request identity cannot downgrade strong live authority
{
  const resolved = resolveBinaryIdentity(liveContext, { binaryIdentity: REQUEST_B_WEAK });
  assert.equal(resolved.id, 'content:bbbb');
  assert.equal(resolved.confidence, 'strong');
  assert.equal(resolved.kind, 'content-derived');
}

// 5: live strong B + no request identity → live authority
assert.equal(resolveBinaryIdentity(liveContext, {}).id, 'content:bbbb');

// 6: live unbound/weak + explicit request identity → fallback contract preserved
assert.equal(
  resolveBinaryIdentity({}, { binaryIdentity: { id: 'binary-A' } }).id,
  'binary-A',
);

// 7: side effects — a full turn with a stale weak request identity must fail
// closed before any session write, evidence ingest or planner run.
{
  const effects = { sessionWrites: 0, messages: 0, plannerRuns: 0, evidenceIngests: 0 };
  const sessionStore = new InvestigationSessionStore();
  const originalUpdate = sessionStore.update.bind(sessionStore);
  sessionStore.update = async (...args) => { effects.sessionWrites += 1; return originalUpdate(...args); };
  const originalAppend = sessionStore.appendMessage.bind(sessionStore);
  sessionStore.appendMessage = async (...args) => { effects.messages += 1; return originalAppend(...args); };

  let turnError = null;
  try {
    const runtime = new AIRuntime({
      context: liveContext,
      planner: false,
      sessionStore,
      provider: { nextTurn: async () => ({ type: 'final', answer: 'should never run', evidenceIds: [] }) },
    });
    const evidenceIngest = runtime.evidenceStore.ingestPlan.bind(runtime.evidenceStore);
    runtime.evidenceStore.ingestPlan = (...args) => { effects.evidenceIngests += 1; return evidenceIngest(...args); };
    await runtime.turn({ goal: 'この関数は何をする？', binaryIdentity: REQUEST_A_WEAK });
  } catch (error) {
    turnError = error;
  }
  assert.ok(turnError, 'the turn must not complete under a stale binary identity');
  assert.equal(turnError.type, 'scope_violation', `expected scope_violation, saw ${turnError?.type}: ${turnError?.message}`);
  assert.equal(effects.sessionWrites, 0, 'no session update may happen before the binding check');
  assert.equal(effects.messages, 0, 'no user message may be appended to the wrong-binary session');
  assert.equal(effects.evidenceIngests, 0, 'no planner evidence may be ingested into the wrong namespace');
}
