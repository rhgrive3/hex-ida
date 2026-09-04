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

const workflow = fs.readFileSync(new URL('../../../.github/workflows/ui-regression.yml', import.meta.url), 'utf8');
for (const path of [
  'js/ai/control/snapshot.js',
  'js/ai/dev/ui/controls.js',
  'tests/ai-ui-dev-profile.mjs',
]) {
  assert.match(workflow, new RegExp(`^\\s*- ['"]${path.replaceAll('/', '\\/')}['"]$`, 'm'), `UI workflow must trigger for ${path}`);
}

console.log('t051 snapshot binding and workflow contracts: PASS');
