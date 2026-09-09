// Issue #5250 regression: SymbolIndex.functionList()/symbolList() coerced the
// result cap through finiteListMax() -> Number(), so numeric strings, arrays
// and booleans became real count authorities (Number(['1']) === 1) and
// fractional caps like 0.5 truncated the list to a "0.5 result" bound. A
// count authority must be a primitive positive safe integer.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SymbolIndex } from '../js/symbols.js';

function index() {
  return new SymbolIndex({
    funcs: new BigUint64Array([0x1000n, 0x2000n, 0x3000n]),
    addrs: new BigUint64Array([0x1000n, 0x2000n, 0x3000n]),
    kinds: new Uint8Array([0, 0, 0]),
    flags: new Uint8Array([0, 0, 0]),
    names: ['a', 'b', 'c'],
  });
}

test('#5250 structured and fractional caps are rejected, not coerced', () => {
  const si = index();
  for (const bad of [0.5, 1.5, ['1'], true, false, '1', NaN, Infinity, 0, -1]) {
    assert.throws(() => si.functionList(null, bad), TypeError, `functionList max ${String(bad)} must be rejected`);
    assert.throws(() => si.symbolList({ max: bad }), TypeError, `symbolList max ${String(bad)} must be rejected`);
  }
});

test('#5250 omitted and positive-integer caps keep the exact prior behavior', () => {
  const si = index();
  assert.equal(si.functionList().length, 3);
  assert.equal(si.functionList(null, 1).length, 1);
  assert.equal(si.functionList(null, 2).length, 2);
  assert.equal(si.symbolList().length, 3);
  assert.equal(si.symbolList({ max: 1 }).length, 1);
});
