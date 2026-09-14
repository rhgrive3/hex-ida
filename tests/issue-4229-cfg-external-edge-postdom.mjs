import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCfg } from '../js/cfg.js';

const BASE = 0x100000000n;
const EXTERNAL = BASE + 0x400n;

const rowOfAddress = (addr) => {
  const d = BigInt(addr) - BASE;
  return d >= 0n && d < 0x100n ? Number(d / 4n) : null;
};

const insn = (row, mnemonic, extra = {}) => ({
  row, address: BASE + BigInt(row) * 4n, mnemonic, ...extra,
});
const cond = (row, mnemonic, target) =>
  insn(row, mnemonic, { isBranch:true, isConditional:true, branchTarget:target });
const jump = (row, target) => insn(row, 'b', { isBranch:true, branchTarget:target });
const mov = (row) => insn(row, 'mov');
const ret = (row) => insn(row, 'ret', { isReturn:true });
const block = (row) => ({ startRow:row, endRow:row, rows:[row] });

function cfgOf(rows) {
  return buildCfg({
    startRow: 0,
    basicBlocks: rows.map((_, row) => block(row)),
    instructions: rows,
  }, { rowOfAddress });
}

// B0: cbz -> B2 / fall -> B1 ; B1: cbz -> EXTERNAL / fall -> B2 ; B2 -> ... -> ret
test('#4229 conditional external taken path stays in the post-dominator model', () => {
  const cfg = cfgOf([
    cond(0, 'cbz x0', BASE + 8n),
    cond(1, 'cbz x1', EXTERNAL),
    mov(2),
    mov(3),
    mov(4),
    ret(5),
  ]);
  assert.equal(cfg.nodes[0].succ.some((s) => s.to === 2 && s.kind === 'taken'), true, 'taken edge missing');
  assert.equal(cfg.nodes[1].succ.some((s) => s.to === -1 && s.outside), true, 'external edge missing');
  assert.equal(cfg.graph.immediatePostDominators[0], null,
    'B2 became a false immediate post-dominator of B0 although B0 can branch outside');
  assert.equal(cfg.graph.postDominators[0].has(2), false,
    'B2 post-dominates B0 although an authoritative path leaves the function');
});

test('#4229 unconditional external exit terminates the function', () => {
  const cfg = cfgOf([
    cond(0, 'cbz x0', BASE + 12n),
    jump(1, EXTERNAL),
    mov(2),
    ret(3),
  ]);
  assert.equal(cfg.nodes[1].isExit, true);
  assert.equal(cfg.graph.immediatePostDominators[0], null);
});

test('#4229 loop latch that can branch outside is not post-dominated by the local exit', () => {
  const cfg = cfgOf([
    cond(0, 'cbz x0', BASE + 12n),
    cond(1, 'cbz x1', EXTERNAL),
    jump(2, BASE),
    ret(3),
  ]);
  assert.ok(cfg.backEdges.some((e) => e.from === 2 && e.to === 0), 'loop back edge lost');
  assert.equal(cfg.graph.immediatePostDominators[0], null,
    'external loop exit was erased from the post-dominator model');
});

test('#4229 two local branches keep their join', () => {
  const cfg = cfgOf([
    cond(0, 'cbz x0', BASE + 8n),
    mov(1),
    mov(2),
    mov(3),
    mov(4),
    ret(5),
  ]);
  assert.equal(cfg.graph.immediatePostDominators[0], 2, 'legitimate merge post-dominator lost');
  assert.ok(cfg.shapes.some((s) => s.at === 0 && s.merge === 2), 'legitimate if merge lost');
});
