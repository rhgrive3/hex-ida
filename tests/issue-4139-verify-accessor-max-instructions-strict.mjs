// Issue #4139 regression: verifyAccessor() normalized opts.maxInstructions
// through Number(), so Array/boolean/numeric-string values were promoted to
// legitimate verification budget and could widen coverage past the
// fail-closed default of 40 instructions.
import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyAccessor } from '../js/verify.js';

function modelOfLoadAt(offset, count) {
  return {
    instructions: Array.from({ length: count }, (_, row) => ({
      row,
      writes: [],
      reads: [],
      ops: [],
      memory: row === 0
        ? { base: 'x0', disp: offset, kind: 'load', size: 4, indexed: false, stack: false }
        : null,
    })),
  };
}

test('#4139 default budget rejects a 41-instruction model', () => {
  const out = verifyAccessor(modelOfLoadAt(0x20n, 41), { offset: 0x20n });
  assert.equal(out.getter, false, '41 > default 40 must stay unverified');
});

test('#4139 default budget verifies a 40-instruction model', () => {
  const out = verifyAccessor(modelOfLoadAt(0x20n, 40), { offset: 0x20n });
  assert.equal(out.getter, true, '40 <= default 40 keeps existing semantics');
});

test('#4139 non-number maxInstructions is never promoted to budget', () => {
  for (const bad of [['100'], ['41'], '100', '41', ' 100 ', true, false, {}, { valueOf: () => 100 }, 100n, [50], ['']]) {
    const out = verifyAccessor(modelOfLoadAt(0x20n, 41), { offset: 0x20n }, { maxInstructions: bad });
    assert.equal(out.getter, false, `maxInstructions ${String(bad)} must not expand the verification window`);
    assert.equal(out.setter, false);
  }
});

test('#4139 non-finite / non-positive numbers keep the fail-closed default', () => {
  for (const bad of [NaN, Infinity, -Infinity, 0, -100]) {
    const out = verifyAccessor(modelOfLoadAt(0x20n, 41), { offset: 0x20n }, { maxInstructions: bad });
    assert.equal(out.getter, false, `${String(bad)} must fall back to the default 40`);
  }
});

test('#4139 canonical finite number budget semantics are preserved', () => {
  const raised = verifyAccessor(modelOfLoadAt(0x20n, 41), { offset: 0x20n }, { maxInstructions: 100 });
  assert.equal(raised.getter, true, 'explicit 100 covers a 41-insn model');
  const floored = verifyAccessor(modelOfLoadAt(0x20n, 41), { offset: 0x20n }, { maxInstructions: 40.9 });
  assert.equal(floored.getter, false, '40.9 floors to 40; 41 insns stay rejected');
  const exact = verifyAccessor(modelOfLoadAt(0x20n, 50), { offset: 0x20n }, { maxInstructions: 50 });
  assert.equal(exact.getter, true, '50 covers a 50-insn model');
  const shrunk = verifyAccessor(modelOfLoadAt(0x20n, 5), { offset: 0x20n }, { maxInstructions: 3 });
  assert.equal(shrunk.getter, false, 'a smaller explicit number budget still shrinks coverage');
});

test('#4139 malformed budget must not flip getter/setter judgement either way', () => {
  const setterModel = {
    instructions: Array.from({ length: 41 }, (_, row) => ({
      row,
      writes: [],
      reads: [],
      ops: [],
      memory: row === 40
        ? { base: 'x0', disp: 0x28n, kind: 'store', size: 4, indexed: false, stack: false }
        : null,
    })),
  };
  const blocked = verifyAccessor(setterModel, { offset: 0x28n }, { maxInstructions: ['100'] });
  assert.equal(blocked.setter, false, 'string-array budget must not reach the store at row 40');
  const allowed = verifyAccessor(setterModel, { offset: 0x28n }, { maxInstructions: 100 });
  assert.equal(allowed.setter, true, 'number 100 keeps the verified setter path intact');
});
