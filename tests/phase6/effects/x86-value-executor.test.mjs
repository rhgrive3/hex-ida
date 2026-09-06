import assert from 'node:assert/strict';
import test from 'node:test';

import { executeFunction, evaluateBundle } from './helpers.mjs';
import { imm, lift, reg } from '../../phase5/effects/int-control/helpers.mjs';

function x86(family, operands, address, options = {}) {
  return lift(family, operands, { address:BigInt(address), length:4, ...options });
}

function addressKey(address) { return BigInt(address).toString(); }

function branchFunction(family) {
  const code = family.slice(1);
  const cmp = x86('cmp', [reg('rdi', 'read'), reg('rsi', 'read')], 0x1000n);
  const branch = x86(family, [imm(0x1010n)], 0x1004n, { conditionCode:code });
  const falseValue = x86('mov', [reg('rax', 'write'), reg('rsi', 'read')], 0x1008n);
  const falseReturn = x86('ret', [], 0x100cn);
  const trueValue = x86('mov', [reg('rax', 'write'), reg('rdi', 'read')], 0x1010n);
  const trueReturn = x86('ret', [], 0x1014n);
  return new Map([
    [addressKey(0x1000n), cmp],
    [addressKey(0x1004n), branch],
    [addressKey(0x1008n), falseValue],
    [addressKey(0x100cn), falseReturn],
    [addressKey(0x1010n), trueValue],
    [addressKey(0x1014n), trueReturn],
  ]);
}

function executeBranch(family, left, right) {
  return executeFunction(branchFunction(family), {
    entryAddress:0x1000n,
    registers:{ rdi:left, rsi:right, rsp:0x700000n },
  });
}

test('x86 flag state crosses bundles and emitted condition booleans choose the right path', () => {
  for (const [family, predicate] of [
    ['jge', (left, right) => left >= right],
    ['jg', (left, right) => left > right],
    ['jle', (left, right) => left <= right],
  ]) {
    for (const [left, right] of [[7n, 5n], [5n, 7n], [5n, 5n]]) {
      const result = executeBranch(family, left, right);
      assert.equal(result.status, 'returned', `${family} must return`);
      assert.equal(result.registers.get('rax'), predicate(left, right) ? left : right,
        `${family}(${left}, ${right}) must follow its emitted flag condition`);
      assert.equal(result.flags.get('RFLAGS.ZF'), left === right ? 1n : 0n);
    }
  }
});

test('x86 INC uses the existing arithmetic flag primitive and preserves incoming CF', () => {
  const increment = x86('inc', [reg('rax', 'read-write')], 0x2000n);
  const result = x86('ret', [], 0x2004n);
  const execution = executeFunction(new Map([
    [addressKey(0x2000n), increment],
    [addressKey(0x2004n), result],
  ]), {
    entryAddress:0x2000n,
    registers:{ rax:0x7fn, rsp:0x700000n },
    flags:{ 'RFLAGS.CF':1n },
  });

  assert.equal(execution.status, 'returned');
  assert.equal(execution.registers.get('rax'), 0x80n);
  assert.equal(execution.flags.get('RFLAGS.CF'), 1n, 'INC must preserve CF');
  assert.equal(execution.flags.get('RFLAGS.SF'), 0n);
  assert.equal(execution.flags.get('RFLAGS.OF'), 0n);
});

test('x86 evaluator remains conservative for an intrinsic outside its explicit contract', () => {
  const cmp = x86('cmp', [reg('rdi', 'read'), reg('rsi', 'read')], 0x3000n);
  const unsupported = {
    ...cmp,
    operations:cmp.operations.map((operation) => operation.kind === 'intrinsic'
      ? { ...operation, intrinsicId:'x86.flags.not-implemented' }
      : operation),
  };
  assert.throws(
    () => evaluateBundle(unsupported, { rdi:1n, rsi:2n }),
    /unsupported x86 intrinsic x86\.flags\.not-implemented/,
  );
});
