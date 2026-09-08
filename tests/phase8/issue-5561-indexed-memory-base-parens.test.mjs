import assert from 'node:assert/strict';
import test from 'node:test';
import './issue-5561-indexed-memory-base-parens.mjs';
import { OP, VK, MK } from '../../js/ir.js';
import { renderValue } from '../../js/decompiler/semantic-core.js';

for (const [sub, operator] of [['and', '&'], ['or', '|'], ['xor', '^']]) {
  for (const scale of [0, 2]) {
    test(`#5561 semantic LOAD with ${sub} base and scale ${scale}`, () => {
      const arg = (id, reg) => ({ id, reg, kind: VK.ARG, bits: 64 });
      const base = { id: 4, bits: 64, def: {
        op: OP.BIN, sub, args: [{ value: arg(1, 'a') }, { value: arg(2, 'b') }],
      } };
      const load = { id: 5, bits: 64, def: {
        op: OP.LOAD, loc: { kind: MK.UNKNOWN },
        addr: { base, index: arg(3, 'i'), scale, size: 0 },
      } };
      const ctx = { opts: {}, exprCache: new Map(), exprActive: new Set(), exprNodes: 0 };
      assert.equal(renderValue(load, ctx),
        `memory[(a ${operator} b) + ${scale ? '(i << 2)' : 'i'}]`);
    });
  }
}
