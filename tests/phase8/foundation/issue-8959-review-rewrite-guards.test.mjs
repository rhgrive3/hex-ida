import assert from 'node:assert/strict';
import test from 'node:test';
import { expr, structuralKey } from '../../../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../../../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../../../js/decompiler/rewrite/rules.js';
import { evaluateExpression } from '../../../js/decompiler/verify/equivalence.js';

const rewrite = (root) => new RewriteEngine(DEFAULT_RULES, {
  timeBudgetMs: 1000,
  nodeBudget: 4096,
}).rewrite(root, { deterministicTransforms: true });
const rules = (out) => out.proof.map((entry) => entry.rule);

test('#8861 nested min/max rejects contradictory or malformed ordering authority', () => {
  const x = expr.variable('x', 32, null);
  const y = expr.variable('y', 32, null);

  const inner = expr.intrinsic('min', [x, y], 32, false, null, { compareSigned: true });
  const root = expr.intrinsic('min', [inner, y], 32, false, null, { compareSigned: true });
  const out = rewrite(root);
  assert.equal(structuralKey(out.root), structuralKey(root));
  assert.ok(!rules(out).includes('nested-minmax-idempotent'));

  const malformedInner = expr.intrinsic('max', [x, y], 32, false, null, { compareSigned: 'unsigned' });
  const malformedRoot = expr.intrinsic('max', [malformedInner, y], 32, false, null, { compareSigned: 'unsigned' });
  const malformedOut = rewrite(malformedRoot);
  assert.equal(structuralKey(malformedOut.root), structuralKey(malformedRoot));
  assert.ok(!rules(malformedOut).includes('nested-minmax-idempotent'));
});

test('#8866 truncating a widening extension back to source width still cancels', () => {
  for (const op of ['zext', 'sext']) {
    const x = expr.variable('x', 8, op === 'sext');
    const ext = expr.unary(op, x, 16, op === 'sext');
    const root = expr.unary('trunc', ext, 8, false);
    const out = rewrite(root);
    assert.ok(rules(out).includes(`trunc-after-${op}-to-source-width`));
    assert.equal(structuralKey(out.root), structuralKey(x));
    for (const value of [0n, 1n, 0x7fn, 0x80n, 0xffn]) {
      assert.equal(evaluateExpression(out.root, { x: value }), evaluateExpression(root, { x: value }));
    }
  }
});
