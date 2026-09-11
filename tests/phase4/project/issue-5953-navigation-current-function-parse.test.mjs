// #5953: navigation.currentFunction is an address boundary. It must be
// canonicalized before workspace application can clear or save user state.
import assert from 'node:assert/strict';

import {
  createHexProject,
  parseHexProject,
  serializeHexProject,
} from '../../../js/project/index.js';
import { applyWorkspaceProject } from '../../../js/workspace.js';

const projectText = (currentFunction) => JSON.stringify({
  format: 'hexproj',
  version: 2,
  binary: { hash: 'h', embedded: false },
  navigation: { currentFunction },
  user: { names: [{ address: '4096', value: 'fn1' }] },
});

const malformed = [
  {}, [], true, -1, -1n, '-1', '-0', '+1', ' 1 ', '', '0b1', '0o10',
  '0x', '0xgg', '1.0', '1e3', Number.MAX_SAFE_INTEGER + 1,
];

for (const value of malformed) {
  assert.throws(
    () => createHexProject({ navigation: { currentFunction: value } }),
    (error) => /currentFunction/.test(error?.message ?? ''),
    `malformed currentFunction must be rejected: ${String(value)}`,
  );
  if (typeof value !== 'bigint' && typeof value !== 'object') {
    assert.throws(
      () => parseHexProject(projectText(value)),
      (error) => /currentFunction/.test(error?.message ?? ''),
      `malformed JSON currentFunction must be rejected: ${String(value)}`,
    );
  }
}

for (const [input, expected] of [
  [0, 0n],
  [4352, 4352n],
  ['4352', 4352n],
  ['0x1100', 4352n],
  ['0X1100', 4352n],
  [4352n, 4352n],
]) {
  assert.equal(createHexProject({ navigation: { currentFunction: input } }).navigation.currentFunction, expected);
}
assert.equal(createHexProject({ navigation: { currentFunction: null } }).navigation.currentFunction, null);

const roundTrip = parseHexProject(serializeHexProject(createHexProject({
  navigation: { currentFunction: 0x1000n },
})));
assert.equal(roundTrip.navigation.currentFunction, 0x1000n);

class Notes {
  constructor() {
    this.id = 'notes';
    this.names = new Map([['4096', 'old-name']]);
    this.comments = new Map([['4096', 'old-comment']]);
    this.types = new Map([['4096:x0', 'old-type']]);
    this.vars = new Map([['4096:v0', 'old-var']]);
    this.structs = [{ name: 'old-struct' }];
    this.saves = 0;
  }
  save() { this.saves += 1; return true; }
  nameEntries() { return [...this.names].map(([addr, name]) => ({ addr: BigInt(addr), name })); }
}

const notes = new Notes();
const patches = {
  items: [{ offset: 8n, before: Uint8Array.of(0), after: Uint8Array.of(1) }],
  clears: 0,
  clear() { this.clears += 1; this.items = []; },
  list() { return this.items.slice(); },
  add() { throw new Error('must not apply malformed project'); },
};
const app = {
  notes,
  patches,
  navigation: { entries: [{ addr: 0x1000n }], index: 0, limit: 40 },
  prefs: { lang: 'en', explain: true, textSize: 'normal' },
  store: { set() { throw new Error('must not update current address'); } },
};

assert.throws(
  () => applyWorkspaceProject(app, {
    user: { names: [{ address: '4096', value: 'new-name' }], comments: [], types: [], vars: [], structs: [] },
    navigation: { currentFunction: { malformed: true }, history: [], cursorIndex: null, bookmarks: [], lastQuery: null },
  }),
  (error) => /currentFunction/.test(error?.message ?? ''),
  'apply must reject malformed navigation before mutation',
);
assert.deepEqual([...notes.names], [['4096', 'old-name']]);
assert.deepEqual([...notes.comments], [['4096', 'old-comment']]);
assert.deepEqual([...notes.types], [['4096:x0', 'old-type']]);
assert.deepEqual([...notes.vars], [['4096:v0', 'old-var']]);
assert.deepEqual(notes.structs, [{ name: 'old-struct' }]);
assert.equal(notes.saves, 0);
assert.equal(patches.clears, 0);
assert.equal(patches.items.length, 1);
assert.deepEqual(app.navigation.entries, [{ addr: 0x1000n }]);
assert.equal(app.navigation.index, 0);
assert.deepEqual(app.prefs, { lang: 'en', explain: true, textSize: 'normal' });

console.log('issue #5953 navigation.currentFunction validation: PASS');
