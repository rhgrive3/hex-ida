import test from 'node:test';
import assert from 'node:assert/strict';

import { translateSemanticIR } from '../js/symbolic/translate/semantic-ir.js';
import { evaluateExpr, EVAL_STATUS } from '../js/symbolic/expr/evaluate.js';
import { EXPR_KIND } from '../js/symbolic/expr/kinds.js';
import { TRANSLATION_STATUS, COMPLETENESS_STATUS } from '../js/symbolic/translate/support-matrix.js';

const MALFORMED_REASON = 'malformed-ssa-value-id';

function addInst(left, right, id = 'add-1') {
  return { id, op: 'bin', subOp: 'add', args: [{ value: left }, { value: right }] };
}

function evaluated(expr) {
  const res = evaluateExpr(expr, new Map());
  return res.status === EVAL_STATUS.VALUE ? res.value : res.status;
}

test('#4690 a structured value id must not alias onto an existing canonical string id', () => {
  const out = translateSemanticIR(
    addInst({ id: 'v1', const: 1n }, { id: ['v1'], const: 2n }),
    { bitWidth: 8 },
  );
  assert.notEqual(out.status, TRANSLATION_STATUS.EXACT);
  assert.equal(out.status, TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(out.completeness.translation, COMPLETENESS_STATUS.UNSUPPORTED);
  assert.ok(out.semanticUnknowns > 0);
  assert.ok(out.unsupportedEntities.some((entity) => entity.reason === MALFORMED_REASON));
  assert.notEqual(evaluated(out.expression), 2n, 'structured id must not reuse the CONST(1) memo entry');
  assert.equal(out.expression.right.kind, EXPR_KIND.UNKNOWN_SEMANTIC);
  assert.equal(out.expression.right.reason, MALFORMED_REASON);
  assert.equal(out.expression.left.value, 1n);
});

test('#4690 malformed value identities fail closed and never mint an exact expression', () => {
  for (const bad of [['v1'], ['v1', 'v2'], [], { id: 'v1' }, {}, [null], true, false, 5, 1n, '', '   ', '\t\n']) {
    const out = translateSemanticIR({ id: bad, const: 42n }, { bitWidth: 8 });
    assert.equal(out.status, TRANSLATION_STATUS.UNSUPPORTED, `id ${String(bad)}`);
    assert.equal(out.expression.kind, EXPR_KIND.UNKNOWN_SEMANTIC, `id ${String(bad)}`);
    assert.equal(out.expression.reason, MALFORMED_REASON, `id ${String(bad)}`);
    assert.ok(out.semanticUnknowns > 0, `id ${String(bad)}`);
    assert.ok(
      out.unsupportedEntities.some((entity) => entity.reason === MALFORMED_REASON),
      `id ${String(bad)}`,
    );
    assert.equal(out.completeness.translation, COMPLETENESS_STATUS.UNSUPPORTED, `id ${String(bad)}`);
  }
});

test('#4690 a structured id cannot fabricate a shared cycle identity for another value', () => {
  const out = translateSemanticIR(
    addInst({ id: 'cyc', const: 1n }, { id: ['cyc'], const: 2n }),
    { bitWidth: 8 },
  );
  assert.ok(
    !out.assumptions.some((assumption) => assumption.id === 'cycle_cyc'),
    'a laundered identity must not be reported as a cycle',
  );
  assert.equal(out.assumptions.length, 0);
});

test('#4690 id-less values must not share one anonymous memo entry', () => {
  const out = translateSemanticIR(
    addInst({ const: 1n }, { const: 2n }, 'add-anon'),
    { bitWidth: 8 },
  );
  assert.equal(out.status, TRANSLATION_STATUS.EXACT);
  assert.notEqual(out.expression.left, out.expression.right);
  assert.equal(out.expression.left.value, 1n);
  assert.equal(out.expression.right.value, 2n);
  assert.equal(evaluated(out.expression), 3n);
});

test('#4690 canonical string ids keep their existing memoization', () => {
  const shared = { id: 'v1', const: 1n, origin: '0x1000' };
  const out = translateSemanticIR(addInst(shared, { id: 'v1', const: 1n, origin: '0x1000' }, 'add-memo'), {
    bitWidth: 8,
  });
  assert.equal(out.status, TRANSLATION_STATUS.EXACT);
  assert.equal(out.semanticUnknowns, 0);
  assert.equal(out.expression.left, out.expression.right, 'canonical id must still memo-hit');
  assert.equal(evaluated(out.expression), 2n);

  const defined = { id: 'vd', def: { id: 'i-not', op: 'un', subOp: 'not', args: [{ value: { id: 'va', reg: 'x0', kind: 'arg' } }] } };
  const memoized = translateSemanticIR(addInst(defined, { ...defined }, 'add-memo-2'), { bitWidth: 8 });
  assert.equal(memoized.status, TRANSLATION_STATUS.EXACT);
  assert.equal(memoized.expression.left, memoized.expression.right);
});

test('#4690 valid string-identity cycle detection is unchanged', () => {
  const loop = { id: 'vloop', origin: '0x100' };
  loop.def = { id: 'i-add', op: 'bin', subOp: 'add', args: [{ value: loop }, { value: { id: 'vone', const: 1n } }] };
  const out = translateSemanticIR(loop, { bitWidth: 8 });
  assert.ok(out.assumptions.some((assumption) => assumption.id === 'cycle_vloop'));
  assert.equal(out.assumptions[0].kind, 'phi-cycle-unroll-boundary');
  assert.equal(out.expression.left.kind, EXPR_KIND.UNKNOWN_SEMANTIC);
  assert.equal(out.expression.left.reason, 'ssa-dependency-cycle');
});

test('#4690 well-formed translations stay exact and deterministic', () => {
  const shape = (expr) => {
    if (!expr) return null;
    if (expr.kind === EXPR_KIND.BINARY) return `${expr.op}(${shape(expr.left)},${shape(expr.right)})`;
    if (expr.kind === EXPR_KIND.CONST) return `const:${expr.value.toString()}`;
    if (expr.kind === EXPR_KIND.FRESH_SYMBOL) return `sym:${expr.name}`;
    return expr.kind;
  };
  const build = () => translateSemanticIR(
    {
      id: 'add-root',
      op: 'bin',
      subOp: 'add',
      args: [
        { value: { id: 'v1', reg: 'x0', kind: 'arg', index: 0 } },
        { value: { id: 'v2', const: 2n } },
      ],
    },
    { bitWidth: 8 },
  );
  const first = build();
  const second = build();
  assert.equal(first.status, TRANSLATION_STATUS.EXACT);
  assert.equal(first.semanticUnknowns, 0);
  assert.equal(first.unsupportedEntities.length, 0);
  assert.equal(first.completeness.translation, COMPLETENESS_STATUS.COMPLETE);
  assert.equal(shape(first.expression), shape(second.expression));
  assert.equal(first.expression.left.kind, EXPR_KIND.FRESH_SYMBOL);
  assert.equal(first.expression.right.value, 2n);
});
