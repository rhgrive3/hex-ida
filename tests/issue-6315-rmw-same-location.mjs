/**
 * #6315 回帰テスト。
 *
 * semanticFacts() が STORE 右辺の形だけを見て readModifyWrite を付与していた
 * 問題を固定する。RMW の判定には「STORE 先と同一 canonical location の LOAD を
 * 右辺が読んでいる」ことの証明が必須で、証明が無ければ通常 STORE として
 * 説明されなければならない (fail-closed)。
 *
 *   1. dst = load(dst) + x        -> readModifyWrite: add
 *   2. dst = a + b                -> RMW metadata 無し
 *   3. dst = load(other) + x      -> RMW metadata 無し
 *   4. dst = max(load(dst) - x,0) -> readModifyWrite: clamp-zero-sub
 *   5. dst = max(a - x, 0)        -> clamp RMW metadata 無し
 *   6. dst = max(load(other)-x,0) -> clamp RMW metadata 無し
 *   7. summary の authority も compound assignment 判定と一致する
 */
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { decompile } from '../js/decompile.js';
import { semanticAbiAdapter } from '../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../js/targets/abi/index.js';

const BASE = 0x100000000n;
const testAbiAdapter = semanticAbiAdapter(AAPCS64_ABI);

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

const COMMON_OPTS = {
  abiAdapter: testAbiAdapter,
  addr: BASE, name: 'test', rowOfAddress: null, receiverType: 'Player', beginner: false,
  fieldFor: (_base, off) => off === 0x20n ? { name: 'hp', type: 'int32' }
    : off === 0x24n ? { name: 'mana', type: 'int32' } : null,
  decompilerTimeBudgetMs: 5000,
};

function run(lines) {
  const { model, rowOfAddress } = make(lines);
  const r = decompile(model, { ...COMMON_OPTS, rowOfAddress });
  assert.equal(r.semantic, true, r.warnings?.join('\n'));
  const store = r.semanticFacts?.stores?.find((s) => s.location?.key?.includes('hp') || /hp/.test(s.lhsText || '')) || r.semanticFacts?.stores?.[0] || null;
  assert.ok(store, 'semanticFacts.stores must contain the hp store');
  return { r, store };
}

/* ── 1. dst = load(dst) + x は RMW add ─────────────────────── */
{
  const { r, store } = run([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, w1',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  assert.equal(store.readModifyWrite?.kind, 'add', JSON.stringify(store.readModifyWrite));
  assert.ok(store.readModifyWrite?.operand, 'operand must be captured');
  assert.match(r.summary, /hpへ.*を加えて保存/, r.summary);
  console.log('  ok 1 dst = load(dst) + x keeps readModifyWrite:add');
}

/* ── 2. dst = a + b は RMW に昇格しない ────────────────────── */
{
  const { r, store } = run([
    'add w8, w1, w2',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  assert.equal(store.readModifyWrite ?? null, null, JSON.stringify(store.readModifyWrite));
  assert.doesNotMatch(r.summary, /を加えて保存/, r.summary);
  assert.match(r.summary, /hp/, r.summary);
  console.log('  ok 2 dst = a + b stays a plain store');
}

/* ── 3. dst = load(other) + x は RMW に昇格しない ──────────── */
{
  const { store } = run([
    'ldr w8, [x1, #0x24]',
    'add w8, w8, w2',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  assert.equal(store.readModifyWrite ?? null, null, JSON.stringify(store.readModifyWrite));
  console.log('  ok 3 dst = load(other) + x stays a plain store');
}

/* ── 4. dst = max(load(dst) - x, 0) は clamp-zero-sub ──────── */
{
  const { r, store } = run([
    'ldr w8, [x0, #0x20]',
    'sub w8, w8, w1',
    'cmp w8, #0',
    'csel w8, wzr, w8, lt',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  assert.equal(store.readModifyWrite?.kind, 'clamp-zero-sub', JSON.stringify(store.readModifyWrite));
  assert.match(r.summary, /0未満にならないよう制限/, r.summary);
  console.log('  ok 4 dst = max(load(dst) - x, 0) keeps clamp-zero-sub');
}

/* ── 5. dst = max(a - x, 0) は clamp RMW に昇格しない ──────── */
{
  const { store } = run([
    'sub w8, w1, w2',
    'cmp w8, #0',
    'csel w8, wzr, w8, lt',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  assert.equal(store.readModifyWrite ?? null, null, JSON.stringify(store.readModifyWrite));
  console.log('  ok 5 dst = max(a - x, 0) stays a plain store');
}

/* ── 6. dst = max(load(other) - x, 0) も昇格しない ─────────── */
{
  const { store } = run([
    'ldr w8, [x1, #0x24]',
    'sub w8, w8, w2',
    'cmp w8, #0',
    'csel w8, wzr, w8, lt',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  assert.equal(store.readModifyWrite ?? null, null, JSON.stringify(store.readModifyWrite));
  console.log('  ok 6 dst = max(load(other) - x, 0) stays a plain store');
}

/* ── 7. compound assignment 表示と summary の authority 一致 ── */
{
  const { r } = run([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, w1',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const compoundLine = r.lines.find((l) => /\+=/.test(l.text || ''));
  assert.ok(compoundLine, 'knownStatementForLine should render += when the same-location proof holds');
  assert.match(r.summary, /を加えて保存/, r.summary);
  const { r: r2, store: store2 } = run([
    'add w8, w1, w2',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const compoundLine2 = r2.lines.find((l) => /\+=/.test(l.text || ''));
  assert.equal(compoundLine2 ?? null, null, 'plain a + b must not render as +=');
  assert.doesNotMatch(r2.summary, /を加えて保存/, r2.summary);
  assert.equal(store2.readModifyWrite ?? null, null);
  console.log('  ok 7 summary authority matches compound-assignment rendering');
}

console.log('issue-6315 RMW same-location guard PASS');
