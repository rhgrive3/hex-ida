import assert from 'node:assert/strict';
import test from 'node:test';

import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { ALIAS_QUERIES, buildFixture, memoryAccessOf, regionOf } from '../corpus/fixtures.mjs';

const solvers = new Map();
function answer(query) {
  const built = buildFixture(query.fixture);
  if (!solvers.has(built)) solvers.set(built, createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa }));
  return solvers.get(built).alias(regionOf(built, query.left), regionOf(built, query.right), {
    leftAccess: memoryAccessOf(built, query.left),
    rightAccess: memoryAccessOf(built, query.right),
  });
}

/**
 * The negative corpus. Every case here has a strong answer that is provably
 * wrong; returning it is a stop-the-line soundness failure, not a precision
 * miss (§24.1).
 */
test('no query in the frozen set produces a false NoAlias or MustAlias', () => {
  for (const query of ALIAS_QUERIES) {
    const result = answer(query);
    if (query.truth === 'may-or-weaker') {
      assert.ok(['may', 'unknown'].includes(result.relation),
        `${query.id}: strong answer ${result.relation} where no strong answer is true (${result.reasonCodes.join(',')})`);
    } else {
      assert.notEqual(result.relation, query.truth === 'no' ? 'must' : 'no',
        `${query.id}: answered the opposite strong relation`);
    }
  }
});

test('overlapping stack intervals are never separated', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-stack-overlapping'));
  assert.notEqual(result.relation, 'no', 'two 8-byte accesses 4 bytes apart overlap');
});

test('a same-root access at an unbounded offset stays weak in both directions', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-uncertain-offset'));
  assert.ok(['may', 'unknown'].includes(result.relation));
  assert.ok(result.reasonCodes.length > 0, 'even a weak answer must be explainable');
});

test('provenance lost through an integer round trip blocks separation', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-provenance-loss'));
  assert.ok(['may', 'unknown'].includes(result.relation));
});

test('a pointer phi over distinct offsets is not separated from either arm', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-pointer-phi'));
  assert.ok(['may', 'unknown'].includes(result.relation),
    `phi-merged pointer answered ${result.relation}`);
});

test('a cyclic pointer phi terminates and does not manufacture a small range', () => {
  const built = buildFixture('cyclic-pointer-phi');
  const solver = createPhase7AliasSolver({ ir: built.ir, cfg: built.cfg, ssa: built.ssa });
  const run = solver.pointsToRun();
  assert.ok(run.iterations > 0 && run.iterations <= 32, `fixed point did not terminate cleanly: ${run.iterations}`);
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-cyclic-phi'));
  assert.ok(['may', 'unknown'].includes(result.relation),
    'a widened, unbounded offset must not wrap into a provably disjoint interval');
});

test('overlapping fields are not separated by their labels', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-overlapping-fields'));
  assert.notEqual(result.relation, 'no', 'a 2-byte field inside an 8-byte field overlaps it');
});

test('two similar-looking opaque roots are neither identified nor separated', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-similar-roots'));
  assert.ok(['may', 'unknown'].includes(result.relation));
  assert.ok(result.reasonCodes.includes('escape-unproven') || result.reasonCodes.includes('unresolved-root'),
    'distinct roots without escape evidence must say so');
});

test('a pointer read out of memory is an unresolved boundary', () => {
  const result = answer(ALIAS_QUERIES.find((query) => query.id === 'q-load-derived'));
  assert.ok(['may', 'unknown'].includes(result.relation));
});

test('root spelling alone cannot manufacture NoAlias separation authority', () => {
  const target = (rootKey, variableKey) => ({
    top: false,
    lossReasons: [],
    targets: [{
      rootKey,
      rootKind: 'unknown',
      addressSpace: 'default',
      address: null,
      offsetRange: { min: 0n, max: 0n, exact: true },
      rootIdentity: { variable: { key: variableKey } },
    }],
  });

  for (const [leftName, rightName] of [
    ['heap_left', 'heap_right'],
    ['alloc_left', 'alloc_right'],
    ['global_left', 'global_right'],
    ['g_root_left', 'g_root_right'],
  ]) {
    const result = pointsToAlias(target('r1', leftName), target('r2', rightName), {
      widthBitsLeft: 64,
      widthBitsRight: 64,
      nonEscapingRoots: new Set(),
      status: createAnalysisStatus({
        snapshotId: 'snapshot_root_spelling',
        analyzerId: 'test.root-spelling',
        analyzerVersion: '1.0.0',
        completeness: 'complete',
      }),
    });
    assert.equal(result.relation, 'may', `${leftName}/${rightName} must not be a semantic separation proof`);
    assert.ok(result.reasonCodes.includes('escape-unproven'));
    assert.ok(!result.reasonCodes.includes('distinct-non-escaping-allocation'), 'name-only heap roots must not claim allocation separation');
    assert.ok(!result.reasonCodes.includes('disjoint-global-interval'), 'name-only global roots must not claim interval separation');
    assert.ok(!result.reasonCodes.includes('distinct-proven-root'), 'name-only roots must not claim descriptor-backed separation');
    assert.ok(!result.reasonCodes.some((code) => code.startsWith('distinct-') || code.startsWith('disjoint-')),
      'name-only roots must not gain any present or future strong separation reason');
  }
});

test('the Phase 7 solver is never weaker than the conservative floor', () => {
  // Precision may be gained, never traded: if the floor could prove it, so
  // must the solver, or a supposedly better analyser is a regression.
  const strength = { unknown: 0, may: 1, must: 2, no: 2 };
  for (const query of ALIAS_QUERIES) {
    const built = buildFixture(query.fixture);
    const floor = aliasMemoryRegions(regionOf(built, query.left), regionOf(built, query.right));
    const candidate = answer(query).relation;
    assert.ok(strength[candidate] >= strength[floor],
      `${query.id}: solver (${candidate}) is weaker than the floor (${floor})`);
  }
});

test('every strong answer carries a proof reason of the matching class', () => {
  for (const query of ALIAS_QUERIES) {
    const result = answer(query);
    if (result.relation === 'no') {
      assert.ok(result.reasonCodes.some((code) => code.startsWith('disjoint-') || code.startsWith('distinct-')),
        `${query.id}: NoAlias without a separation proof`);
    }
    if (result.relation === 'must') {
      assert.ok(result.reasonCodes.some((code) => code.startsWith('identical-')),
        `${query.id}: MustAlias without an identity proof`);
    }
  }
});

test('a cancelled solve never yields a strong answer', () => {
  const built = buildFixture('stack-disjoint');
  const controller = new AbortController();
  controller.abort();
  const solver = createPhase7AliasSolver({
    ir: built.ir, cfg: built.cfg, ssa: built.ssa, options: { signal: controller.signal },
  });
  const query = ALIAS_QUERIES.find((item) => item.id === 'q-stack-disjoint');
  const result = solver.alias(regionOf(built, query.left), regionOf(built, query.right), {
    leftAccess: memoryAccessOf(built, query.left),
    rightAccess: memoryAccessOf(built, query.right),
  });
  assert.ok(['may', 'unknown'].includes(result.relation),
    'a cancelled run must not publish the separation it would have proven');
  assert.notEqual(result.status.completeness, 'complete');
});
