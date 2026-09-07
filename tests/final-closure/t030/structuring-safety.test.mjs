import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PASS_STAGES,
  createAnalysisState,
  edgeAccountingFailures,
  structuredRegionPreservationFailures,
  runPhase8Stage,
  runStructuringPass,
  validateRegionTransform,
} from '../../../js/decompiler/phase8/index.js';
import { fixture } from '../../../tests/phase8/helpers/ir-fixtures.mjs';

function runStructuring(ir, options = {}) {
  return runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs: 2000, ...options });
}

function directContext(ir) {
  return {
    analysis: createAnalysisState({
      cfg: ir,
      dominators: { postDominators: ir.postDominators, ipdom: ir.ipdom },
      induction: { loops: ir.loops },
    }),
  };
}

function stagingArea(staged) {
  return { stage(key, value) { staged.set(key, value); } };
}

test('T030 preserves unwind constraints and irreducible residual jumps', () => {
  const unwind = fixture('t030-unwind');
  const condition = unwind.block(0, { succ: [1, 2] }).opaque(1);
  unwind.conditionalBranch(condition, 1, 2);
  unwind.block(1, { succ: [3, 4], edges: [{ to: 3, kind: 'branch' }, { to: 4, kind: 'unwind' }] });
  unwind.block(2, { succ: [3] }).branch(3);
  unwind.block(3).ret();
  unwind.block(4).ret();
  const unwindIr = unwind.build();
  const unwindRun = runStructuring(unwindIr);
  const unwindFacts = unwindRun.analysis.get('structuredRegions');
  assert.equal(unwindRun.ledger.published, true);
  assert.equal(unwindFacts.edges.find((edge) => edge.from === 1 && edge.to === 4).construct, 'constraint-edge');
  assert.equal(unwindFacts.constraintEdgeCount, 1);
  const unwindPlan = unwindFacts.regionTransforms.find((plan) => plan.edgeKeys.includes('1->4'));
  assert.equal(unwindPlan.action, 'preserve-exception-constraint');
  assert.equal(unwindPlan.status, 'fallback');
  assert.equal(unwindPlan.preservesSemantics, true);
  assert.equal(unwindPlan.validation.status, 'passed');
  assert.deepEqual(unwindRun.analysis.get('providerHints').structuredControl.preservationFailures, []);
  assert.deepEqual(edgeAccountingFailures(unwindIr, unwindFacts), []);

  const irreducible = fixture('t030-irreducible');
  const pick = irreducible.block(0, { succ: [1, 2] }).opaque(1);
  irreducible.conditionalBranch(pick, 1, 2);
  irreducible.block(1, { succ: [2] }).branch(2);
  irreducible.block(2, { succ: [1, 3] });
  irreducible.conditionalBranch(irreducible.opaque(1), 1, 3);
  irreducible.block(3).ret();
  const irreducibleIr = irreducible.build({ loops: [{ header: 1, latches: new Set([2]), nodes: new Set([1, 2]), exits: new Set([3]) }] });
  const irreducibleRun = runStructuring(irreducibleIr);
  const irreducibleFacts = irreducibleRun.analysis.get('structuredRegions');
  assert.ok(irreducibleFacts.regions.some((region) => region.kind === 'irreducible'));
  assert.ok(irreducibleFacts.edges.filter((edge) => edge.from === 1 || edge.from === 2)
    .every((edge) => edge.construct === 'residual-goto'));
  assert.ok(irreducibleFacts.regionTransforms.some((plan) => (
    plan.kind === 'irreducible' && plan.action === 'preserve-goto' && plan.preservesSemantics === true
  )));
  assert.deepEqual(irreducibleRun.analysis.get('providerHints').structuredControl.preservationFailures, []);
  assert.deepEqual(edgeAccountingFailures(irreducibleIr, irreducibleFacts), []);
});

test('T030 adopts only independently validated ordinary regions', () => {
  const f = fixture('t030-validated');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3] }).branch(3);
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  const run = runStructuring(f.build());
  const facts = run.analysis.get('structuredRegions');
  const plan = facts.regionTransforms.find((candidate) => candidate.kind === 'conditional');
  assert.equal(plan.action, 'structure-if');
  assert.equal(plan.status, 'validated');
  assert.equal(plan.validation.status, 'passed');
  assert.equal(facts.regionValidation.status, 'passed');
  assert.deepEqual(run.analysis.get('providerHints').structuredControl.preservationFailures, []);

  const tampered = { ...plan, edgeKeys: [...plan.edgeKeys, '9->10'] };
  const validation = validateRegionTransform(tampered, facts);
  assert.equal(validation.valid, false);
  assert.ok(validation.failures.some((failure) => failure.problem === 'region-edge-missing'));
  const removed = { ...plan, edgeKeys: plan.edgeKeys.slice(0, -1) };
  const removalValidation = validateRegionTransform(removed, facts);
  assert.equal(removalValidation.valid, false);
  assert.ok(removalValidation.failures.some((failure) => failure.problem === 'region-edge-omitted'));
  const external = { ...plan, edgeKeys: [...plan.edgeKeys, '9->0'] };
  const externalValidation = validateRegionTransform(external, {
    ...facts,
    edges: [...facts.edges, { from: 9, to: 0, kinds: ['branch'], construct: 'sequence', reason: 'test external entry' }],
  });
  assert.equal(externalValidation.valid, false);
  assert.ok(externalValidation.failures.some((failure) => failure.problem === 'region-edge-source-outside'));
  assert.deepEqual(structuredRegionPreservationFailures({
    regionTransforms: [{ ...plan, validation: { status: 'failed', failures: [{ problem: 'tampered' }] } }],
    regionValidation: { status: 'passed' },
  }).map((failure) => failure.problem), ['plan-validation-failed']);
  assert.ok(structuredRegionPreservationFailures({
    regionTransforms: [],
    regionValidation: { status: 'failed' },
  }).some((failure) => failure.problem === 'region-artifact-validation-failed'));
});

test('T030 bounds structuring and reports partial convergence without publishing false completeness', () => {
  const f = fixture('t030-bounded');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3] }).branch(3);
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  const ir = f.build();
  const analysis = directContext(ir);
  const staged = new Map();
  const bounded = runStructuringPass(analysis, { limits: { maxBlocks: 1, maxChainWalk: 4096 } }, stagingArea(staged));
  assert.equal(bounded.status, 'changed');
  assert.equal(bounded.completeness, 'partial');
  assert.equal(staged.get('structuredRegions').convergence, 'partial');
  assert.equal(staged.get('structuredRegions').completeness, 'partial');

  const invalid = runStructuringPass(analysis, { limits: { maxBlocks: -1 } }, stagingArea(new Map()));
  assert.equal(invalid.status, 'unsupported');
  assert.equal(invalid.completeness, 'unknown');
  assert.deepEqual(invalid.produced, []);
  assert.equal(invalid.stopReason, 'invalid-limit');
});

test('T030 cancellation withholds the entire structuring artifact', () => {
  const f = fixture('t030-cancelled');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3] }).branch(3);
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  let calls = 0;
  const run = runStructuring(f.build(), { shouldAbort: () => { calls += 1; return calls > 2; } });
  assert.equal(run.ledger.published, false);
  assert.equal(run.analysis.get('structuredRegions'), null);
  assert.ok(calls > 2);
});
