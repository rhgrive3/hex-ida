import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import {
  ESCAPE_BOUNDARIES,
  ESCAPE_REASONS,
  ROOT_ORIGINS,
  analyzeEscape,
  createEscapeRecord,
  invalidatesNonEscapeProof,
} from '../../../js/analysis/summary/escape.js';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { collectEscapeMetrics } from '../../../tools/validation/phase7/lanes/summary.mjs';
import { buildFixture, memoryAccessOf, regionOf } from '../corpus/fixtures.mjs';

function escapeOf(fixtureId) {
  const built = buildFixture(fixtureId);
  const pointsTo = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    canonicalOptions: built.rootDescriptors == null ? {} : { rootDescriptors: built.rootDescriptors },
  });
  return { built, pointsTo, escape: analyzeEscape(built.ir, built.cfg, built.ssa, pointsTo, {}) };
}

function aliasOf(fixtureId, left, right) {
  const built = buildFixture(fixtureId);
  const solver = createPhase7AliasSolver({
    ir: built.ir, cfg: built.cfg, ssa: built.ssa,
    options: built.rootDescriptors == null ? {} : { canonicalOptions: { rootDescriptors: built.rootDescriptors } },
  });
  return solver.alias(regionOf(built, left), regionOf(built, right), {
    leftAccess: memoryAccessOf(built, left),
    rightAccess: memoryAccessOf(built, right),
  });
}

test('escape is a reason and a boundary, not a boolean', () => {
  // FM-3: collapsing escape to true/false throws away exactly the information
  // later analysis needs to know which separation proofs still hold.
  assert.ok(ESCAPE_REASONS.length >= 8);
  assert.ok(ESCAPE_BOUNDARIES.length >= 8);
  assert.throws(() => createEscapeRecord({ rootKey: 'r', reason: 'escaped', boundary: 'return' }), /invalid-reason/);
  assert.throws(() => createEscapeRecord({ rootKey: 'r', reason: 'returned', boundary: 'somewhere' }), /invalid-boundary/);
});

test('root origin is tracked separately from escape', () => {
  // Two incoming parameters may alias each other however little they escape, so
  // non-escape alone is never enough for separation.
  assert.deepEqual([...ROOT_ORIGINS], ['local-frame', 'local-allocation', 'incoming', 'global', 'unknown']);
  const { escape } = escapeOf('similar-looking-roots');
  assert.ok([...escape.rootOrigins.values()].every((origin) => origin !== 'local-frame'));
  assert.equal(escape.nonEscapingRoots.size, 0);
});

test('a frame nothing publishes is proven non-escaping', () => {
  const { escape } = escapeOf('frame-non-escaping');
  assert.equal(escape.escapes.length, 0);
  assert.equal(escape.nonEscapingRoots.size, 1);
  assert.equal(escape.status.completeness, 'complete');
});

test('escape evidence proves separation A2 alone cannot', () => {
  // The caller cannot hold a pointer into a frame it never saw.
  const result = aliasOf('frame-non-escaping', 'node_st_slot', 'node_st_arg');
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('distinct-non-escaping-allocation'));
});

test('publishing the frame withdraws exactly that separation', () => {
  // Same query, same shape, one extra store: the proof must disappear.
  const { escape } = escapeOf('frame-escapes-through-argument');
  assert.ok(escape.escapes.some((record) => record.reason === 'stored-through-argument'));
  assert.equal(escape.nonEscapingRoots.size, 0);
  const result = aliasOf('frame-escapes-through-argument', 'node_st_slot', 'node_st_arg');
  assert.ok(['may', 'unknown'].includes(result.relation),
    `an escaped frame must not stay separated (got ${result.relation})`);
});

test('an unresolved flow voids every non-escape claim in the function', () => {
  // A value that may point anywhere could have carried any root out, so no root
  // in that function can be called non-escaping.
  const { escape } = escapeOf('unknown-call-barrier');
  assert.equal(escape.sawUnresolvedFlow, true);
  assert.equal(escape.nonEscapingRoots.size, 0);
  assert.notEqual(escape.status.completeness, 'complete');
});

test('escape without points-to evidence fails closed', () => {
  const built = buildFixture('frame-non-escaping');
  const unsupported = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, { budget: { maxValues: 1 } });
  const escape = analyzeEscape(built.ir, built.cfg, built.ssa, unsupported, {});
  assert.equal(escape.status.completeness, 'unsupported');
  assert.equal(escape.status.stopReason, 'dependency-missing');
  assert.equal(escape.nonEscapingRoots.size, 0);
});

test('cancellation yields no non-escaping roots', () => {
  const built = buildFixture('frame-non-escaping');
  const pointsTo = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {});
  const controller = new AbortController();
  controller.abort();
  const escape = analyzeEscape(built.ir, built.cfg, built.ssa, pointsTo, { signal: controller.signal });
  assert.equal(escape.status.stopReason, 'cancelled');
  assert.equal(escape.nonEscapingRoots.size, 0);
});

