import assert from 'node:assert/strict';
import { SYM, expressionText, symbolic, symbolicExecute } from '../js/symbolic/executor.js';

const emptyIr = { entry: 0, blocks: [{ index: 0, insts: [], succ: [] }] };

for (const [key, value] of [
  ['maxPaths', ['1']],
  ['maxSteps', ['8']],
  ['maxBranches', ['1']],
  ['maxBlockVisits', ['1']],
  ['timeoutMs', ['10']],
  ['maxPaths', '1'],
  ['maxPaths', true],
]) {
  assert.throws(
    () => symbolicExecute(emptyIr, { [key]: value }),
    TypeError,
    `${key} must reject non-number authority values`,
  );
}
assert.doesNotThrow(() => symbolicExecute(emptyIr, { maxPaths: 1, maxSteps: 8, maxBranches: 1, maxBlockVisits: 1, timeoutMs: 10 }));

const injected = symbolic('x', { kind: SYM.CONST, name: 'y', value: 1n, source: 'test' });
assert.equal(injected.kind, SYM.SYMBOL);
assert.equal(injected.name, 'x');
assert.equal(injected.source, 'test');
assert.equal(injected.value, 1n);

const lhs = { kind: SYM.SYMBOL, name: 'a' };
const rhs = { kind: SYM.SYMBOL, name: 'b' };
assert.match(expressionText({ kind: SYM.OP, op: 'add', args: [lhs, rhs], bits: 8 }), /^i8/);
assert.doesNotMatch(expressionText({ kind: SYM.OP, op: 'add', args: [lhs, rhs], bits: ['8'] }), /^i8/);
assert.doesNotMatch(expressionText({ kind: SYM.OP, op: 'add', args: [lhs, rhs], bits: '8' }), /^i8/);

console.log('issues 3252/3256/3259 regressions passed');
