// Regression for #5364: buildCfg() marked unresolved indirect branches
// (`br xN`, branchTarget == null) as isExit = true. exitDistance() then
// classified any conditional whose one arm reached such a dispatch as
// `early-return`, asserting a return the CFG cannot prove. An unknown indirect
// transfer is an unknown boundary, not a confirmed exit: it keeps its
// EDGE.UNKNOWN successor but no longer counts as an exit. Confirmed exits
// (`ret`, unconditional external tail jumps) keep their semantics.
import assert from 'node:assert/strict';
import { buildCfg, EDGE } from '../js/cfg.js';

const block = (startRow, endRow = startRow) => ({ startRow, endRow, rows: [] });
const insn = (row, address, patch = {}) => ({
  row, address: BigInt(address), mnemonic: patch.mnemonic || 'mov', data: false,
  isBranch: false, isCall: false, isReturn: false, isConditional: false, branchTarget: null,
  ...patch,
});

function fixture(instructions) {
  const rows = new Map(instructions.map((x) => [x.address.toString(), x.row]));
  return buildCfg(
    { instructions, basicBlocks: instructions.map((x) => block(x.row)), semantic: [] },
    { rowOfAddress: (addr) => rows.get(BigInt(addr).toString()) ?? null },
  );
}

// B0: cbz x1 -> B1 (taken) / fall B2; B1: br x8 (unknown); B2: add + ret path.
{
  const cfg = fixture([
    insn(0, 0x1000, { mnemonic: 'cbz', isBranch: true, isConditional: true, branchTarget: 0x1004n }),
    insn(1, 0x1004, { mnemonic: 'br', isBranch: true }),
    insn(2, 0x1008, { mnemonic: 'add' }),
    insn(3, 0x100c, { mnemonic: 'ret', isReturn: true }),
  ]);
  const brBlock = cfg.nodes[1];
  assert.deepEqual(brBlock.succ, [{ to: -1, kind: EDGE.UNKNOWN }],
    'indirect branch keeps its unknown edge');
  assert.equal(brBlock.isExit, false, 'unknown indirect boundary is not a confirmed exit');
  assert.ok(!cfg.exits.includes(1), 'cfg.exits must not list the unknown indirect block');

  const shapes = cfg.shapes.filter((s) => s.kind === 'early-return');
  assert.equal(shapes.length, 0,
    'a conditional arm ending in an unresolved dispatch must not become early-return');
}

// `ret` still terminates and still grounds early-return classification.
{
  const cfg = fixture([
    insn(0, 0x2000, { mnemonic: 'cbz', isBranch: true, isConditional: true, branchTarget: 0x2008n }),
    insn(1, 0x2004, { mnemonic: 'ret', isReturn: true }),
    insn(2, 0x2008, { mnemonic: 'add' }),
    insn(3, 0x200c, { mnemonic: 'ret', isReturn: true }),
  ]);
  assert.equal(cfg.nodes[1].isExit, true, 'ret remains a confirmed exit');
  assert.ok(cfg.shapes.some((s) => s.kind === 'early-return'),
    'the early-return shape for the ret arm is preserved');
}

// Unconditional branch to a target outside the function stays a confirmed exit
// (tail-call semantics are not regressed).
{
  const cfg = fixture([
    insn(0, 0x3000, { mnemonic: 'cbz', isBranch: true, isConditional: true, branchTarget: 0x3004n }),
    insn(1, 0x3004, { mnemonic: 'b', isBranch: true, branchTarget: 0x9999n }),
    insn(2, 0x3008, { mnemonic: 'add' }),
    insn(3, 0x300c, { mnemonic: 'ret', isReturn: true }),
  ]);
  assert.equal(cfg.nodes[1].isExit, true,
    'confirmed external unconditional branch remains an exit');
}

console.log('issue #5364 indirect branch is not a confirmed exit regression: PASS');
