import assert from 'node:assert/strict';
import { findSink } from '../js/comprehend.js';
import { regNode } from '../js/expr.js';

const BASE = 0x100000000n;
const carried = regNode('x19', 0);
const addr = (row) => BASE + BigInt(row * 4);
const insn = (row, extra = {}) => ({
  row,
  address: addr(row),
  mnemonic: 'nop',
  reads: [],
  isReturn: false,
  isBranch: false,
  isCall: false,
  isConditional: false,
  branchTarget: null,
  ...extra,
});
const vgFor = (callRows) => ({
  memWrites: [],
  defs: new Map(),
  at(row, reg) {
    return callRows.has(row) && reg === 'x0' ? carried : null;
  },
});
const acc = { steps: [{ row: 0, after: carried }] };

// #1748: one branch consumes the accumulator, while a sibling branch returns
// without consuming it. A unique observed sink is not certain in that CFG.
{
  const model = {
    instructions: [
      insn(0),
      insn(1, { mnemonic: 'b.eq', isBranch: true, isConditional: true, branchTarget: addr(3) }),
      insn(2, { mnemonic: 'ret', isReturn: true }),
      insn(3, { mnemonic: 'bl', isBranch: true, isCall: true }),
      insn(4, { mnemonic: 'ret', isReturn: true }),
    ],
    calls: [{ row: 3, name: 'foo', target: 0x200000000n }],
  };
  const sink = findSink(model, vgFor(new Set([3])), acc);
  assert.equal(sink?.kind, 'ambiguous');
  assert.equal(sink?.certain, false);
  assert.equal(sink?.candidates?.length, 1);
  assert.equal(sink.candidates[0].name, 'foo');
}

// A sibling branch that needs one ordinary CFG step before its own sink must
// still be explored after another branch has already found a sink.
{
  const model = {
    instructions: [
      insn(0),
      insn(1, { mnemonic: 'b.eq', isBranch: true, isConditional: true, branchTarget: addr(4) }),
      insn(2),
      insn(3, { mnemonic: 'bl', isBranch: true, isCall: true }),
      insn(4, { mnemonic: 'bl', isBranch: true, isCall: true }),
      insn(5, { mnemonic: 'ret', isReturn: true }),
    ],
    calls: [
      { row: 3, name: 'bar', target: 0x200000100n },
      { row: 4, name: 'foo', target: 0x200000000n },
    ],
  };
  const sink = findSink(model, vgFor(new Set([3, 4])), acc);
  assert.equal(sink?.kind, 'ambiguous');
  assert.equal(sink?.certain, false);
  assert.deepEqual(new Set(sink.candidates.map((x) => x.name)), new Set(['foo', 'bar']));
}

console.log('comprehend sink certainty regressions: PASS');
