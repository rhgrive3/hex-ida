/*
 * Invariant 1 — running reachability / unknown-store analysis must not let
 * runtime functions, closures, or caches flow into the Semantic IR as own
 * properties.
 *
 * The barrier semantics themselves are asserted first (they are the reason the
 * reachability walk runs at all); the ownership assertions then check that
 * observing the IR through the public query leaves it a plain semantic value.
 *
 * Fixture: a synthetic three-block CFG holding a concrete field store, an
 * unknown indexed store, and a load of the concrete field.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasUnknownStoreBarrier, readModifyWrite } from '../../js/ir.js';
import { smallUnknownFreeStoreFixture, threeBlockUnknownStoreFixture } from './invariant-fixtures.mjs';

function functionValuedOwnProperties(value) {
  return Object.getOwnPropertyNames(value)
    .filter((key) => typeof value[key] === 'function')
    .sort();
}

function ownPropertyNames(value) {
  return Object.getOwnPropertyNames(value).sort();
}

/* ── Barrier semantics (the reason the reachability query runs) ─────────── */

test('unknown store between a concrete store and a load is reported as a barrier', () => {
  const { ir, concreteStore, unknownStore, load } = threeBlockUnknownStoreFixture();

  assert.equal(hasUnknownStoreBarrier(ir, concreteStore, load), true,
    'an unknown store ordered between the concrete store and the load must be a barrier');
  assert.ok(unknownStore.row > concreteStore.row && unknownStore.row < load.row,
    'fixture: the unknown store must sit between the concrete store and the load');

  assert.equal(ir.memorySafety?.unknownStores, 1, 'exactly one unknown store must be counted');
  assert.equal(ir.memorySafety?.blockedLoads, 1, 'the concrete load proof must be counted as blocked');
  assert.equal(load.memUse?.kind, 'clobber', 'the load must be reclassified as a clobber, not a reaching store');
  assert.equal(load.memUse?.unknownAlias, true, 'the clobber must carry unknown-alias evidence');
  assert.equal(load.reachingStore ?? null, null, 'no stale concrete reaching store may survive the unknown store');
});

test('barrier query is direction-sensitive', () => {
  const { ir, concreteStore, load } = threeBlockUnknownStoreFixture();
  assert.equal(hasUnknownStoreBarrier(ir, load, concreteStore), false,
    'a barrier cannot run backwards from the load to the earlier concrete store');
  assert.equal(hasUnknownStoreBarrier(ir, concreteStore, concreteStore), false,
    'a store is not its own barrier');
});

test('control: a store/load pair without any unknown store reports no barrier', () => {
  const { ir, concreteStore, load } = smallUnknownFreeStoreFixture();
  assert.equal(hasUnknownStoreBarrier(ir, concreteStore, load), false,
    'a concrete store followed by a load of the same location has no unknown-store barrier');
  assert.equal(ir.memorySafety?.unknownStores, 0, 'no unknown store may be invented for a clean fixture');
  assert.equal(ir.memorySafety?.blockedLoads, 0, 'a clean fixture blocks no load proof');
});

/* ── Ownership: no runtime function / closure / cache on the Semantic IR ── */

test('built Semantic IR owns no runtime function or closure', () => {
  const { ir } = threeBlockUnknownStoreFixture();
  const functions = functionValuedOwnProperties(ir);
  assert.deepEqual(functions, [],
    `Semantic IR must not carry runtime functions/closures as own properties, found: ${functions.join(', ')}`);
});

test('reachability and unknown-store queries add no own property to the Semantic IR', () => {
  const { ir, concreteStore, load } = threeBlockUnknownStoreFixture();

  const before = ownPropertyNames(ir);
  assert.equal(hasUnknownStoreBarrier(ir, concreteStore, load), true, 'fixture: the barrier must be observable');
  readModifyWrite(ir);
  const after = ownPropertyNames(ir);

  const introduced = after.filter((key) => !before.includes(key));
  assert.deepEqual(introduced, [],
    `analysis queries must not attach runtime caches/closures to the Semantic IR, added: ${introduced.join(', ')}`);
});

test('control: a query on an IR without an unknown store adds no own property and reports no barrier', () => {
  const { ir, concreteStore, load } = smallUnknownFreeStoreFixture();

  const before = ownPropertyNames(ir);
  assert.equal(hasUnknownStoreBarrier(ir, concreteStore, load), false, 'fixture: no barrier is expected');
  assert.deepEqual(ownPropertyNames(ir), before,
    'a query on a clean IR must not attach runtime caches/closures either');
});

test('Semantic IR stays a detached value after the analysis queries', () => {
  const { ir, concreteStore, load } = threeBlockUnknownStoreFixture();
  hasUnknownStoreBarrier(ir, concreteStore, load);
  readModifyWrite(ir);

  // Runtime closure ownership makes the IR non-serializable: a consumer cannot
  // snapshot, transfer, or compare it without dragging live producer state
  // along. Ownership of runtime state must live outside the IR value.
  assert.doesNotThrow(() => structuredClone(ir),
    'Semantic IR must remain a serializable semantic value, not a carrier of runtime closure/cache state');
});
