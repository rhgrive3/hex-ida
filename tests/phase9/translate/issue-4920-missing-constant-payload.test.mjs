import assert from 'node:assert/strict';
import test from 'node:test';
import { OP } from '../../../js/ir-base.js';
import { EXPR_KIND } from '../../../js/symbolic/expr/kinds.js';
import { evaluateExpr, EVAL_STATUS } from '../../../js/symbolic/expr/evaluate.js';
import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';
import { verifyBoundedEquivalence } from '../../../js/symbolic/verify/equivalence.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { VERDICT } from '../../../js/symbolic/verify/query.js';

const missingForms = [{}, { value: undefined }, { value: null }];
for (const [index, payload] of missingForms.entries()) {
  test(`missing CONST payload form ${index} is unsupported, not exact zero`, () => {
    const instruction = { id: `c${index}`, op: OP.CONST, ...payload };
    for (const target of [instruction, { id: `v${index}`, def: instruction }]) {
      const out = translateSemanticIR(target, { bitWidth: 8 });
      assert.equal(out.expression.kind, EXPR_KIND.UNKNOWN_SEMANTIC);
      assert.equal(out.status, 'unsupported');
      assert.equal(out.semanticUnknowns, 1);
      assert.deepEqual(out.unsupportedEntities, [{ id: instruction.id, op: OP.CONST, reason: 'missing-constant-value' }]);
      assert.equal(out.completeness.translation, 'unsupported');
      assert.equal(evaluateExpr(out.expression).status, EVAL_STATUS.UNKNOWN);
    }
  });
}

test('explicit zero and ordinary constant payloads retain exact bitvector semantics', () => {
  for (const value of [0, 0n, 7, 7n, -1n, 256n]) {
    const out = translateSemanticIR({ id: 'constant', op: OP.CONST, value }, { bitWidth: 8 });
    assert.equal(out.status, 'exact');
    assert.equal(out.expression.value, BigInt.asUintN(8, BigInt(value)));
    assert.equal(out.semanticUnknowns, 0);
    assert.deepEqual(out.unsupportedEntities, []);
    assert.equal(out.completeness.translation, 'complete');
  }
});

test('comparison depending on a missing constant cannot become an exact true condition', () => {
  const missing = { id: 'missing-value', def: { id: 'missing-inst', op: OP.CONST } };
  const compare = { id: 'cmp', op: OP.CMP, cond: 'eq', args: [{ value: missing }, { value: { id: 'zero', const: 0n } }] };
  const out = translateSemanticIR(compare, { bitWidth: 8 });
  assert.equal(out.status, 'unsupported');
  assert.equal(evaluateExpr(out.expression).status, EVAL_STATUS.UNKNOWN);
  assert.equal(out.completeness.translation, 'unsupported');
});

for (const [name, backend] of [['exhaustive', new ExhaustiveBvBackend()], ['UNSAT provider', new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.UNSAT })]]) {
  test(`${name}: missing CONST cannot authorize an equivalence proof`, async () => {
    const result = await verifyBoundedEquivalence({
      beforeTarget: { id: 'missing', op: OP.CONST },
      afterTarget: { id: 'explicit-zero', op: OP.CONST, value: 0n },
      backend,
      options: { bitWidth: 8 },
    });
    assert.equal(result.verdict, VERDICT.UNKNOWN);
    assert.equal(result.completeness.translation, 'unsupported');
    assert.notEqual(result.evidence?.verdict, VERDICT.PROVED);
  });
}

test('real zero-to-zero equivalence remains provable', async () => {
  const result = await verifyBoundedEquivalence({
    beforeTarget: { id: 'before', op: OP.CONST, value: 0n },
    afterTarget: { id: 'after', op: OP.CONST, value: 0 },
    backend: new ExhaustiveBvBackend(),
    options: { bitWidth: 8 },
  });
  assert.equal(result.verdict, VERDICT.PROVED);
});
