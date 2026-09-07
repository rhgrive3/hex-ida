import assert from 'node:assert/strict';
import test from 'node:test';

import { bitvector } from '../../../js/decompiler/phase8/bitvector.js';
import {
  evaluateBinaryRange, fullRange, singleton,
} from '../../../js/decompiler/phase8/range.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

/**
 * HEX-C2-02 minimum counterexamples. These assertions intentionally describe
 * the missing contract and are expected to fail on the pre-fix live-main head.
 * Keep this file unchanged while proving the post-fix result.
 */

function analyze(ir) {
  const state = seedAnalysisState(ir);
  const outcome = runPassTransaction(state, { descriptor: SCCP_PASS, run: runSccpPass }, { analysis: state, ir }, {});
  assert.equal(outcome.committed, true);
  return state.get('ranges');
}

test('pre-fix gap: a constant mask has no canonical congruence fact', () => {
  const result = evaluateBinaryRange('and', fullRange(32), singleton(bitvector(0xFCn, 32)));
  assert.equal(result.congruence?.modulus, 4n, 'mask-derived trailing-zero congruence must be published');
  assert.equal(result.congruence?.remainder, 0n);
});

test('pre-fix gap: a symbolic unsigned bound has no edge-specific refinement', () => {
  const f = fixture('c2-02-pre-fix-branch');
  f.block(0);
  const input = f.opaque(8);
  const limit = f.constant(10, 8);
  const condition = f.binary('ult', input, limit, 1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1).ret();
  f.block(2).ret();

  const facts = analyze(f.build());
  const trueEdge = facts.edgeFacts?.get?.('0->1:conditional-true');
  const falseEdge = facts.edgeFacts?.get?.('0->2:conditional-false');
  assert.ok(trueEdge, 'true-edge fact set must be published');
  assert.ok(falseEdge, 'false-edge fact set must be published');
  assert.equal(trueEdge.get(input.id)?.range?.upper, 9n);
  assert.equal(falseEdge.get(input.id)?.range?.lower, 10n);
  assert.equal(facts.ranges.get(input.id)?.kind, 'full', 'edge refinement must not mutate global input truth');
});
