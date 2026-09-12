// Regression for #4818: `.hexproj` user.names / user.comments entries were only
// checked for being an Array, then applyWorkspaceProject() coerced each entry's
// address with BigInt(). A structured address such as ['4096'] is laundered
// through ToPrimitive into a *different* primitive address (BigInt(['4096']) ===
// 4096n) and restored as a legitimate annotation for 0x1000. The parser must
// apply an explicit schema and the apply boundary must reject structured /
// non-canonical addresses fail-closed, while canonical bigint / safe-integer /
// decimal / hex representations keep round-tripping.
import assert from 'node:assert/strict';
import { test } from 'node:test';

if (!globalThis.localStorage) {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
  };
}

import {
  createHexProject,
  normalizeHexProjectV1,
  parseHexProject,
  tryParseHexProject,
} from '../js/project/index.js';
import { applyWorkspaceProject } from '../js/workspace.js';
import { PatchSet } from '../js/patch.js';
import { NoteStore } from '../js/names.js';

const docWith = (user) => JSON.stringify({
  format: 'hexproj',
  version: 2,
  binary: { hash: 'h' },
  embedded: false,
  user,
});

function makeApp(id) {
  const app = {
    backend: { gen: 1, binaryId: id },
    store: { get: () => null },
    patches: new PatchSet(),
    notes: null,
    symbols: null,
  };
  app.notes = new NoteStore(id);
  app.notes.names.clear();
  app.notes.comments.clear();
  return app;
}

const applyProject = (names, comments) => ({
  user: { names, comments, types: [], vars: [], structs: [], bookmarks: [], patches: [] },
  findings: { confirmed: [], evidence: [] },
  navigation: { history: [] },
});

test('#4818 parser rejects a structured names address (fail-closed)', () => {
  assert.throws(
    () => parseHexProject(docWith({ names: [{ address: ['4096'], value: 'forged-name' }] })),
    (error) => /address/.test(error?.message ?? ''),
  );
});

test('#4818 parser rejects a structured comments address (fail-closed)', () => {
  assert.throws(
    () => parseHexProject(docWith({ comments: [{ address: { '0': '8192' }, value: 'forged-comment' }] })),
    (error) => /address/.test(error?.message ?? ''),
  );
});

test('#4818 parser rejects a boolean names address (fail-closed)', () => {
  assert.throws(
    () => parseHexProject(docWith({ names: [{ address: true, value: 'b' }] })),
    (error) => /address/.test(error?.message ?? ''),
  );
});

test('#4818 parser rejects a non-string annotation value (fail-closed)', () => {
  assert.throws(
    () => parseHexProject(docWith({ names: [{ address: '4096', value: { forged: true } }] })),
    (error) => /value/.test(error?.message ?? ''),
  );
});

test('#4818 parser rejects a non-integer numeric address (fail-closed)', () => {
  assert.throws(
    () => parseHexProject(docWith({ names: [{ address: 4096.5, value: 'x' }] })),
    (error) => /address/.test(error?.message ?? ''),
  );
});

test('#4818 tryParseHexProject reports the malformed structured-address entry', () => {
  const result = tryParseHexProject(docWith({ names: [{ address: ['4096'], value: 'forged-name' }] }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HEX_PROJECT_INVALID');
});

test('#4818 createHexProject rejects the same malformed entry', () => {
  assert.throws(
    () => createHexProject({ userNames: [{ address: ['4096'], value: 'forged-name' }] }),
    (error) => /address/.test(error?.message ?? ''),
  );
});

test('#4818 applyWorkspaceProject does not launder a structured address into a note', () => {
  const app = makeApp('binary-4818');
  app.notes.names.set('4096', 'old_name');
  app.notes.comments.set('8192', 'old_comment');
  assert.throws(
    () => applyWorkspaceProject(app, applyProject(
      [{ address: ['4096'], value: 'forged-name' }],
      [{ address: ['8192'], value: 'forged-comment' }],
    )),
    (error) => /address/.test(error?.message ?? ''),
  );
  assert.equal(app.notes.names.get('4096'), 'old_name', 'forged array must not overwrite the note');
  assert.equal(app.notes.comments.get('8192'), 'old_comment', 'forged array must not overwrite the comment');
  assert.equal(app.notes.names.has('4096') && app.notes.names.get('4096') === 'forged-name', false,
    'the structured address must never be coerced into 0x1000');
});

test('#4818 applyWorkspaceProject rejects a non-string annotation value', () => {
  const app = makeApp('binary-4818-value');
  app.notes.names.set('4096', 'old_name');
  assert.throws(
    () => applyWorkspaceProject(app, applyProject([{ address: 0x2000n, value: { forged: true } }], [])),
    (error) => /value/.test(error?.message ?? ''),
  );
  assert.equal(app.notes.names.get('8192'), undefined);
  assert.equal(app.notes.names.get('4096'), 'old_name');
});

test('#4818 canonical bigint addresses still apply', () => {
  const app = makeApp('binary-4818-bigint');
  applyWorkspaceProject(app, applyProject([{ address: 0x2000n, value: 'renamed' }], []));
  assert.equal(app.notes.names.get('8192'), 'renamed');
});

test('#4818 canonical decimal / hex string and safe-integer addresses still apply', () => {
  const app = makeApp('binary-4818-mixed');
  applyWorkspaceProject(app, applyProject(
    [{ address: '4096', value: 'dec' }, { address: '0x1100', value: 'hex' }],
    [{ address: 8192, value: 'num-comment' }],
  ));
  assert.equal(app.notes.names.get('4096'), 'dec');
  assert.equal(app.notes.names.get('4352'), 'hex');
  assert.equal(app.notes.comments.get('8192'), 'num-comment');
});

test('#4818 canonical annotation entries survive the parse round-trip', () => {
  const serialized = serialize({ names: [{ address: 0x2000n, value: 'renamed' }], comments: [{ address: 4096n, value: 'note' }] });
  const parsed = parseHexProject(serialized);
  applyWorkspaceProject(makeApp('binary-4818-roundtrip'), parsed);
  assert.equal(parsed.user.names[0].value, 'renamed');
});

function serialize(user) {
  const project = {
    format: 'hexproj',
    version: 2,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    binary: { hash: 'h', metadata: null, embedded: false },
    user: { names: user.names || [], comments: user.comments || [], types: [], vars: [], structs: [], bookmarks: [], patches: [] },
    findings: { confirmed: [], agentAnswers: [], evidence: [], investigationSessions: [] },
    analysis: { settings: {}, cacheReferences: [] },
    navigation: {},
  };
  return JSON.stringify(project, (_key, value) => (typeof value === 'bigint' ? { $hexBigInt: value.toString(16) } : value), 2);
}

test('#4818 heterogeneous legacy entries are still accepted unchanged', () => {
  const names = [{ address: 0x1000n, name: 'main' }];
  const normalized = normalizeHexProjectV1({
    format: 'hexproj', version: 2, binary: { hash: 'h' }, user: { names },
  });
  assert.deepEqual(normalized.user.names, [{ address: 0x1000n, name: 'main' }]);
  const app = makeApp('binary-4818-legacy');
  applyWorkspaceProject(app, applyProject([{ address: 0x1000n, name: 'main' }], []));
  assert.equal(app.notes.names.get('4096'), undefined, 'a value-less legacy entry must not be applied');
});
