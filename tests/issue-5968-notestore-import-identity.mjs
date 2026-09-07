import assert from 'node:assert/strict';
import { NoteStore } from '../js/names.js';

const payload = (id) => JSON.stringify({
  v: 1,
  id,
  names: { '4096': 'imported-name' },
  comments: {},
  vars: {},
  types: {},
  structs: [],
});

// Issue #5968: non-string import ids must never be String()-coerced into the
// current binary note namespace. `String(['binary-A']) === 'binary-A'` let a
// malformed backup bind foreign annotations to the current store.

for (const bad of [['binary-A'], { toString: () => 'binary-A' }, 4096, true, ['binary', 'A']]) {
  const store = new NoteStore('binary-A');
  assert.throws(
    () => store.fromJSON(payload(bad)),
    (err) => err instanceof Error && err.message === 'invalid-notes-import',
    `non-string id ${JSON.stringify(bad)} must be rejected as malformed identity`,
  );
  assert.equal(store.nameOf(4096n), null, 'malformed identity backup content must not enter the store');
}

// Canonical string identity still matches and imports.
const ok = new NoteStore('binary-A');
const n = ok.fromJSON(payload('binary-A'));
assert.equal(n, 1);
assert.equal(ok.nameOf(4096n), 'imported-name');

// Canonical string mismatch still rejects with notes-file-mismatch.
const other = new NoteStore('binary-B');
assert.throws(() => other.fromJSON(payload('binary-A')), (err) => err.message === 'notes-file-mismatch');

// Id-omitting legacy backups stay compatible.
const legacy = new NoteStore('binary-A');
const nLegacy = legacy.fromJSON(JSON.stringify({ v: 1, names: { '16': 'legacy' } }));
assert.equal(nLegacy, 1);
assert.equal(legacy.nameOf(16n), 'legacy');

console.log('issue-5968 notestore import identity is primitive-string-exact: ok');
