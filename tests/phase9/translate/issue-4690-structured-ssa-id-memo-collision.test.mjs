// Regression for #4690: translateValue() laundered every val.id through
// String(val.id) and used the result as memo/cycle identity, so a structured
// id such as ['v1'] aliased onto the canonical string id 'v1'
// (String(['v1']) === 'v1'). Distinct SSA values were silently merged into
// one memo entry and the solver expression was built from the wrong operand
// as an EXACT translation. Contract now: only canonical primitive string ids
// (the semantic-ssa value-id producer contract) participate in memo/cycle
// identity; structured or otherwise malformed ids fail closed to an explicit
// unknown and never fabricate an exact expression.
import assert from 'node:assert/strict';
import test from 'node:test';

import { OP } from '../../../js/ir-base.js';
import { EXPR_KIND, BV_BINARY_OP } from '../../../js/symbolic/expr/kinds.js';
import { TRANSLATION_STATUS } from '../../../js/symbolic/translate/support-matrix.js';
import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';

test('#4690 array id must not alias onto the canonical string id in the memo (1+2 stays 1+2)', () => {
  const target = {
    id: 'add-1',
    op: OP.BIN,
    subOp: 'add',
    args: [
      { value: { id: 'v1', const: 1n } },
      { value: { id: ['v1'], const: 2n } },
    ],
  };
  const translated = translateSemanticIR(target, { bitWidth: 8 });
  assert.notEqual(translated.status, TRANSLATION_STATUS.EXACT,
    'a structured value id must never yield an EXACT expression');
  assert.equal(translated.status, TRANSLATION_STATUS.UNSUPPORTED);
  assert.ok(translated.semanticUnknowns > 0);
  assert.equal(translated.expression.kind, EXPR_KIND.BINARY);
  assert.equal(translated.expression.op, BV_BINARY_OP.ADD);
  assert.equal(translated.expression.left.kind, EXPR_KIND.CONST);
  assert.equal(translated.expression.left.value, 1n);
  assert.notEqual(translated.expression.right.kind, EXPR_KIND.CONST,
    'the malformed-id operand must not resolve to the memoized left constant (1+2 must not become 1+1)');
  assert.ok(translated.unsupportedEntities.some((entry) => String(entry.reason).includes('id')),
    'the fail-closed reason must be attributable to the value id');
});

test('#4690 malformed structured ids never enter memo or cycle identity', () => {
  const shapes = [['v1'], { v: 'v1' }, true, 42, 0n, () => 'v1'];
  for (const id of shapes) {
    const translated = translateSemanticIR({
      id: 'inst-1',
      op: OP.BIN,
      subOp: 'add',
      args: [
        { value: { id: 'v1', const: 1n } },
        { value: { id, const: 2n } },
      ],
    }, { bitWidth: 8 });
    assert.notEqual(translated.status, TRANSLATION_STATUS.EXACT,
      `id ${String(id)} must not fabricate an exact expression`);
    assert.equal(translated.status, TRANSLATION_STATUS.UNSUPPORTED,
      `id ${String(id)} must fail closed`);
    assert.ok(translated.unsupportedEntities.length > 0);
  }
  const cycleLaunder = translateSemanticIR({
    id: 'inst-2',
    op: OP.BIN,
    subOp: 'add',
    args: [
      { value: { id: 'x', const: 1n } },
      { value: { id: ['x'], const: 2n } },
    ],
  }, { bitWidth: 8 });
  assert.equal(cycleLaunder.status, TRANSLATION_STATUS.UNSUPPORTED);
  assert.equal(cycleLaunder.expression.right.kind, EXPR_KIND.UNKNOWN_SEMANTIC,
    'a structured id must not launder into the active/memo identity of a canonical id');
});

test('#4690 canonical string id memoization is preserved', () => {
  const shared = { id: 'v-shared', const: 7n };
  const translated = translateSemanticIR({
    id: 'mul-1',
    op: OP.BIN,
    subOp: 'mul',
    args: [{ value: shared }, { value: shared }],
  }, { bitWidth: 8 });
  assert.equal(translated.status, TRANSLATION_STATUS.EXACT);
  assert.equal(translated.semanticUnknowns, 0);
  assert.equal(translated.expression.kind, EXPR_KIND.BINARY);
  assert.equal(translated.expression.left, translated.expression.right,
    'the canonical id memo must keep returning the same node for the same value');
});

test('#4690 canonical cycle detection on typed identity still fires', () => {
  const recursive = { id: 'c', def: null };
  recursive.def = { id: 'i-c', op: OP.BIN, subOp: 'add', args: [{ value: recursive }, { value: { id: 'k', const: 3n } }] };
  const translated = translateSemanticIR(
    { id: 'i-root', op: OP.BIN, subOp: 'add', args: [{ value: recursive }, { value: { id: 'k2', const: 2n } }] },
    { bitWidth: 8 },
  );
  assert.equal(translated.status, TRANSLATION_STATUS.UNSUPPORTED);
  assert.ok(translated.assumptions.some((a) => String(a.id).includes('cycle_c')),
    'the canonical string-id cycle path must stay intact under the typed identity contract');
});

test('#4690 deterministic repeat translation of the collision case', () => {
  const build = () => translateSemanticIR({
    id: 'add-1',
    op: OP.BIN,
    subOp: 'add',
    args: [
      { value: { id: 'v1', const: 1n } },
      { value: { id: ['v1'], const: 2n } },
    ],
  }, { bitWidth: 8 });
  const first = build();
  const second = build();
  assert.equal(first.status, second.status);
  assert.equal(first.semanticUnknowns, second.semanticUnknowns);
  assert.deepEqual(first.unsupportedEntities, second.unsupportedEntities);
});
