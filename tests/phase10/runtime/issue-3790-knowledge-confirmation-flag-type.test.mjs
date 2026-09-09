import assert from 'node:assert/strict';
import test from 'node:test';

import { KnowledgeDB } from '../../../js/knowledge/index.js';

const fixture = {
  architecture: 'arm64',
  address: 0x1000n,
  size: 1,
  bytes: new Uint8Array([0]),
  name: 'candidate',
};

function freshDb() {
  return new KnowledgeDB({ indexedDB:null, memory:new Map(), negativeMemory:new Map() });
}

const malformedValues = [false, null, undefined, 'false', 'true', {}, [], 1];

for (const flag of ['userConfirmed', 'debuggerConfirmed', 'metadataConfirmed']) {
  test(`#3790 ${flag} accepts authority only from literal true`, async () => {
    for (const value of malformedValues) {
      const db = freshDb();
      const record = await db.remember({ ...fixture, [flag]:value });
      assert.equal(record.confirmation, 'weak-inferred', `${flag}=${String(value)} must remain unconfirmed`);
      assert.equal(record.confidence, 0.5, 'malformed flags must not receive confirmation confidence');
      assert.equal(record.userConfirmed, false);

      const matches = await db.findMatches(fixture, { threshold:0 });
      assert.equal(matches.length, 1);
      assert.ok(matches[0].confidence < 0.82, 'malformed confirmation must not gain confirmed matching authority');
      assert.equal((await db.propagate(fixture)).propagated, false, 'malformed confirmation must not propagate as confirmed knowledge');
    }

    const confirmed = await freshDb().remember({ ...fixture, [flag]:true });
    const expected = flag === 'userConfirmed' ? 'user-confirmed'
      : flag === 'debuggerConfirmed' ? 'debugger-confirmed'
      : 'metadata-confirmed';
    assert.equal(confirmed.confirmation, expected);
    assert.equal(confirmed.confidence, flag === 'metadataConfirmed' ? 0.95 : 1);
  });
}

test('#3790 canonical confirmation enum remains authoritative', async () => {
  for (const confirmation of ['user-confirmed', 'debugger-confirmed', 'metadata-confirmed']) {
    const record = await freshDb().remember({ ...fixture, confirmation });
    assert.equal(record.confirmation, confirmation);
    assert.equal(record.confidence, confirmation === 'metadata-confirmed' ? 0.95 : 1);
  }
});
