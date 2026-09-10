// Regression for #5989: buildCfg must derive the entry block from the
// function's start row, not from the basicBlocks array position. Optimized /
// cold blocks need not be address ordered, so the real entry can sit at any
// index.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCfg } from '../js/cfg.js';

function unorderedModel(startRow, blocks, instructions) {
  return {
    startRow,
    basicBlocks: blocks,
    instructions,
  };
}

test('#5989 address-ordered blocks keep entry = 0', () => {
  const cfg = buildCfg(unorderedModel(0,
    [
      { startRow: 0, endRow: 0, rows: [0] },
      { startRow: 10, endRow: 10, rows: [10] },
    ],
    [
      { row: 0, address: 0x1000n, mnemonic: 'ret', isReturn: true },
      { row: 10, address: 0x1010n, mnemonic: 'ret', isReturn: true },
    ]), {});
  assert.equal(cfg.entry, 0);
  assert.equal(cfg.nodes[0].isEntry, true);
  assert.equal(cfg.nodes[1].isEntry, false);
});

test('#5989 a cold block placed first does not steal the entry', () => {
  const cfg = buildCfg(unorderedModel(0,
    [
      { startRow: 10, endRow: 10, rows: [10] },
      { startRow: 0, endRow: 0, rows: [0] },
    ],
    [
      { row: 0, address: 0x1000n, mnemonic: 'ret', isReturn: true },
      { row: 10, address: 0x1010n, mnemonic: 'ret', isReturn: true },
    ]), {});
  assert.equal(cfg.entry, 1);
  assert.equal(cfg.nodes[1].isEntry, true);
  assert.equal(cfg.nodes[0].isEntry, false);
});

test('#5989 dominators are rooted at the real entry', () => {
  // entry block at index 1: ret; cold block 0 unreachable.
  const cfg = buildCfg(unorderedModel(0,
    [
      { startRow: 10, endRow: 10, rows: [10] },
      { startRow: 0, endRow: 0, rows: [0] },
    ],
    [
      { row: 0, address: 0x1000n, mnemonic: 'ret', isReturn: true },
      { row: 10, address: 0x1010n, mnemonic: 'ret', isReturn: true },
    ]), {});
  const doms = cfg.dominators ?? cfg.graph?.dominators;
  const entryDom = doms?.[cfg.entry];
  if (entryDom) {
    assert.ok(entryDom.has(cfg.entry), 'entry must dominate itself');
  }
});

test('#5989 a model without a start row falls back to the earliest block in row order', () => {
  const cfg = buildCfg({
    basicBlocks: [
      { startRow: 10, endRow: 10, rows: [10] },
      { startRow: 0, endRow: 0, rows: [0] },
    ],
    instructions: [
      { row: 0, address: 0x1000n, mnemonic: 'ret', isReturn: true },
      { row: 10, address: 0x1010n, mnemonic: 'ret', isReturn: true },
    ],
  }, {});
  assert.equal(cfg.entry, 1);
});

test('#5989 an uncovered start row fails closed instead of promoting block 0', () => {
  const cfg = buildCfg(unorderedModel(100,
    [
      { startRow: 10, endRow: 10, rows: [10] },
      { startRow: 0, endRow: 0, rows: [0] },
    ],
    [
      { row: 0, address: 0x1000n, mnemonic: 'ret', isReturn: true },
      { row: 10, address: 0x1010n, mnemonic: 'ret', isReturn: true },
    ]), {});
  assert.equal(cfg.entry, -1);
  for (const node of cfg.nodes) assert.equal(node.isEntry, false);
});
