import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../../js/blocks-base.js';
import { buildCfg } from '../../js/cfg.js';

const rowOfAddress = (address) => {
  const value = BigInt(address);
  if (value < 0x1000n || value > 0x100cn || (value - 0x1000n) % 4n !== 0n) return null;
  return Number((value - 0x1000n) / 4n);
};

test('direct tail call terminates its basic block before trailing padding', () => {
  const model = buildSemanticModel([
    { row:0, address:0x1000n, mn:'b', ops:'#0x2000' },
    { row:1, address:0x1004n, mn:'nop', ops:'' },
    { row:2, address:0x1008n, mn:'nop', ops:'' },
    { row:3, address:0x100cn, mn:'nop', ops:'' },
  ], { startRow:0, endRow:3, rowOfAddress });

  assert.equal(model.instructions[0].isTailCall, true);
  assert.deepEqual(model.basicBlocks.map(block => block.rows), [[0], [1, 2, 3]]);

  const cfg = buildCfg(model, { rowOfAddress });
  assert.equal(cfg.entry, 0);
  assert.equal(cfg.nodes[0].terminator.row, 0);
  assert.equal(cfg.nodes[0].terminator.target, 0x2000n);
  assert.deepEqual(cfg.nodes[0].succ, []);
  assert.equal(cfg.nodes[0].isExit, true);
  assert.deepEqual(cfg.nodes[1].pred, [], 'padding block remains unreachable from the function entry');
});
