import assert from 'node:assert/strict';
import test from 'node:test';

import { repairCanonicalPostTestLoop } from '../../../js/decompiler/loop-repair.js';

function fixture({ inside = 'updated', extraInside = false, extraOutside = false, explicit = false } = {}) {
  const init = { id: 'init', bits: 64, const: 0n };
  const one = { id: 'one', bits: 64, const: 1n };
  const limit = { id: 'limit', bits: 64, const: 10n };
  const reset = { id: 'reset', bits: 64, const: 0n };
  const prior = { id: 'prior', bits: 64, const: null, def: null };
  const updated = { id: 'updated', bits: 64, const: null, def: null };
  const phi = { op: 'phi', incoming: [] };
  prior.def = phi;
  updated.def = { op: 'bin', sub: 'add', args: [{ value: prior }, { value: one }] };

  phi.incoming.push({ from: 1, value: init });
  if (inside === 'updated') phi.incoming.push({ from: 0, value: updated });
  else if (inside === 'other') phi.incoming.push({ from: 0, value: reset });
  if (extraInside) phi.incoming.push({ from: 0, value: updated });
  if (extraOutside) phi.incoming.push({ from: 2, value: init });

  const flags = { id: 'flags', bits: 4, def: null };
  flags.def = { op: 'cmp', sub: 'sub', bits: 64, args: [{ value: updated }, { value: limit }] };
  const term = {
    op: 'cbr',
    row: 1,
    address: 0x1004n,
    cond: 'lt',
    extra: { target: 0x1000n },
    args: [{ value: flags }],
  };
  const loop = { header: 0, nodes: new Set([0]), exits: new Set([1]) };
  const block = {
    index: 0,
    addr: 0x1000n,
    startRow: 0,
    endRow: 1,
    succ: [0, 1],
    insts: [term],
  };
  const result = {
    semantic: true,
    ir: { loops: [loop], blocks: [block] },
    types: { values: new Map([[prior.id, { name: 'int64' }]]) },
    ctx: { inductions: [] },
    lines: [
      { kind: 'ctrl', indent: 1, row: 1, text: 'if (cond) goto loc_1000;' },
      { kind: 'stmt', indent: 1, row: 1, text: 'goto loc_2000;' },
    ],
    warnings: [],
  };
  if (explicit) {
    result.ctx.inductions.push({
      loop,
      phi,
      value: prior,
      inside: updated,
      name: 'i',
      init,
      initText: '0',
      step: 1n,
      conditionInst: term,
      discoveredFrom: 'precomputed-induction',
    });
  }
  return { result, blockAddress: (index) => result.ir.blocks[index].addr };
}

function run(options) {
  const { result, blockAddress } = fixture(options);
  repairCanonicalPostTestLoop(result, blockAddress);
  return result;
}

test('#3826: exact PHI recurrence remains eligible for post-test repair', () => {
  const result = run({ inside: 'updated' });
  assert.equal(result.ctx.loopRepair, 'ir-def-use');
  assert.ok(result.lines.some((line) => line.text === 'do {'));
  assert.ok(result.lines.some((line) => /\} while \(.+\);/.test(line.text)));
});

for (const [name, options] of [
  ['missing backedge incoming', { inside: 'missing' }],
  ['different backedge SSA value', { inside: 'other' }],
  ['ambiguous duplicate backedge incoming', { inside: 'updated', extraInside: true }],
  ['ambiguous duplicate outside incoming', { inside: 'updated', extraOutside: true }],
]) {
  test(`#3826: ${name} fails closed`, () => {
    const result = run(options);
    assert.equal(result.ctx.loopRepair, undefined);
    assert.deepEqual(result.lines.map((line) => line.text), [
      'if (cond) goto loc_1000;',
      'goto loc_2000;',
    ]);
  });
}

test('#3826: already-proven ctx induction path is unchanged', () => {
  const result = run({ inside: 'other', explicit: true });
  assert.equal(result.ctx.loopRepair, 'precomputed-induction');
  assert.ok(result.lines.some((line) => line.text === 'do {'));
});
