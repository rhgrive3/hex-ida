import assert from 'node:assert/strict';
import test from 'node:test';

import { PASS_STAGES } from '../../../js/decompiler/phase8/contract.js';
import { edgeAccountingFailures, runPhase8Stage } from '../../../js/decompiler/phase8/index.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

const REQUIRED_CATEGORIES = Object.freeze([
  'irreducible',
  'exception-unwind',
  'switch-fallthrough',
  'flattened-dispatcher',
]);

function structuring(ir) {
  const { ledger, analysis } = runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs: 2000 });
  assert.equal(ledger.published, true, 'C4-02 acceptance requires a published Phase 8 ledger');
  const facts = analysis.get('structuredRegions');
  assert.ok(facts, 'C4-02 acceptance requires structured-region facts');
  assert.equal(facts.completeness, 'complete');
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);
  return facts;
}

function irreducibleCase() {
  const f = fixture('c4-02-irreducible');
  const pick = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(pick, 1, 2);
  f.block(1, { succ: [2] }).branch(2);
  f.block(2, { succ: [1, 3] });
  f.conditionalBranch(f.opaque(1), 1, 3);
  f.block(3).ret();
  return f.build({ loops: [{ header: 1, latches: new Set([2]), nodes: new Set([1, 2]), exits: new Set([3]) }] });
}

function unwindCase() {
  const f = fixture('c4-02-unwind');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3, 4], edges: [{ to: 3, kind: 'branch' }, { to: 4, kind: 'unwind' }] });
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  f.block(4).ret();
  return f.build();
}

function switchFallthroughCase() {
  const f = fixture('c4-02-switch-fallthrough');
  const selector = f.block(0, { succ: [1, 2, 3] }).opaque(32);
  f.switchBranch(selector, [[0, 1], [1, 2]], 3);
  f.block(1, { succ: [2], edges: [{ to: 2, kind: 'fallthrough' }] }).branch(2);
  f.block(2, { succ: [4] }).branch(4);
  f.block(3, { succ: [4] }).branch(4);
  f.block(4).ret();
  return f.build();
}

function flattenedDispatcherCase() {
  const f = fixture('c4-02-flattened-dispatcher');
  f.block(0, { succ: [1] }).branch(1);
  const state = f.block(1, { succ: [2, 3, 4] }).opaque(32);
  f.switchBranch(state, [[0, 2], [1, 3]], 4);
  f.block(2, { succ: [1] }).branch(1);
  f.block(3, { succ: [1] }).branch(1);
  f.block(4).ret();
  return f.build();
}

test('C4-02 denominator is frozen to the four required CFG categories', () => {
  assert.deepEqual(REQUIRED_CATEGORIES, [
    'irreducible',
    'exception-unwind',
    'switch-fallthrough',
    'flattened-dispatcher',
  ]);
});

test('C4-02 irreducible regions retain explicit residual jumps', () => {
  const facts = structuring(irreducibleCase());
  assert.ok(facts.regions.some((region) => region.kind === 'irreducible'));
  assert.ok(!facts.regions.some((region) => region.kind === 'loop'));
  assert.ok(facts.residualGotoCount > 0);
  assert.ok(facts.edges.filter((edge) => edge.from === 1 || edge.from === 2)
    .every((edge) => edge.construct === 'residual-goto'));
});

test('C4-02 unwind edges remain explicit constraints and are never folded into ordinary control flow', () => {
  const facts = structuring(unwindCase());
  const unwind = facts.edges.find((edge) => edge.from === 1 && edge.to === 4);
  assert.ok(unwind);
  assert.ok(unwind.kinds.includes('unwind'));
  assert.equal(unwind.construct, 'constraint-edge');
  assert.equal(facts.constraintEdgeCount, 1);
});

test('C4-02 switch fallthrough preserves the fallthrough edge while validating the switch region', () => {
  const facts = structuring(switchFallthroughCase());
  const fallthrough = facts.edges.find((edge) => edge.from === 1 && edge.to === 2);
  assert.ok(fallthrough);
  assert.ok(fallthrough.kinds.includes('fallthrough'));
  assert.equal(fallthrough.construct, 'sequence');
  assert.ok(facts.regions.some((region) => region.kind === 'switch' && region.entry === 0));
});

test('C4-02 flattened dispatchers remain residual control flow instead of guessed loop/switch regions', () => {
  const facts = structuring(flattenedDispatcherCase());
  assert.equal(facts.residualGotoCount, facts.edgeCount);
  assert.ok(facts.edges.every((edge) => edge.construct === 'residual-goto'));
  assert.ok(!facts.regions.some((region) => region.entry === 1 && (region.kind === 'loop' || region.kind === 'switch')));
});
