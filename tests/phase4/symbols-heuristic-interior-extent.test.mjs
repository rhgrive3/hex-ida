import assert from 'node:assert/strict';
import test from 'node:test';
import { SymbolIndex } from '../../js/symbols.js';

const guess = { source:'heuristic', confidence:0.55, confirmed:false };
function index(ends = [0x1100n, 0n]) {
  return new SymbolIndex({ funcs:new BigUint64Array([0x1000n, 0x1200n]), funcEnds:new BigUint64Array(ends) });
}

test('heuristic block starts inside proven extents do not split function ownership', () => {
  const symbols = index();
  assert.equal(symbols.addFunctions([0x1050n, 0x10fcn, 0x1100n, 0x1210n], guess), 2);
  assert.deepEqual([...symbols.funcs], [0x1000n, 0x1100n, 0x1200n, 0x1210n]);
  assert.equal(symbols.functionAt(0x1050n).start, 0x1000n);
  assert.equal(symbols.declaredFunctionEnd(0x1000n), 0x1100n);
});

test('unknown bounds and independent confirmed entries retain their existing discovery semantics', () => {
  assert.equal(index([0n, 0n]).addFunctions([0x1050n], guess), 1);
  assert.equal(index().addFunctions([0x1050n], { source:'metadata', confirmed:true }), 1);
  assert.equal(index().addFunctions([0x1050n], { ...guess, confirmed:true }), 1);
});

test('overlapping extents exclude interior guesses even when nearest start has no end', () => {
  const symbols = index([0x1400n, 0n]);
  assert.equal(symbols.addFunctions([0x1300n, 0x1400n], guess), 1);
  assert.deepEqual([...symbols.funcs], [0x1000n, 0x1200n, 0x1400n]);
});

test('invalid cross-region extents do not suppress discovery', () => {
  const symbols = index();
  symbols.setFunctionRegions([{ vmAddr:0x1000n, size:0x80n, exec:true }]);
  assert.equal(symbols.addFunctions([0x1040n], guess), 1);
});
