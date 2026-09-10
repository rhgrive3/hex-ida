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
  return new KnowledgeDB({ indexedDB: null, memory: new Map(), negativeMemory: new Map() });
}

test('#3790 malformed confirmation flags do not mint confirmed authority', async () => {
  const malformed = ['false', 'true', {}, [], 1];
  const flags = ['userConfirmed', 'debuggerConfirmed', 'metadataConfirmed'];
  let id = 0;
  for (const flag of flags) {
    for (const value of malformed) {
      const db = freshDb();
      const record = await db.remember({ ...fixture, id: `malformed-${id++}`, [flag]: value });
      assert.equal(record.confirmation, 'weak-inferred', `${flag}=${String(value)}`);
      assert.equal(record.confidence, 0.5, `${flag}=${String(value)}`);
      assert.equal(record.userConfirmed, false, `${flag}=${String(value)}`);
    }
  }
});

test('#3790 literal true and canonical confirmation enum retain existing authority', async () => {
  for (const [input, confirmation, confidence, userConfirmed] of [
    [{ userConfirmed:true }, 'user-confirmed', 1, true],
    [{ debuggerConfirmed:true }, 'debugger-confirmed', 1, false],
    [{ metadataConfirmed:true }, 'metadata-confirmed', 0.95, false],
    [{ confirmation:'user-confirmed' }, 'user-confirmed', 1, true],
    [{ confirmation:'debugger-confirmed' }, 'debugger-confirmed', 1, false],
    [{ confirmation:'metadata-confirmed' }, 'metadata-confirmed', 0.95, false],
  ]) {
    const db = freshDb();
    const record = await db.remember({ ...fixture, ...input });
    assert.equal(record.confirmation, confirmation);
    assert.equal(record.confidence, confidence);
    assert.equal(record.userConfirmed, userConfirmed);
  }
});

test('#3790 malformed flag cannot upgrade matching or propagation authority', async () => {
  const db = freshDb();
  const record = await db.remember({ ...fixture, id:'malformed-high-confidence', confidence:1, userConfirmed:'false' });
  assert.equal(record.confirmation, 'high-confidence-inferred');
  assert.equal(record.userConfirmed, false);

  const matches = await db.findMatches(fixture, { threshold:0 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.confirmation, 'high-confidence-inferred');

  const propagated = await db.propagate(fixture, { threshold:0.8 });
  assert.equal(propagated.propagated, true);
  assert.equal(propagated.confirmation, 'weak-inferred');
});
