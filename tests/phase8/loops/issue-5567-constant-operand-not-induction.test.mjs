import assert from 'node:assert/strict';
import test from 'node:test';

import { repairCanonicalPostTestLoop } from '../../../js/decompiler/loop-repair.js';

function resultForPrior(prior) {
  const one = { id: 'one', bits: 64, const: 1n };
  const limit = { id: 'limit', bits: 64, const: 10n };
  const updated = { id: 'u', bits: 64, const: null, def: { op: 'bin', sub: 'add', args: [{ value: prior }, { value: one }] } };
  const flags = { id: 'flags', bits: 4, def: { op: 'cmp', sub: 'sub', bits: 64, args: [{ value: updated }, { value: limit }] } };
  const term = { op: 'cbr', row: 1, address: 0x1004n, cond: 'lt', extra: { target: 0x1000n }, args: [{ value: flags }] };
  const loop = { header: 0, nodes: new Set([0]), exits: new Set([1]) };
  const block = { index: 0, addr: 0x1000n, startRow: 0, endRow: 1, succ: [0, 1], insts: [term] };
  const result = {
    semantic: true,
    ir: { loops: [loop], blocks: [block] },
    types: { values: new Map() },
    ctx: { inductions: [] },
    lines: [
      { kind: 'ctrl', indent: 1, row: 1, text: 'if (cond) goto loc_1000;' },
      { kind: 'stmt', indent: 1, row: 1, text: 'goto loc_2000;' },
    ],
    warnings: [],
  };
  return { result, updated, loop, blockAddress: (index) => result.ir.blocks[index].addr };
}

function assertNotRewritten(prior) {
  const { result, blockAddress } = resultForPrior(prior);
  repairCanonicalPostTestLoop(result, blockAddress);
  assert.equal(result.ctx.loopRepair, undefined);
  assert.deepEqual(result.lines.map((line) => line.text), [
    'if (cond) goto loc_1000;',
    'goto loc_2000;',
  ]);
}

test('#5567 constant compared operand without loop-carried state is not rewritten', () => {
  assertNotRewritten({ id: 'zero', bits: 64, const: 0n });
});

test('#5567 BIN prior with missing defining-block provenance fails closed', () => {
  const seed = { id: 'seed', bits: 64, const: 0n };
  assertNotRewritten({
    id: 'prior-missing-block', bits: 64, const: 0n,
    def: { op: 'bin', sub: 'add', args: [{ value: seed }, { value: seed }] },
  });
});

test('#5567 BIN prior explicitly defined outside the loop fails closed', () => {
  const seed = { id: 'seed', bits: 64, const: 0n };
  assertNotRewritten({
    id: 'prior-outside-block', bits: 64, const: 0n,
    def: { op: 'bin', sub: 'add', block: 2, args: [{ value: seed }, { value: seed }] },
  });
});

test('#5567 exact PHI recurrence remains eligible for post-test repair', () => {
  const zero = { id: 'zero', bits: 64, const: 0n };
  const prior = { id: 'prior', bits: 64, const: null, def: null };
  const { result, updated, blockAddress } = resultForPrior(prior);
  prior.def = { op: 'phi', incoming: [{ from: 1, value: zero }, { from: 0, value: updated }] };
  repairCanonicalPostTestLoop(result, blockAddress);
  assert.equal(result.ctx.loopRepair, 'ir-def-use');
  assert.ok(result.lines.some((line) => line.text === 'do {'));
  assert.ok(result.lines.some((line) => line.text.startsWith('int64 i = 0;')));
  assert.ok(result.lines.some((line) => line.text === 'i++;'));
  assert.ok(result.lines.some((line) => /\} while \(/.test(line.text)));
});
