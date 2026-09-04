/**
 * #6313 回帰テスト。
 *
 * pipeline-core.js::reachingRegisterValue() が implicit RET の return-register
 * 値を same-block の definition しか見ず、predecessor block で確定した値を
 * entry argument へ fallback していた問題を固定する。
 *
 *   1. predecessor で x0 = 42 → dedicated return block の ret は 42 を返す
 *   2. entry argument x0 があっても古い argument へ fallback しない
 *   3. same-block definition は従来どおり RET 直前の最新値を選ぶ
 *   4. x86-64 rax / RISC-V a0 を synthetic IR で直接検証する
 *   5. bare RET の implicit lookup は x0 の最新確定値を使う
 *   6. divergent merge は branch-local write を無視して entry argument へ戻らない
 */
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { decompile } from '../js/decompile.js';
import { semanticAbiAdapter } from '../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../js/targets/abi/index.js';
import { reachingRegisterValueForTesting } from '../js/decompiler/pipeline-core.js';

const BASE = 0x100000000n;

function make(lines) {
  const raw = lines.map((text, row) => {
    const p = text.indexOf(' ');
    return { row, address: BASE + BigInt(row * 4), mn: p < 0 ? text : text.slice(0, p), ops: p < 0 ? '' : text.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(raw, { startRow: 0, endRow: raw.length - 1, rowOfAddress });
  return { model, rowOfAddress };
}

const armAdapter = semanticAbiAdapter(AAPCS64_ABI);

function run(lines, opts = {}) {
  const { model, rowOfAddress } = make(lines);
  const r = decompile(model, {
    addr: BASE, name: 'test', rowOfAddress, beginner: false,
    returnType: 'int64', decompilerTimeBudgetMs: 5000,
    ...opts,
  });
  return r;
}

function syntheticIr({ reg, values, blocks, entryArg = null }) {
  return {
    values,
    blocks: blocks.map((block) => ({ succ: block.succ || [], idom: block.idom ?? -1 })),
    idom: blocks.map((block) => block.idom ?? -1),
    dominators: blocks.map((block) => new Set(block.dominators || [])),
    args: new Map(entryArg ? [[reg, entryArg]] : []),
  };
}

function registerValue(id, reg, block, row, constant) {
  return { id, reg, const: BigInt(constant), def: { block, row }, clobbered: false };
}

/* ── 1+2. predecessor で x0 を上書きし dedicated return block へ ── */
{
  const r = run([
    'mov x0, #42',
    'b #0x100000008',
    'ret',
  ], { abiAdapter: armAdapter });
  assert.equal(r.semantic, true, r.warnings?.join('\n'));
  assert.match(r.pseudocode, /return\s+42/, r.pseudocode);
  assert.doesNotMatch(r.pseudocode, /return\s+a1\s*;/, r.pseudocode);
  console.log('  ok 1/2 predecessor definition wins over stale entry argument');
}

/* ── 3. same-block definition は従来どおり最新値 ───────────── */
{
  const r = run([
    'mov x0, #7',
    'mov x0, #42',
    'ret',
  ], { abiAdapter: armAdapter });
  assert.equal(r.semantic, true, r.warnings?.join('\n'));
  assert.match(r.pseudocode, /return\s+42/, r.pseudocode);

  // ir.values の列挙順に依存せず、row が最大の definition を選ぶことも直接固定する。
  const earlier = registerValue('early', 'rax', 0, 1, 7);
  const latest = registerValue('late', 'rax', 0, 9, 42);
  const ir = syntheticIr({
    reg: 'rax', values: [earlier, latest],
    blocks: [{ succ: [], idom: -1, dominators: [0] }],
  });
  assert.strictEqual(reachingRegisterValueForTesting(ir, { block: 0, row: 10 }, 'rax'), latest);
  console.log('  ok 3 same-block latest definition selected by row, not values order');
}

/* ── 4. architecture-neutral register names: rax / a0 ───────── */
{
  for (const reg of ['rax', 'a0']) {
    const value = registerValue(`${reg}-42`, reg, 0, 1, 42);
    const ir = syntheticIr({
      reg, values: [value],
      blocks: [
        { succ: [1], idom: -1, dominators: [0] },
        { succ: [], idom: 0, dominators: [0, 1] },
      ],
    });
    assert.strictEqual(reachingRegisterValueForTesting(ir, { block: 1, row: 10 }, reg), value,
      `${reg} predecessor definition must reach the dedicated return block`);
  }
  console.log('  ok 4 rax / a0 predecessor definitions are proven directly on synthetic IR');
}

/* ── 5. bare 'ret' の implicit lookup は x0 の最新確定値を使う ── */
{
  const r = run([
    'mov x0, #42',
    'mov x1, #99',
    'ret',
  ], { abiAdapter: armAdapter, returnType: 'int64' });
  assert.equal(r.semantic, true, r.warnings?.join('\n'));
  assert.match(r.pseudocode, /return\s+42/, r.pseudocode);
  console.log('  ok 5 bare ret uses latest x0 definition, unrelated x1 ignored');
}

/* ── 6. diamond merge: branch-local write invalidates stale entry fallback ── */
{
  const r = run([
    'cbz w1, #0x10000000c',
    'mov x0, #42',
    'b #0x100000010',
    'mov x0, #7',
    'ret',
  ], { abiAdapter: armAdapter, returnType: 'int64' });
  assert.equal(r.semantic, true, r.warnings?.join('\n'));
  const returnLine = (r.lines || []).find((l) => /return/.test(l.text || ''));
  assert.ok(returnLine, r.pseudocode);
  assert.ok(!/\breturn\s+(?:42|7)\s*;/.test(returnLine.text), returnLine.text);

  const entry = { id: 'entry-rax', kind: 'arg', reg: 'rax' };
  const branchWrite = registerValue('branch-rax', 'rax', 1, 2, 42);
  const ir = syntheticIr({
    reg: 'rax', values: [branchWrite], entryArg: entry,
    blocks: [
      { succ: [1, 2], idom: -1, dominators: [0] },
      { succ: [3], idom: 0, dominators: [0, 1] },
      { succ: [3], idom: 0, dominators: [0, 2] },
      { succ: [], idom: 0, dominators: [0, 3] },
    ],
  });
  assert.equal(reachingRegisterValueForTesting(ir, { block: 3, row: 10 }, 'rax'), null,
    'a branch-local write reaching the merge must invalidate the stale entry argument fallback');
  console.log('  ok 6 divergent merge stays unknown instead of silently falling back to entry argument');
}

console.log('issue-6313 CFG-aware implicit return lookup PASS');
