// Regression for #6216: executeTurn() projected the per-session stores onto
// shared runtime fields (`this.evidenceStore` / `this.hypothesisStore` /
// `this.proposalStore`) and then re-read those fields across awaits. Two
// concurrent turns on one runtime therefore finalized against whichever
// namespace was assigned last: turn A's hypotheses could be upserted into
// turn B's store and A's result could publish B's state. The execution path
// now uses the turn's own captured namespace; the shared fields remain only a
// post-turn introspection pointer.
import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';

let providerCalls = 0;
let releaseA;
const gateA = new Promise((resolve) => { releaseA = resolve; });

const runtime = new AIRuntime({
  context: {},
  planner: false,
  provider: {
    async nextTurn() {
      const call = ++providerCalls;
      if (call === 2) await gateA; // turn A parks here, after store resolution
      return {
        type: 'final',
        answer: `answer ${call}`,
        confidence: 0.9,
        evidenceIds: [],
        hypotheses: call === 1 ? [] : [{ id: call === 2 ? 'hyp-A' : 'hyp-B', claim: `claim ${call}`, status: 'open' }],
        followups: [],
      };
    },
  },
});

// Prime one session (and its namespace) sequentially, so turn A deterministically
// reuses that namespace regardless of the concurrent turns' scheduling.
const primed = await runtime.turn({ mode: 'agent', goal: 'prime' });
const primedSessionId = primed.sessionId;

const turnA = runtime.turn({ sessionId: primedSessionId, mode: 'agent', goal: 'probe A' });
while (providerCalls < 2) await new Promise((resolve) => setTimeout(resolve, 5));
const turnB = runtime.turn({ mode: 'agent', goal: 'probe B' });
const b = await turnB;
releaseA();
const a = await turnA;

assert.deepEqual(a.hypotheses.map((item) => item.id), ['hyp-A'],
  'turn A must finalize against its own namespace (got ' + JSON.stringify(a.hypotheses.map((item) => item.id)) + ')');
assert.deepEqual(b.hypotheses.map((item) => item.id), ['hyp-B'],
  'turn B must finalize against its own namespace');
assert.equal(a.hypotheses.some((item) => item.id === 'hyp-B'), false,
  'turn A must not publish turn B hypothesis state');

// The two turns must have finalized into distinct stores.
const aNamespaceStore = [...runtime.storeNamespaces.entries()]
  .find(([key]) => key.endsWith(`::${primedSessionId}`))?.[1]?.hypothesisStore;
assert.ok(aNamespaceStore, 'the primed session namespace must exist');
assert.ok([...runtime.storeNamespaces.values()].some((stores) => stores.hypothesisStore === aNamespaceStore));
assert.deepEqual(aNamespaceStore.all().map((item) => item.id), ['hyp-A'],
  'turn A namespace holds exactly turn A hypothesis state');
