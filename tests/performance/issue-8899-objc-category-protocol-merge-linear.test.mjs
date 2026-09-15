import assert from 'node:assert/strict';
import test from 'node:test';

import { buildObjcRuntimeIndex, cleanClassName } from '../../js/apple/objc-runtime.js';

// #8899: buildObjcRuntimeIndex() merged each category's adopted protocols into its
// target class by rebuilding and re-de-duplicating the target's entire accumulated
// protocol array on every category. A valid image whose categories all target one
// class, each adopting one distinct protocol, turned the supported
// MAX_CATEGORIES = 20,000 denominator into Θ(N²) synchronous work while still
// reporting complete metadata. The merge is now a linear, insertion-ordered
// accumulator. These regressions pin the exact result (so the compaction cannot
// change behavior) and bound the wall time the quadratic rebuild could never meet.

function categoryModel(n, className = 'Root') {
  return {
    classes: [{ name: className, superName: null, protocols: [], methods: [], classMethods: [] }],
    protocols: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, protocols: [] })),
    categories: Array.from({ length: n }, (_, i) => ({
      name: `Cat${i}`, className, protocols: [{ name: `P${i}` }], methods: [], instanceMethods: [], classMethods: [],
    })),
  };
}

test('category protocol merge preserves exact insertion order, first-occurrence de-duplication, and completeness', () => {
  const model = {
    classes: [{
      name: 'Root',
      superName: null,
      // Class-declared protocols may themselves repeat; the prior rebuild folded
      // them through a Set only once a category contributed, so duplicates in the
      // class-own list must survive until that first qualifying category.
      protocols: [{ name: 'PA' }, { name: 'PA' }, { name: 'PB' }],
      methods: [],
      classMethods: [],
    }],
    protocols: ['PA', 'PB', 'PC', 'PD'].map((name) => ({ name, protocols: [] })),
    categories: [
      { name: 'c0', className: 'Root', protocols: [{ name: 'PC' }], methods: [], instanceMethods: [], classMethods: [] },
      { name: 'c1', className: 'Root', protocols: [{ name: 'PA' }, { name: 'PD' }], methods: [], instanceMethods: [], classMethods: [] },
      { name: 'c2', className: 'Root', protocols: [], methods: [], instanceMethods: [], classMethods: [] },
      { name: 'c3', className: 'Missing', protocols: [{ name: 'PZ' }], methods: [], instanceMethods: [], classMethods: [] },
    ],
  };
  const index = buildObjcRuntimeIndex(model);
  const root = index.classes.get('Root');
  // Set semantics: first-occurrence order, deduplicated. 'PA' stays at its original
  // (post-Set) position; the empty and missing-target categories contribute nothing.
  assert.deepEqual([...root.protocols], ['PA', 'PB', 'PC', 'PD']);
  assert.ok(Object.isFrozen(root.protocols), 'published protocol array stays frozen');
});

test('a class with no adopting category keeps its exact (duplicate-bearing) protocol array', () => {
  const model = {
    classes: [{ name: 'Root', superName: null, protocols: [{ name: 'PA' }, { name: 'PA' }], methods: [], classMethods: [] }],
    protocols: [{ name: 'PA', protocols: [] }],
    categories: [
      { name: 'c0', className: 'Root', protocols: [], methods: [], instanceMethods: [], classMethods: [] },
    ],
  };
  const root = buildObjcRuntimeIndex(model).classes.get('Root');
  // No category adopted a protocol, so the original rebuild never fired; the
  // duplicate is preserved exactly as the quadratic code would have left it.
  assert.deepEqual([...root.protocols], ['PA', 'PA']);
});

test('a linear-size 20,000-category image (the supported ceiling) merges fast and completely', () => {
  const n = 20000;
  const model = categoryModel(n);
  const before = process.hrtime.bigint();
  const index = buildObjcRuntimeIndex(model);
  const ms = Number(process.hrtime.bigint() - before) / 1e6;
  const root = index.classes.get('Root');
  // Correctness first: all n distinct protocols, unique and in adoption order.
  assert.equal(root.protocols.length, n);
  assert.equal(root.protocols[0], 'P0');
  assert.equal(root.protocols[n - 1], `P${n - 1}`);
  assert.equal(new Set(root.protocols).size, n);
  // The Θ(N²) rebuild could not merge this within several seconds at much smaller N
  // (8,000 categories already took ~34 s at this base); a linear merge finishes with
  // wide margin. The ceiling is deliberately generous to avoid flakiness while still
  // failing hard (≈100×) on the pre-fix quadratic path.
  assert.ok(ms < 4000, `category protocol merge took ${ms.toFixed(0)} ms for ${n} categories`);
});
