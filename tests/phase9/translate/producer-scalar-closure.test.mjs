import test from 'node:test';
import assert from 'node:assert/strict';
import { OP } from '../../../js/ir-base.js';
import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';
import { evaluateExpr } from '../../../js/symbolic/expr/index.js';
import { translateMemoryScalar } from '../../../js/symbolic/translate/memory.js';
import { createBv } from '../../../js/symbolic/expr/index.js';
const literal = (id, bits, n) => ({ id, bits, const: BigInt(n) });
const instruction = (op, fields, values, bits) => {
  const dst = { id: 'result', bits };
  const inst = { id: 'operation', op, ...fields, args: values.map(value => ({ value })), dst };
  dst.def = inst;
  return inst;
};
const translated = inst => translateSemanticIR(inst);
const value = inst => { const r = translated(inst); assert.equal(r.status, 'exact', JSON.stringify(r.unsupportedEntities)); return evaluateExpr(r.expression).value; };

test('producer sub and result bits are preserved at the raw public translator', () => {
  const inst = instruction(OP.BIN, { sub: 'xor' }, [literal('a', 8, 5), literal('b', 8, 3)], 8);
  assert.equal(value(inst), 6n);
  assert.equal(translated(inst).expression.sort.width, 8);
});
test('comparison uses operand width independently of its Bool result and extra signedness', () => {
  const inst = instruction(OP.CMP, { cond: 'lt', extra: { signed: true } }, [literal('a', 8, 255), literal('b', 8, 0)], 1);
  assert.equal(value(inst), true);
});
test('casts retain source width and literal producer payload', () => {
  const source = literal('a', 8, 128);
  assert.equal(value(instruction(OP.MOV, { sub: 'sext' }, [source], 32)), 0xffffff80n);
  assert.equal(value(instruction(OP.UN, { sub: 'zext' }, [source], 32)), 128n);
  assert.equal(value(instruction(OP.CONST, { extra: { value: 257n } }, [], 8)), 1n);
});
test('raw select consumes canonical conditionValue and does not default to true', () => {
  const cond = instruction(OP.CMP, { cond: 'eq' }, [literal('a', 8, 1), literal('b', 8, 2)], 1);
  const sel = instruction(OP.SEL, { conditionValue: cond.dst }, [literal('yes', 8, 7), literal('no', 8, 9)], 8);
  assert.equal(value(sel), 9n);
  delete sel.conditionValue;
  assert.notEqual(translated(sel).status, 'exact');
});
test('anonymous constants and numeric zero IDs do not alias in translation memoization', () => {
  assert.equal(value(instruction(OP.BIN, { subOp: 'sub' }, [{ const: 7n, bits: 8 }, { const: 2n, bits: 8 }], 8)), 5n);
  assert.equal(value(instruction(OP.BIN, { subOp: 'add' }, [literal(0, 8, 3), literal(1, 8, 2)], 8)), 5n);
});
test('missing or conflicting opcodes, widths and literal declarations fail closed', () => {
  const pair = [literal('a', 8, 1), literal('b', 8, 2)];
  for (const inst of [
    instruction(OP.BIN, {}, pair, 8),
    instruction(OP.BIN, { sub: 'xor', subOp: 'add' }, pair, 8),
    instruction(OP.BIN, { sub: 'add' }, [pair[0], literal('b', 16, 2)], 8),
    instruction(OP.CONST, {}, [], 8),
    instruction(OP.CONST, { value: 1n, extra: { value: 2n } }, [], 8),
    instruction(OP.MOV, { sub: 'sext' }, [pair[0]], 4),
    instruction(OP.UN, { sub: 'not' }, [...pair], 8),
  ]) assert.notEqual(translated(inst).status, 'exact', String(inst.sub ?? inst.op));
});
test('a stale propagated .const never overrides an actual nonconstant definition', () => {
  const arg = { id: 'a', bits: 8, kind: 'arg', reg: 'x0' };
  const inst = instruction(OP.BIN, { sub: 'xor' }, [arg, literal('b', 8, 1)], 8);
  inst.dst.const = 8n;
  const r = translateSemanticIR(inst.dst);
  assert.equal(r.status, 'exact');
  assert.equal(evaluateExpr(r.expression, { arg_x0: 3n }).value, 2n);
});
test('duplicate SSA identity with different value objects cannot become exact', () => {
  const inst = instruction(OP.BIN, { sub: 'sub' }, [literal('same', 8, 1), literal('same', 8, 2)], 8);
  assert.notEqual(translated(inst).status, 'exact');
});
test('translation checks cancel and work limits before returning an exact expression', () => {
  const inst = instruction(OP.BIN, { sub: 'xor' }, [literal('a', 8, 1), literal('b', 8, 2)], 8);
  const signal = AbortSignal.abort();
  assert.notEqual(translateSemanticIR(inst, { signal }).status, 'exact');
  assert.notEqual(translateSemanticIR(inst, { maxWorkItems: 0 }).status, 'exact');
});
test('raw and executed lowering share machine division policy', () => {
  const policy = { bundleCompleteness: 'exact', operationMetadata: { divisionByZero: 'returns-zero', signedOverflow: 'not-applicable', widthBits: 32 } };
  const inst = instruction(OP.BIN, { sub: 'udiv', extra: { completeness: 'complete', attributes: { machineEffects: policy } } }, [literal('a', 32, 4), literal('b', 32, 0)], 32);
  assert.equal(value(inst), 0n);
  assert.equal(evaluateExpr(translateMemoryScalar(inst, [createBv(32, 4n), createBv(32, 0n)], 32)).value, 0n);
});
