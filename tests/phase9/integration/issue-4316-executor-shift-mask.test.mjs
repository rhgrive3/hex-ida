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
  assert.equal(result.paths[0].status, 'complete');
  return result.paths[0].returnValue;
}

// Mathematical nonnegative modulo supplies a separate oracle for the 32/64-bit
// shift-register domain. Do not repeat the production bit-mask implementation.
function expected(operation, bits, value, count) {
  const n = BigInt(bits);
  const amount = (count % n + n) % n;
  const x = operation === 'ashr' ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value);
  return BigInt.asUintN(bits, operation === 'shl' ? x << amount : x >> amount);
}

for (const bits of [32, 64]) {
  for (const operation of ['shl', 'lshr', 'ashr']) {
    test(`${operation}/${bits} preserves low-bit shift amounts for signed constants`, () => {
      const values = [0n, 1n, 8n, -1n, -8n, 1n << BigInt(bits - 1)];
      const counts = [-129n, -65n, -64n, -33n, -32n, -1n, 0n, 1n, 31n, 32n, 63n, 64n, 65n, 129n];
      for (const value of values) {
        for (const count of counts) {
          const got = shiftResult(operation, bits, value, count);
          assert.equal(got.kind, SYM.CONST);
          assert.equal(got.value, expected(operation, bits, value, count), `${operation}/${bits}(${value}, ${count})`);
          assert.deepEqual(got, shiftResult(operation, bits, value, BigInt.asUintN(bits, count)));
        }
      }
    });
    test(`${operation}/${bits} keeps the same count contract for symbolic and bound inputs`, () => {
      const expression = shiftResult(operation, bits, null, null);
      assert.equal(expression.kind, SYM.OP);
      assert.equal(expression.bits, bits);
      assert.equal(expression.op, operation);
      assert.equal(expression.args[1].op, 'and');
      assert.equal(expression.args[1].args[1].value, BigInt(bits - 1));
      const bound = shiftResult(operation, bits, null, null, { 0: -8n, 1: -1n });
      assert.equal(bound.value, expected(operation, bits, -8n, -1n));
    });
  }
}
