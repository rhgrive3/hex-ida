import assert from 'node:assert/strict';
import test from 'node:test';

import { assertLiveBindingsUnchanged } from '../../../js/ai/control/runtime-support.js';
import { createTurnSnapshot } from '../../../js/ai/control/snapshot.js';

const strongIdentity = (hash, id = `content:${hash}`) => ({
  id,
  kind: id.startsWith('content:') ? 'content-derived' : 'external',
  confidence: 'strong',
  state: 'ready',
  algorithm: 'existing-hash',
  hash,
  legacyId: null,
});

test('#5769 same strong id with a contradictory content hash is rejected', () => {
  assert.throws(
    () => createTurnSnapshot(
      { binaryIdentity:strongIdentity('bbbb') },
      { binaryIdentity:strongIdentity('aaaa', 'content:bbbb') },
    ),
    (error) => error?.type === 'scope_violation',
  );
});

test('#5769 equal strong content hashes are equivalent across non-content id spellings', () => {
  const snapshot = createTurnSnapshot(
    { binaryHash:'bbbb' },
    { binaryIdentity:strongIdentity('bbbb', 'external:request-B') },
  );
  assert.equal(snapshot.binaryIdentitySource, 'live');
  assert.equal(snapshot.binaryIdentity.hash, 'bbbb');
});

test('#5769 request binaryIdentity and binaryHash assertions must agree', () => {
  assert.throws(
    () => createTurnSnapshot(
      {},
      { binaryIdentity:strongIdentity('aaaa'), binaryHash:'bbbb' },
    ),
    (error) => error?.type === 'scope_violation',
  );
});

test('#5769 content id slice assertion must match the selected slice', () => {
  assert.throws(
    () => createTurnSnapshot(
      { sliceIndex:1 },
      { binaryIdentity:strongIdentity('bbbb', 'content:bbbb:2') },
    ),
    (error) => error?.type === 'scope_violation',
  );
});

test('#5769 mid-turn strong identity drift compares hash authority, not only stable id', () => {
  const snapshot = createTurnSnapshot({ binaryIdentity:strongIdentity('aaaa', 'external:stable') }, {});
  assert.throws(
    () => assertLiveBindingsUnchanged(
      { binaryIdentity:strongIdentity('bbbb', 'external:stable') },
      snapshot,
    ),
    (error) => error?.type === 'scope_violation',
  );
});


test('#5769 mid-turn strong identity equivalence follows matching content hash', () => {
  const snapshot = createTurnSnapshot({ binaryIdentity:strongIdentity('aaaa', 'external:snapshot') }, {});
  assert.doesNotThrow(() => assertLiveBindingsUnchanged(
    { binaryIdentity:strongIdentity('aaaa', 'external:live') },
    snapshot,
  ));
});

test('#5769 same hash cannot make different identity-bound slices equivalent at snapshot binding', () => {
  assert.throws(
    () => createTurnSnapshot(
      { sliceIndex:1, binaryIdentity:strongIdentity('aaaa', 'content:aaaa:0') },
      { binaryIdentity:strongIdentity('aaaa', 'content:aaaa:1') },
    ),
    (error) => error?.type === 'scope_violation',
  );
});

test('#5769 mid-turn slice drift is rejected even when the content hash is unchanged', () => {
  const local = { binaryHash:'aaaa', sliceIndex:0 };
  const snapshot = createTurnSnapshot(local, {});
  local.sliceIndex = 1;
  assert.throws(
    () => assertLiveBindingsUnchanged(local, snapshot),
    (error) => error?.type === 'scope_violation',
  );
});

test('#5769 same hash and same identity-bound slice remain equivalent', () => {
  const snapshot = createTurnSnapshot(
    { sliceIndex:1, binaryIdentity:strongIdentity('aaaa', 'content:aaaa:1') },
    { binaryIdentity:strongIdentity('aaaa', 'content:aaaa:1') },
  );
  assert.equal(snapshot.binaryIdentity.id, 'content:aaaa:1');
});

test('#5769 sliced strong request remains usable when live workbench has no slice authority', () => {
  const snapshot = createTurnSnapshot({}, {
    binaryIdentity:strongIdentity('aaaa', 'content:aaaa:1'),
  });
  assert.equal(snapshot.binaryIdentitySource, 'request-fallback');
  assert.equal(snapshot.binaryIdentity.id, 'content:aaaa:1');
  assert.equal(snapshot.binaryIdentity.hash, 'aaaa');
});
