import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceBudget } from '../../js/core/budgets/index.js';

// #6023: ResourceBudget.snapshot({recursive:true}) sorted child scopes with
// localeCompare(), whose collation is ICU-locale dependent even for pure
// ASCII ('A' vs 'a' flips between en-US and da-DK). The same budget tree must
// produce a byte-identical recursive snapshot on every host.

function buildTree() {
  const root = new ResourceBudget();
  root.scope('A');
  root.scope('a');
  root.scope('B');
  root.scope('b');
  root.scope('Z');
  root.scope('z');
  return root;
}

test('recursive snapshot child order is locale-independent code-unit order (#6023)', () => {
  const root = buildTree();
  const names = root.snapshot({ recursive: true }).children.map((child) => child.name);
  assert.deepEqual(names, ['A', 'B', 'Z', 'a', 'b', 'z'],
    'uppercase letters precede lowercase in UTF-16 code-unit order, regardless of collation');
});

test('ICU collation extremes cannot change the snapshot (#6023)', () => {
  const root = buildTree();
  // Sort the same scope names under the two collations that disagree on
  // ASCII case, then verify the canonical snapshot is identical either way.
  const digests = new Set();
  for (const locale of ['en-US', 'da-DK']) {
    const collator = new Intl.Collator(locale);
    const names = [...root.children.keys()].sort((a, b) => collator.compare(a, b));
    // Rebuild a fresh tree inserting scopes in this locale's collation order:
    // the snapshot must canonicalize to the same order regardless.
    const reordered = new ResourceBudget();
    for (const name of names) reordered.scope(name);
    digests.add(JSON.stringify(reordered.snapshot({ recursive: true })));
  }
  assert.equal(digests.size, 1, 'every host locale must produce the identical snapshot');
});

test('nested scopes canonicalize recursively (#6023)', () => {
  const root = new ResourceBudget();
  const outerA = root.scope('A');
  outerA.scope('z');
  outerA.scope('y');
  const outerB = root.scope('b');
  outerB.scope('m');
  const snap = root.snapshot({ recursive: true });
  assert.deepEqual(snap.children.map((c) => c.name), ['A', 'b']);
  assert.deepEqual(snap.children[0].children.map((c) => c.name), ['y', 'z']);
});
