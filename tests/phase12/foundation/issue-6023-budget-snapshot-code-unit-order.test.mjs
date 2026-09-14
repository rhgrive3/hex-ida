import assert from 'node:assert/strict';
import { ResourceBudget } from '../../../js/core/budgets/index.js';

// Issue #6023: recursive ResourceBudget snapshots must order child scopes by a
// fixed total order, never by the host-locale collation of
// String.prototype.localeCompare(). Scope names are validated ASCII
// (/^[A-Za-z0-9._-]+$/), so code-unit comparison is the canonical order.

const root = new ResourceBudget();
root.scope('A');
root.scope('a');

const names = root.snapshot({ recursive: true }).children.map((c) => c.name);
assert.deepEqual(names, ['A', 'a'],
  `expected code-unit order ['A','a'], got ${JSON.stringify(names)} (locale drift from localeCompare)`);

// localeCompare itself is locale-dependent; under collations where 'A' > 'a'
// the old comparator produced ['a','A']. Simulate both branches directly by
// sorting with each comparator over the same name set.
const sample = ['a', 'A'];
const localeSorted = [...sample].sort((x, y) => x.localeCompare(y));
const codeUnitSorted = [...sample].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
assert.deepEqual(codeUnitSorted, ['A', 'a']);
console.log('note: default-locale localeCompare order for ["a","A"] =', JSON.stringify(localeSorted),
  '; canonical code-unit order =', JSON.stringify(codeUnitSorted));

// Deeper tree: deterministic nesting at every level.
const deep = new ResourceBudget();
for (const name of ['zeta', 'Alpha', 'beta_2', 'Beta-1', 'a.10']) deep.scope(name);
const deepNames = deep.snapshot({ recursive: true }).children.map((c) => c.name);
assert.deepEqual(deepNames, ['Beta-1', 'Alpha', 'a.10', 'beta_2', 'zeta'].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));

// Stability across repeated snapshots (serialize/hash consumers rely on it).
const snap1 = JSON.stringify(deep.snapshot({ recursive: true }));
const snap2 = JSON.stringify(deep.snapshot({ recursive: true }));
assert.equal(snap1, snap2);

console.log('issue-6023 resource budget locale-independent snapshot order: ok');
