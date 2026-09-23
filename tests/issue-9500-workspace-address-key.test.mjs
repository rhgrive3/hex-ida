import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotWorkspace } from '../js/workspace.js';

function app(entries) {
  return {
    notes: { names:new Map(entries), comments:new Map(), types:new Map(), vars:new Map(), structs:[] },
    bookmarks: { list: () => [] },
    patches: { list: () => [] },
    navigation: { entries: [], index: null },
    store: { get: () => null },
  };
}

test('#9500 snapshot skips coercible-but-invalid and negative address keys', () => {
  for (const key of ['', '   ', '-1', false, [], {}, 'xyz']) {
    const project = snapshotWorkspace(app([[key, 'bad']]), { hash:'fixture', metadata:{} });
    assert.deepEqual(project.user.names, [], `invalid key ${String(key)} must be skipped`);
  }
});

test('#9500 snapshot preserves canonical non-negative address keys', () => {
  const project = snapshotWorkspace(app([['0', 'zero'], ['0x10', 'hex'], [32n, 'big']]), { hash:'fixture', metadata:{} });
  assert.deepEqual(project.user.names.map((entry) => entry.address), [0n, 16n, 32n]);
});
