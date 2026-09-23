import assert from 'node:assert/strict';
import { buildCfg, outline } from '../js/cfg.js';

// Issue #9489: outline() must not leak depth on 1-block self-loops
{
  const model = {
    startRow: 0,
    basicBlocks: [
      { startRow: 0, endRow: 0, rows: [0] },
      { startRow: 1, endRow: 1, rows: [1] }
    ],
    instructions: [
      { row: 0, mnemonic: 'b', isBranch: true, branchTarget: 0x1000n, isReturn: false, isConditional: false },
      { row: 1, mnemonic: 'ret', isBranch: true, isReturn: true }
    ]
  };
  const cfg = buildCfg(model, { rowOfAddress: (a) => (a === 0x1000n ? 0 : null) });
  const result = outline(cfg);

  assert.equal(result.length, 2);
  assert.equal(result[0].index, 0);
  assert.equal(result[0].depth, 0);
  assert.equal(result[0].marker, 'loop-start');

  assert.equal(result[1].index, 1);
  assert.equal(result[1].depth, 0, 'Subsequent block must not leak indentation from 1-block self-loop');
  assert.equal(result[1].marker, 'exit');
}

// Multi-block loop should still indent correctly and decrement on loop-end
{
  const model = {
    startRow: 0,
    basicBlocks: [
      { startRow: 0, endRow: 0, rows: [0] },
      { startRow: 1, endRow: 1, rows: [1] },
      { startRow: 2, endRow: 2, rows: [2] }
    ],
    instructions: [
      { row: 0, mnemonic: 'add', isBranch: false, isReturn: false },
      { row: 1, mnemonic: 'b', isBranch: true, branchTarget: 0x1000n, isReturn: false, isConditional: false },
      { row: 2, mnemonic: 'ret', isBranch: true, isReturn: true }
    ]
  };
  const cfg = buildCfg(model, { rowOfAddress: (a) => (a === 0x1000n ? 0 : null) });
  const result = outline(cfg);

  assert.equal(result[0].index, 0);
  assert.equal(result[0].depth, 0);
  assert.equal(result[0].marker, 'loop-start');

  assert.equal(result[1].index, 1);
  assert.equal(result[1].depth, 1);
  assert.equal(result[1].marker, 'loop-end');

  assert.equal(result[2].index, 2);
  assert.equal(result[2].depth, 0, 'Block after loop-end should return to depth 0');
  assert.equal(result[2].marker, 'exit');
}

console.log('issue-9489 cfg outline self-loop depth regression: PASS');
