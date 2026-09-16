import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticNode } from '../js/semantics/ir/nodes.js';
import { finalizeLegacyProjection } from '../js/semantics/compat/semantic-ir-v2-to-v1-finalize.js';
import { V1_OP } from '../js/semantics/compat/semantic-ir-v2-to-v1-core.js';

const origin = { instructionIds: ['i0'] };
function binary(inputs) {
  return createSemanticNode({ id: 'n', kind: 'binary', operator: 'add', blockId: 'b', inputs, outputs: ['r'], completeness: 'complete', origin });
}
test('#4658 canonical binary arity remains exactly two on current Semantic IR', () => {
  assert.doesNotThrow(() => binary(['a', 'b']));
  assert.throws(() => binary(['a']), /semantic-ir-node-input-arity/);
  assert.throws(() => binary(['a', 'b', 'c']), /semantic-ir-node-input-arity/);
});
function value(id, constant = null) { return { id, kind: constant == null ? 'def' : 'const', reg: null, const: constant, bits: 64, uses: [], def: null }; }
function projected(args) {
  const dst = value(99);
  return { dst, ir: { instructions: [{ id: 1, block: 0, row: 0, op: V1_OP.BIN, sub: 'add', bits: 64, dst, args: args.map((v) => ({ value: v, bits: 64 })) }], values: [...args, dst] } };
}
test('#4658 compat BIN fold never ignores a third operand', () => {
  const { dst, ir } = projected([value(1, 1n), value(2, 2n), value(3, 100n)]);
  finalizeLegacyProjection(ir);
  assert.equal(dst.const, null);
});
test('#4658 compat BIN fold keeps exact two-operand folding', () => {
  const { dst, ir } = projected([value(1, 1n), value(2, 2n)]);
  finalizeLegacyProjection(ir);
  assert.equal(dst.const, 3n);
});
console.log('issue-4658 semantic IR binary arity and compat folding: ok');
