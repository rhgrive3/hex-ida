import assert from 'node:assert/strict';
import test from 'node:test';
import { OP } from '../../../js/ir.js';
import { symbolicExecute, SYM } from '../../../js/symbolic/executor.js';

function shiftResult(operation, bits, left, right, symbolicArgs) {
  const a = { id: 'a', bits, ...(left === null ? { kind: 'arg', reg: 'x0' } : { const: left }) };
  const b = { id: 'b', bits, ...(right === null ? { kind: 'arg', reg: 'x1' } : { const: right }) };
  const value = { id: 'out', bits };
  const inst = { id: 'shift', row: 0, op: OP.BIN, sub: operation, args: [{ value: a }, { value: b }], dst: value };
  value.def = inst;
  const ret = { id: 'ret', row: 1, op: OP.RET, args: [{ value }] };
  const result = symbolicExecute({ entry: 0, blocks: [{ index: 0, phis: [], succ: [], insts: [inst, ret] }] }, { symbolicArgs });
  assert.equal(result.truncated, false);
  assert.equal(result.paths.length, 1);
  return result.paths[0];
}

test('#4621 non-power-of-two constant shifts wrap modulo the width', () => {
  // 24-bit lshr(0x800000, 8): masking the amount with 23 collapsed 8 to 0.
  const got = shiftResult('lshr', 24, 0x800000n, 8n);
  assert.equal(got.status, 'complete');
  assert.equal(got.returnValue.kind, SYM.CONST);
  assert.equal(got.returnValue.value, 0x8000n);
  // Amounts at and beyond the width still wrap, never truncate the amount.
  assert.equal(shiftResult('lshr', 24, 0x800000n, 32n).returnValue.value, 0x8000n);
  assert.equal(shiftResult('shl', 24, 1n, 25n).returnValue.value, 2n);
  assert.equal(shiftResult('ashr', 24, -8n, 2n).returnValue.value, 0xfffffen);
});

test('#4621 power-of-two symbolic shifts keep the exact mask normalization', () => {
  const expression = shiftResult('lshr', 32, null, null);
  assert.equal(expression.status, 'complete');
  assert.equal(expression.returnValue.op, 'lshr');
  assert.equal(expression.returnValue.args[1].op, 'and');
  assert.equal(expression.returnValue.args[1].args[1].value, 31n);
  const bound = shiftResult('lshr', 32, null, null, { 0: 0x800000n, 1: 36n });
  assert.equal(bound.returnValue.kind, SYM.CONST);
  assert.equal(bound.returnValue.value, 0x80000n);
});

test('#4621 non-power-of-two symbolic shifts fail closed instead of masking wrong', () => {
  const got = shiftResult('lshr', 24, null, null);
  assert.equal(got.status, 'unknown');
  assert.equal(got.returnValue.kind, SYM.UNKNOWN);
  assert.equal(got.returnValue.reason, 'shift-amount-normalization-unsupported');
  assert.equal(got.returnValue.detail.bits, 24);
});
