// Issue #5806 regression: clampLike() must not count the same SEL operand twice.
// `csel x0, x1, x1, lt` selects the same value on both arms — an unconditional
// copy, not a clamp — even when that value is one of the compared operands.
// The misclassification is reachable wherever SEL/CMP args share value identity
// (e.g. the semantic-IR-v2 -> v1 projection passes shared value objects), so
// this repro uses the documented IR shape through the public valueChain API.
import assert from 'node:assert/strict';
import { OP, VK } from '../js/ir.js';
import { valueChain } from '../js/slice.js';

function makeIr({ pickTrue, pickFalse }) {
  const a = { id: 1, kind: VK.ARG, reg: 'x1', def: null, uses: [] };
  const b = { id: 2, kind: VK.ARG, reg: 'x2', def: null, uses: [] };
  const flags = { id: 3, kind: VK.UNKNOWN, def: null, uses: [] };
  const out = { id: 4, kind: VK.REG, def: null, uses: [] };
  const cmp = { id: 10, block: 0, row: 0, op: OP.CMP, sub: 'sub', dst: flags, args: [{ value: a }, { value: b }] };
  const sel = {
    id: 11, block: 0, row: 1, op: OP.SEL, sub: 'sel', cond: 'lt', dst: out,
    args: [{ value: pickTrue === 'a' ? a : b }, { value: pickFalse === 'a' ? a : b }, { value: flags }],
  };
  const store = { id: 12, block: 0, row: 2, op: OP.STORE, args: [{ value: out }] };
  flags.def = cmp; out.def = sel;
  return { ir: { instructions: [cmp, sel, store], blocks: [{ startRow: 0 }] }, seed: store };
}

function selStepKind({ pickTrue, pickFalse }) {
  const { ir, seed } = makeIr({ pickTrue, pickFalse });
  const chain = valueChain(ir, seed);
  const step = chain.steps.find((s) => s.kind === 'clamp' || s.kind === 'choose');
  return step ? step.kind : null;
}

// The bug: both arms pick the SAME compared operand (a) — must not be a clamp.
{
  const kind = selStepKind({ pickTrue: 'a', pickFalse: 'a' });
  assert.equal(kind, 'choose', `same-pick selection must stay 'choose', got '${kind}'`);
}

// Same shape with the other operand duplicated.
{
  const kind = selStepKind({ pickTrue: 'b', pickFalse: 'b' });
  assert.equal(kind, 'choose', `same-pick selection must stay 'choose', got '${kind}'`);
}

// Positive controls: two DIFFERENT compared operands on the two arms stay clamp.
{
  assert.equal(selStepKind({ pickTrue: 'a', pickFalse: 'b' }), 'clamp');
  assert.equal(selStepKind({ pickTrue: 'b', pickFalse: 'a' }), 'clamp');
}

// A missing operand value can never look like a two-sided clamp.
{
  const a = { id: 1, kind: VK.ARG, reg: 'x1', def: null, uses: [] };
  const flags = { id: 3, kind: VK.UNKNOWN, def: null, uses: [] };
  const out = { id: 4, kind: VK.REG, def: null, uses: [] };
  const cmp = { id: 10, block: 0, row: 0, op: OP.CMP, sub: 'sub', dst: flags, args: [{ value: a }, { value: null }] };
  const sel = { id: 11, block: 0, row: 1, op: OP.SEL, sub: 'sel', cond: 'lt', dst: out, args: [{ value: a }, { value: null }, { value: flags }] };
  flags.def = cmp; out.def = sel;
  const chain = valueChain({ instructions: [cmp, sel], blocks: [{ startRow: 0 }] }, sel);
  const step = chain.steps.find((s) => s.kind === 'clamp' || s.kind === 'choose');
  assert.notEqual(step?.kind, 'clamp');
}

console.log('issue #5806 clamp same-operand regressions: PASS');
