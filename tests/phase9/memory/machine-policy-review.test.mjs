import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute, translate } from '../../../js/symbolic/index.js';
import { machineIR, identity } from './main-fixtures.mjs';
import { createBv, evaluateExpr } from '../../../js/symbolic/expr/index.js';
import { translateMemoryScalar } from '../../../js/symbolic/translate/memory.js';
const execute = (ir, numerator, denominator) => symbolicExecute(ir, {
  captureValues: true, symbolicArgs: { x1: numerator, x2: denominator }, byteMemory: { identity },
});
const translated = (ir, inst, result) => translate.translateSemanticIR(inst, { ir, identity, executionSnapshot: result.paths[0].snapshot });

test('real machine division consumes the declared returns-zero and signed-overflow policy', () => {
  for (const sub of ['udiv', 'sdiv']) for (const bits of [32, 64]) {
    const r = bits === 32 ? 'w' : 'x', ir = machineIR([`${sub} ${r}0, ${r}1, ${r}2`, 'ret']);
    const inst = ir.instructions.find(i => i.sub === sub);
    assert.equal(inst.extra.attributes.machineEffects.operationMetadata.divisionByZero, 'returns-zero');
    for (const [a, b] of [[4n, 0n], [8n, 2n], [1n << BigInt(bits - 1), (1n << BigInt(bits)) - 1n]]) {
      const result = execute(ir, a, b); assert.equal(result.status, 'complete', result.reason);
      const signed = x => x >= (1n << BigInt(bits - 1)) ? x - (1n << BigInt(bits)) : x;
      const quotient = b === 0n ? 0n : sub === 'sdiv' ? signed(a) / signed(b) : a / b;
      const expected = (quotient + (1n << BigInt(bits))) % (1n << BigInt(bits));
      assert.equal(translated(ir, inst, result).expression.value, expected, `${sub}/${bits}/${a}/${b}`);
    }
  }
});
test('unknown machine division policy fails closed instead of using canonical BV defaults', () => {
  const ir = machineIR(['udiv w0, w1, w2', 'ret']);
  const inst = ir.instructions.find(i => i.sub === 'udiv');
  inst.extra.attributes = structuredClone(inst.extra.attributes);
  const metadata = inst.extra.attributes.machineEffects.operationMetadata;
  for (const policy of ['traps', 'unknown', null]) {
    metadata.divisionByZero = policy;
    const result = execute(ir, 8n, 2n); assert.equal(result.status, 'partial'); assert.deepEqual(result.paths, []);
  }
});
test('machine policy mutation invalidates an already issued execution snapshot', () => {
  const ir = machineIR(['sdiv w0, w1, w2', 'ret']), inst = ir.instructions.find(i => i.sub === 'sdiv');
  inst.extra.attributes = structuredClone(inst.extra.attributes);
  const result = execute(ir, 8n, 2n); assert.equal(result.status, 'complete', result.reason);
  inst.extra.attributes.machineEffects.operationMetadata.signedOverflow = 'traps';
  assert.equal(translated(ir, inst, result).status, 'unsupported');
});
test('plain canonical BV division retains its existing all-ones zero-divisor contract', () => {
  const expression = translateMemoryScalar({ op: 'bin', sub: 'udiv' }, [createBv(8, 5n), createBv(8, 0n)], 8);
  assert.equal(evaluateExpr(expression).value, 255n);
});
test('real variable shifts use the existing explicit mask, not a second ISA decoder', () => {
  for (const sub of ['lsl', 'lsr', 'asr']) {
    const ir = machineIR([`${sub} w0, w1, w2`, 'ret']);
    const inst = ir.instructions.find(i => ['shl','lshr','ashr'].includes(i.sub));
    const result = execute(ir, 0x80000001n, 32n); assert.equal(result.status, 'complete', result.reason);
    assert.equal(translated(ir, inst, result).expression.value, 0x80000001n);
  }
});
