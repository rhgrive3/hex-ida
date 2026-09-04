import assert from 'node:assert/strict';
import { createTurnSnapshot, resolveBinaryIdentity } from '../js/ai/control/snapshot.js';
import { assertLiveBindingsUnchanged, memoryAnchor } from '../js/ai/control/runtime-support.js';

const fallbackBindingLocal = {
  binaryHash:'hash-a',
  projectId:0,
  project:{ id:'project-a' },
  runtimeSession:{ id:0 },
  runtime:{ sessionId:'session-a' },
  runtimeSessionKnown:true,
};
const fallbackBindingSnapshot = createTurnSnapshot(fallbackBindingLocal, {});
assert.equal(fallbackBindingSnapshot.projectIdentity, 'project-a');
assert.equal(fallbackBindingSnapshot.runtimeSessionIdentity, 'session-a');
assert.doesNotThrow(() => assertLiveBindingsUnchanged(fallbackBindingLocal, fallbackBindingSnapshot));
const fallbackAnchor = memoryAnchor({
  ...fallbackBindingSnapshot,
  runtimeSessionIdentity:null,
  runtimeSessionState:'unknown',
}, 'runtime', fallbackBindingLocal);
assert.equal(fallbackAnchor.runtimeSessionId, 'session-a');
assert.equal(fallbackAnchor.runtimeSessionState, 'bound');

const numericSlice = resolveBinaryIdentity({ binaryHash:'hash-a', sliceIndex:1 }, {});
const stringSlice = resolveBinaryIdentity({ binaryHash:'hash-a', sliceIndex:'1' }, {});
assert.equal(numericSlice.id, 'content:hash-a:1');
assert.equal(stringSlice.id, numericSlice.id, 'canonical primitive slice representations must agree');
for (const invalidSlice of [['1'], { value:1 }, -1, -1n, true]) {
  const identity = resolveBinaryIdentity({ binaryHash:'hash-a', sliceIndex:invalidSlice }, {});
  assert.equal(identity.id, 'fallback:unbound');
  assert.equal(identity.confidence, 'none', 'malformed explicit slice state must not mint a strong content binding');
}

await import('./ai-analysis-boundary-base.mjs');
await import('./ai-query-authority-cutover.mjs');
await import('./issue-3189-causal-budget-strict.mjs');
await import('./issue-3341-3343-proposal-id-boundaries.mjs');
await import('./issue-3352-sanitize-action-identities.mjs');
await import('./issue-3364-wait-retry-abort-race.mjs');
await import('./issue-3384-glossary-onopen-callability.mjs');
await import('./issue-3387-3305-agent-runtime-boundaries.mjs');
await import('./issues-6311-6312-ai-budget.mjs');
// Exact-head CI retrigger marker; no runtime effect.
