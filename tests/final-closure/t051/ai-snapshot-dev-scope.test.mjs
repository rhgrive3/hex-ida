import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  canonicalBindingId,
  createTurnSnapshot,
  firstBinding,
  resolveBinaryIdentity,
} from '../../../js/ai/control/snapshot.js';
import * as runtimeSupport from '../../../js/ai/control/runtime-support.js';

assert.equal(typeof runtimeSupport.sessionMatchesSnapshot, 'function', 'runtime-support must link its snapshot imports');
assert.equal(typeof runtimeSupport.assertLiveBindingsUnchanged, 'function', 'runtime-support must expose its binding checks');

// Binding IDs accept only non-empty primitive strings and use one canonical
// trim rule at every snapshot/session boundary.
assert.equal(canonicalBindingId('  binding-A  '), 'binding-A');
for (const value of [null, undefined, '', '   ', 0, 1n, true, {}, [], new String('binding')]) {
  assert.equal(canonicalBindingId(value), null, `non-primitive binding accepted: ${String(value)}`);
}
assert.equal(firstBinding({ id: 'forged' }, '  binding-B  ', 'binding-C'), 'binding-B');
assert.equal(firstBinding('', {}, 0, null), null);

// A malformed higher-priority source cannot hide a later valid source.
const selected = createTurnSnapshot({
  binaryHash: { sha256: 'not-a-primitive-binding' },
  binaryFingerprint: { hash: 'sha256:real' },
  projectId: { id: 'not-a-binding' },
  project: { id: 'project:real' },
  runtimeSession: { id: { value: 'not-a-binding' } },
  runtime: { sessionId: 'runtime:real' },
  runtimeSessionKnown: true,
});
assert.equal(selected.binaryIdentity.id, 'content:sha256:real');
assert.equal(selected.projectIdentity, 'project:real');
assert.equal(selected.runtimeSessionIdentity, 'runtime:real');

// Numeric/string slice spellings canonicalize to one identity, while distinct
// slices remain distinct and malformed explicit slice state fails closed.
assert.equal(resolveBinaryIdentity({ binaryHash: 'sha256:bundle', sliceIndex: 1 }).id, 'content:sha256:bundle:1');
assert.equal(resolveBinaryIdentity({ binaryHash: 'sha256:bundle', sliceIndex: ' 01 ' }).id, 'content:sha256:bundle:1');
const sliceZero = resolveBinaryIdentity({ binaryHash: 'sha256:bundle', sliceIndex: 0 });
const sliceOne = resolveBinaryIdentity({ binaryHash: 'sha256:bundle', sliceIndex: 1 });
assert.notEqual(sliceZero.id, sliceOne.id, 'distinct binary slices must not share an identity');
for (const slice of [['1'], { value: 1 }, -1, -1n, true]) {
  const identity = resolveBinaryIdentity({ binaryHash: 'sha256:bundle', sliceIndex: slice });
  assert.equal(identity.id, 'fallback:unbound');
  assert.equal(identity.confidence, 'none');
  assert.equal(identity.state, 'hash-unavailable');
}

// An explicit structured identity with malformed fields is rejected rather
// than defaulted into strong authority. A legacy ID may still provide a weak
// fallback, but it must not preserve the forged content identity.
const malformedExplicit = resolveBinaryIdentity({
  binaryIdentity: {
    id: 'content:forged',
    kind: 'content-derived',
    confidence: 'strong',
    state: 'ready',
    hash: { sha256: 'forged' },
  },
  binaryId: 'legacy:bundle',
});
assert.equal(malformedExplicit.id, 'fallback:legacy:bundle');
assert.equal(malformedExplicit.confidence, 'weak');
assert.notEqual(malformedExplicit.id, 'content:forged');

const validExplicit = resolveBinaryIdentity({
  binaryIdentity: {
    id: 'content:validated',
    kind: 'content-derived',
    confidence: 'strong',
    state: 'ready',
    hash: 'sha256:validated',
    legacyId: 'legacy:validated',
  },
});
assert.equal(validExplicit.id, 'content:validated');
assert.equal(validExplicit.hash, 'sha256:validated');

// The UI bridge constructs this structured identity with String(slice), while
// exposing the raw slice separately. Snapshot creation must bind both fields
// to one canonical slice before allowing a strong content identity through.
function bridgeLocal(slice) {
  const store = { sliceIndex: slice };
  const local = {};
  Object.defineProperties(local, {
    binaryFingerprint: { enumerable: true, get: () => ({ algorithm: 'content-hash', hash: 'sha256:bridge' }) },
    binaryHash: { enumerable: true, get: () => local.binaryFingerprint?.hash || null },
    binaryIdentity: {
      enumerable: true,
      get: () => {
        const fingerprint = local.binaryFingerprint;
        if (!fingerprint?.hash) return null;
        const rawSlice = store.sliceIndex;
        const hash = String(fingerprint.hash);
        return {
          id: `content:${hash}${rawSlice == null ? '' : `:${String(rawSlice)}`}`,
          kind: 'content-derived', confidence: 'strong', state: 'ready',
          algorithm: String(fingerprint.algorithm || 'existing-hash'), hash,
          legacyId: null,
        };
      },
    },
    sliceIndex: { enumerable: true, get: () => store.sliceIndex },
  });
  return { local, store };
}

const bridge = bridgeLocal(' 01 ');
const bridgeSnapshot = createTurnSnapshot(bridge.local, {});
assert.equal(bridgeSnapshot.binaryIdentity.id, 'content:sha256:bridge:1');
assert.equal(bridgeSnapshot.slice, '1');
assert.equal(bridgeSnapshot.binaryIdentity.confidence, 'strong');

const reorderedBridge = createTurnSnapshot({
  binaryHash: 'sha256:bridge',
  binaryIdentity: {
    id: 'content:sha256:bridge:2', kind: 'content-derived', confidence: 'strong', state: 'ready',
    algorithm: 'content-hash', hash: 'sha256:bridge', legacyId: null,
  },
  sliceIndex: 1,
}, {});
assert.equal(reorderedBridge.binaryIdentity.id, 'content:sha256:bridge:1');
assert.equal(reorderedBridge.slice, '1');

bridge.store.sliceIndex = ['1'];
const malformedBridge = createTurnSnapshot(bridge.local, {});
assert.equal(malformedBridge.binaryIdentity.id, 'fallback:unbound');
assert.equal(malformedBridge.binaryIdentity.confidence, 'none');
assert.equal(malformedBridge.slice, null);

const workflow = fs.readFileSync(new URL('../../../.github/workflows/ui-regression.yml', import.meta.url), 'utf8');
for (const path of [
  'js/ai/control/snapshot.js',
  'js/ai/dev/ui/controls.js',
  'tests/ai-ui-dev-profile.mjs',
]) {
  assert.match(workflow, new RegExp(`^\\s*- ['"]${path.replaceAll('/', '\\/')}['"]$`, 'm'), `UI workflow must trigger for ${path}`);
}

console.log('t051 snapshot binding and workflow contracts: PASS');