test('only a call with a proven summary preserves a non-escape proof', () => {
  // Passing a pointer to a callee whose effects are known does not publish it;
  // every other boundary does.
  assert.equal(invalidatesNonEscapeProof(createEscapeRecord({ rootKey: 'r', reason: 'passed-to-known-call', boundary: 'known-call' })), false);
  for (const reason of ['returned', 'stored-to-global', 'stored-through-argument', 'passed-to-unknown-call', 'captured-by-closure', 'published-to-thread', 'unknown']) {
    assert.equal(invalidatesNonEscapeProof(createEscapeRecord({ rootKey: 'r', reason, boundary: 'unknown' })), true, reason);
  }
});

test('language and runtime captures arrive through a provider, not the solver', () => {
  // P7-INV-007: no Swift/ObjC/C++/Go decoding may enter the generic solver.
  const built = buildFixture('frame-non-escaping');
  const pointsTo = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    canonicalOptions: { rootDescriptors: built.rootDescriptors },
  });
  const withoutProvider = analyzeEscape(built.ir, built.cfg, built.ssa, pointsTo, {});
  const capturedRoot = [...withoutProvider.rootOrigins.keys()][0];
  const withProvider = analyzeEscape(built.ir, built.cfg, built.ssa, pointsTo, {
    captureProviders: [() => [{
      rootKey: capturedRoot, rootOrigin: 'local-frame',
      reason: 'captured-by-closure', boundary: 'closure', siteId: 'provider',
    }]],
  });
  assert.ok(withProvider.escapes.some((record) => record.reason === 'captured-by-closure'));
  assert.ok(!withProvider.nonEscapingRoots.has(capturedRoot),
    'a provider-reported capture must withdraw the non-escape proof');
});

test('a malformed structured value reference cannot borrow another value flow (#5783)', () => {
  // Points-to keys are canonical value ID strings. String-coercing a
  // structured id ['v1'] onto 'v1' would let one malformed node invent
  // another value's escape evidence.
  const pointsToRun = {
    status: { completeness: 'complete' },
    pointsTo: new Map([
      ['v1', { top: false, targets: [{ rootKey: 'root-local', rootKind: 'local-allocation' }] }],
    ]),
  };
  const options = { allocationRootKeys: new Set(['root-local']), snapshotId: 'snapshot_issue_5783' };
  const node = (id, inputs) => ({ id, kind: 'return', inputs, origin: { instructionIds: [`i-${id}`] } });

  // The canonical id still sees the set and reports the escape.
  const canonical = analyzeEscape({ nodes: [node('ret-ok', ['v1'])] }, null, null, pointsToRun, options);
  assert.deepEqual(canonical.escapes.map((record) => record.rootKey), ['root-local']);
  assert.equal(canonical.nonEscapingRoots.has('root-local'), false);

  // The structured reference must NOT reach 'v1''s set: fail closed to an
  // unresolved flow, never fabricate an escape from someone else's facts.
  for (const malformed of [['v1'], { id: 'v1' }, 1, true]) {
    const result = analyzeEscape({ nodes: [node('ret-bad', [malformed])] }, null, null, pointsToRun, options);
    assert.deepEqual(result.escapes, [], `structured/typed reference ${JSON.stringify(malformed)} must not resolve to 'v1'`);
    assert.equal(result.nonEscapingRoots.has('root-local'), false,
      'an unresolved flow must not confirm non-escape either');
    assert.equal(result.sawUnresolvedFlow, true, 'the malformed flow must be reported unresolved');
    assert.equal(result.status.completeness, 'partial');
  }

  // Same rule on the store path: a malformed stored value must not inherit
  // 'v1''s targets and get published through the address set.
  const storeRun = {
    status: { completeness: 'complete' },
    pointsTo: new Map([
      ['v1', { top: false, targets: [{ rootKey: 'root-local', rootKind: 'local-allocation' }] }],
      ['addr', { top: false, targets: [{ rootKey: 'root-global', rootKind: 'global' }] }],
    ]),
  };
  const store = {
    id: 'st-1', kind: 'store',
    inputs: ['addr', ['v1']],
    memory: { addressExpr: { valueId: 'addr' } },
    origin: { instructionIds: ['i-st'] },
  };
  const stored = analyzeEscape({ nodes: [store] }, null, null, storeRun, options);
  assert.deepEqual(stored.escapes, [], 'a malformed stored value must not escape through the resolved address');
  assert.equal(stored.sawUnresolvedFlow, true);
});

test('the escape corpus meets its declared truth', () => {
  const metrics = collectEscapeMetrics();
  assert.equal(metrics.missedEscapes, 0, 'an escape the corpus declares was not detected');
  assert.equal(metrics.falseNonEscape, 0, 'a root that escaped was reported non-escaping');
  assert.equal(metrics.localFalsePurity, 0, 'a local summary with an unresolved call read as pure');
});
