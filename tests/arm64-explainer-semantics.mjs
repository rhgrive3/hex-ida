/**
 * ARM64 行説明器のセマンティクス回帰テスト。
 *
 * ここが守る確定した欠陥を一覧にしています。どれも「表示が壊れている」ではなく
 * 「事実でないことを事実として見せる／本当にある参照を落とす」種類なので、
 * semantic correctness の回帰として恒久的に固定します。
 *
 *   #1288  アドレス 0 の分岐先・参照先が落ちる
 *   #1289  無関係な adrp + add から実在しない参照先を作る
 *   #1293  アドレスの前後関係だけでループと断定する
 *   #1294  ld2/3/4・st2/3/4 の転送量を常に 16 バイトと説明する
 *   #3597  Semantic Model のアドレス 0 分岐先が落ちる
 *   #3610  ordered narrow memory のアクセス幅をレジスタ幅で推定する
 *   #3612  SBFIZ/BFXIL を unsigned/逆方向 alias として説明する
 *   #3627  REV16/REV32 と UMULL が別のバイト範囲・符号であることを落とす
 *   #3620  条件付き比較/select の別演算 alias を同じ説明にする
 *   #3668  FP compare family を入力レジスタへの代入として説明する
 *   #3677  LDR literal の転送幅を destination 幅に関係なく固定する
 *   #3713  LDXRB/H・STXRB/H が exclusive monitor と narrow width を落とす
 *   #3740  LDAR/STLR family が acquire/release ordering を落とす
 *   #3775  LDXP/LDAXP/STXP/STLXP が pair operand と total width を落とす
 *   (new)  immShort / absHex / memExpr が import されておらず、
 *          メモリ系・即値系の説明が例外で空になる
 *
 * 最後の 1 件は `explain()` の catch が例外を握りつぶしていたため、
 * 「説明がまだ無い命令」と見分けが付きませんでした。そこで handler の失敗は
 * `out.handlerError` に残るようにし、このテストが機械的に検出します。
 */
import assert from 'node:assert/strict';
import { categoryOf, explain, referenceTarget, operandNotes } from '../js/arm64.js';
import { buildBasicBlocks, makeInstruction } from '../js/blocks-base.js';
import { lang, setLang } from '../js/i18n.js';

console.log('Testing ARM64 explainer semantics...');

/* ── #1288 アドレス 0 は「参照なし」ではない ───────────────── */

assert.equal(referenceTarget('b', '#0x0'), 0n, 'b to address 0 must keep its target');
assert.equal(referenceTarget('bl', '#0x0'), 0n, 'bl to address 0 must keep its target');
assert.equal(referenceTarget('b.eq', '#0x0'), 0n, 'conditional branch to 0 must keep its target');
assert.equal(referenceTarget('cbz', 'x0, #0x0'), 0n, 'cbz to address 0 must keep its target');
assert.equal(referenceTarget('tbz', 'x0, #3, #0x0'), 0n, 'tbz must report the branch target, not the bit index');
assert.equal(referenceTarget('tbnz', 'x0, #3, #0x0'), 0n, 'tbnz must report the branch target, not the bit index');
assert.equal(referenceTarget('adr', 'x0, #0x0'), 0n, 'adr of address 0 must keep its target');
assert.equal(referenceTarget('adrp', 'x0, #0x0'), 0n, 'adrp of page 0 must keep its target');
assert.equal(referenceTarget('ldr', 'x0, #0x0'), 0n, 'literal load from address 0 must keep its target');
// 通常の正のアドレスは今までどおり。
assert.equal(referenceTarget('b', '#0x1000'), 0x1000n);
assert.equal(referenceTarget('tbz', 'x0, #3, #0x1000'), 0x1000n);
assert.equal(referenceTarget('tbnz', 'x0, #3, #0x1000'), 0x1000n);
// 参照を持たない命令は今までどおり null。
assert.equal(referenceTarget('add', 'x0, x1, #4'), null);
assert.equal(referenceTarget('ret', ''), null);
console.log('  ok 1 address-zero targets survive (#1288)');

/* ── #3597 Semantic Model も address 0 を direct target として保持する ── */

const zeroTargets = [
  ['b', '#0x0', 'branchTarget'],
  ['b.eq', '#0x0', 'branchTarget'],
  ['cbz', 'x0, #0x0', 'branchTarget'],
  ['tbz', 'x0, #3, #0x0', 'branchTarget'],
  ['tbnz', 'x0, #3, #0x0', 'branchTarget'],
  ['adr', 'x0, #0x0', 'pcRelTarget'],
  ['adrp', 'x0, #0x0', 'pcRelTarget'],
  ['ldr', 'x0, #0x0', 'pcRelTarget'],
];
for (const [mn, ops, field] of zeroTargets) {
  const insn = makeInstruction({ row:0, address:0x1000n, mn, ops });
  assert.equal(insn[field], 0n, `${mn} must retain address-zero ${field}`);
}

const cfg = buildBasicBlocks([
  makeInstruction({ row:0, address:0x1000n, mn:'nop', ops:'' }),
  makeInstruction({ row:1, address:0x1004n, mn:'b', ops:'#0x0' }),
  makeInstruction({ row:2, address:0x1008n, mn:'ret', ops:'' }),
], { rowOfAddress: (address) => address === 0n ? 0 : null });
assert.ok(cfg.backEdges.some((edge) => edge.from === 1 && edge.to === 0),
  'a branch to address zero must remain a direct CFG edge');

// Truly negative target evidence remains unknown. In particular, TBZ/TBNZ
// must not mistake their preceding bit index for the rejected target.
for (const [mn, ops] of [
  ['b', '#-0x4'],
  ['tbz', 'x0, #3, #-0x4'],
  ['tbnz', 'x0, #3, #-0x4'],
]) {
  const insn = makeInstruction({ row:0, address:0x1000n, mn, ops });
  assert.equal(insn.branchTarget, null, `${mn} negative target must stay unknown`);
}

// A missing or malformed TBZ/TBNZ target must stay unknown instead of
// reinterpreting the bit index as a branch destination.
for (const mn of ['tbz', 'tbnz']) {
  const missing = makeInstruction({ row:0, address:0x1000n, mn, ops:'x0, #3' });
  assert.equal(missing.branchTarget, null, `${mn} missing target must stay unknown`);
  const malformed = makeInstruction({ row:0, address:0x1000n, mn, ops:'x0, #3, label' });
  assert.equal(malformed.branchTarget, null, `${mn} malformed target must stay unknown`);
}
console.log('  ok 1b blocks-base address-zero targets and CFG edges (#3597)');

/* ── #1289 adrp + add は本当に繋がっているときだけ ─────────── */

const pairCtx = { prev: { mn: 'adrp', ops: 'x8, #0x1000' } };
const paired = explain('add', 'x8, x8, #4', 0x1004, pairCtx);
assert.equal(paired.target, 0x1004n, 'the canonical adrp/add pair must still build its address');

const unrelated = explain('add', 'x9, x10, #4', 0x1004, pairCtx);
assert.equal(unrelated.target, null, 'an add that does not read the adrp destination must not invent a target');
assert.ok(
  !unrelated.detail.some((d) => /adrp/i.test(d)),
  'an unrelated add must not be explained as an adrp address pair',
);

// 別レジスタへ書き戻す形 (`adrp x8` → `add x0, x8, #imm`) も正しい組。
const movedDest = explain('add', 'x0, x8, #4', 0x1004, pairCtx);
assert.equal(movedDest.target, 0x1004n, 'adrp xN; add xD, xN, #imm is still a valid pair');

// 幅が違えば別レジスタ。w8 は x8 の下半分で、アドレス組み立てではない。
const wrongWidth = explain('add', 'w8, w8, #4', 0x1004, pairCtx);
assert.equal(wrongWidth.target, null, 'a 32-bit add is not an address-building pair');
console.log('  ok 2 adrp+add pairs require a real register link (#1289)');

/* ── #1293 アドレス順はループの証拠にならない ──────────────── */

for (const [mn, ops] of [['b', '#0x100'], ['b.eq', '#0x100'], ['cbz', 'x0, #0x100'], ['cbnz', 'x0, #0x100']]) {
  const backward = explain(mn, ops, 0x200, {});
  assert.ok(
    !backward.terms.includes('loop'),
    `${mn} must not claim a loop from address order alone (#1293)`,
  );
  // 断定形だけを禁止する。「ループのこともある」という留保付きの説明は事実。
  assert.ok(
    !backward.detail.some((d) => /ループの(終わり|底)(?:です|でしょう)|bottom of a loop\.|so this is a loop/.test(d)),
    `${mn} must not assert loop structure without CFG evidence (#1293)`,
  );
  // 向きそのものは事実なので、述べてよい。
  assert.equal(backward.target, 0x100n, `${mn} must still report its target`);
}
console.log('  ok 3 backward branches are described, not declared loops (#1293)');

/* ── #1294 LDn/STn の転送量はレジスタリストから決まる ───────── */

const VECTOR_CASES = [
  { mn: 'ld1', ops: '{v0.16b}, [x0]', bytes: 16, count: 1 },
  { mn: 'ld1', ops: '{v0.8b}, [x0]', bytes: 8, count: 1 },
  { mn: 'ld2', ops: '{v0.8h, v1.8h}, [x0]', bytes: 32, count: 2 },
  { mn: 'ld3', ops: '{v0.4s, v1.4s, v2.4s}, [x0]', bytes: 48, count: 3 },
  { mn: 'ld4', ops: '{v0.16b, v1.16b, v2.16b, v3.16b}, [x0]', bytes: 64, count: 4 },
  { mn: 'st1', ops: '{v0.16b}, [x0]', bytes: 16, count: 1 },
  { mn: 'st2', ops: '{v0.2d, v1.2d}, [x0]', bytes: 32, count: 2 },
  { mn: 'st4', ops: '{v0.16b, v1.16b, v2.16b, v3.16b}, [x0]', bytes: 64, count: 4 },
];

for (const c of VECTOR_CASES) {
  const e = explain(c.mn, c.ops, 0x1000, {});
  assert.equal(e.handlerError, undefined, `${c.mn} handler must not throw`);
  assert.ok(e.summary.includes(String(c.bytes)), `${c.mn} ${c.ops} must state ${c.bytes} bytes, got: ${e.summary}`);
  if (c.count > 1) {
    assert.ok(
      !/合計 16 バイト|^Load 16 bytes|^Store 16 bytes/.test(e.summary),
      `${c.mn} must not collapse a multi-structure transfer to 16 bytes (#1294)`,
    );
  }
}
console.log('  ok 4 LDn/STn report the real transfer size (#1294)');

/* ── #3610 ordered narrow memory accesses use their architectural width ── */

for (const [mn, bytes] of [['ldarb', 1], ['ldarh', 2], ['stlrb', 1], ['stlrh', 2]]) {
  const insn = makeInstruction({ row:0, address:0x1000n, mn, ops:'w0, [x1]' });
  assert.equal(insn.memory?.size, bytes, `${mn} must report ${bytes}-byte memory access`);
}

// The non-narrow ordered forms still use the destination/source register
// width, as do the ordinary byte/halfword forms.
for (const [mn, reg, bytes] of [
  ['ldar', 'w0', 4], ['ldar', 'x0', 8], ['stlr', 'w0', 4], ['stlr', 'x0', 8],
  ['ldrb', 'w0', 1], ['ldrh', 'w0', 2],
]) {
  const insn = makeInstruction({ row:0, address:0x1000n, mn, ops:`${reg}, [x1]` });
  assert.equal(insn.memory?.size, bytes, `${mn} ${reg} must report ${bytes}-byte access`);
}
console.log('  ok 4b ordered narrow memory widths remain architectural (#3610)');

/* ── #3713/#3740 ordered and exclusive narrow families keep their semantics ── */

const exclusiveOrderingLang = lang();
try {
  setLang('en');

  const EXCLUSIVE_LOADS = [
    ['ldxrb', 'w0, [x1]', 1, false],
    ['ldxrh', 'w0, [x1]', 2, false],
    ['ldaxrb', 'w0, [x1]', 1, true],
    ['ldaxrh', 'w0, [x1]', 2, true],
  ];
  for (const [mn, ops, bytes, acquire] of EXCLUSIVE_LOADS) {
    const result = explain(mn, ops, 0x1000n, {});
    const rendered = [result.title, result.summary, result.pseudo, ...result.detail].join(' ');
    assert.equal(result.handlerError, undefined, `${mn} handler must not throw (#3713)`);
    assert.equal(categoryOf(mn), 'load', `${mn} must retain the load category (#3713)`);
    assert.match(result.pseudo, new RegExp(`uint${bytes * 8}`), `${mn} must keep its ${bytes}-byte source width (#3713)`);
    assert.match(result.pseudo, /zero_extend/, `${mn} must zero-extend its narrow load (#3713)`);
    assert.match(rendered, /exclusive monitor|watching/i, `${mn} must explain the exclusive monitor (#3713)`);
    if (acquire) assert.match(rendered, /acquire/i, `${mn} must explain acquire ordering (#3713 #3740)`);
  }

  const EXCLUSIVE_STORES = [
    ['stxrb', 'w0, w2, [x1]', 1, false],
    ['stxrh', 'w0, w2, [x1]', 2, false],
    ['stlxrb', 'w0, w2, [x1]', 1, true],
    ['stlxrh', 'w0, w2, [x1]', 2, true],
  ];
  for (const [mn, ops, bytes, release] of EXCLUSIVE_STORES) {
    const result = explain(mn, ops, 0x1000n, {});
    const rendered = [result.title, result.summary, result.pseudo, ...result.detail].join(' ');
    assert.equal(result.handlerError, undefined, `${mn} handler must not throw (#3713)`);
    assert.equal(categoryOf(mn), 'store', `${mn} must retain the store category (#3713)`);
    assert.equal(result.pseudo, `w0 = try_store(x1, w2, uint${bytes * 8})`,
      `${mn} must use w2 as data and w0 as the status destination (#3713)`);
    assert.match(rendered, new RegExp(`${bytes} byte`), `${mn} must state its ${bytes}-byte conditional store (#3713)`);
    assert.match(rendered, /w2/, `${mn} must identify the data operand (#3713)`);
    assert.match(rendered, /w0.*0 on success.*1 on failure/i, `${mn} must explain the status result (#3713)`);
    if (release) assert.match(rendered, /release/i, `${mn} must explain release ordering (#3713 #3740)`);
  }

  // The original word/doubleword exclusive forms retain their established
  // monitor, status, and operand ordering contracts.
  assert.equal(explain('ldxr', 'x0, [x1]').pseudo, 'x0 = *(x1) /* start exclusive monitor */');
  assert.equal(explain('ldxrb', 'w0, [x1]').pseudo, 'w0 = zero_extend(*(uint8*)(x1)) /* start exclusive monitor */');
  setLang('ja');
  assert.equal(explain('ldxr', 'x0, [x1]').pseudo, 'x0 = *(x1) /* 監視開始 */');
  assert.equal(explain('ldxrb', 'w0, [x1]').pseudo, 'w0 = zero_extend(*(uint8*)(x1)) /* 監視開始 */');
  setLang('en');
  assert.equal(explain('stxr', 'w0, x2, [x1]').pseudo, 'w0 = try_store(x1, x2)');
  assert.match([explain('ldaxr', 'x0, [x1]').summary, ...explain('ldaxr', 'x0, [x1]').detail].join(' '), /acquire/i);
  assert.match([explain('stlxr', 'w0, x2, [x1]').summary, ...explain('stlxr', 'w0, x2, [x1]').detail].join(' '), /release/i);

  const ORDERED_LOADS = [
    ['ldar', 'w0, [x1]', 4], ['ldar', 'x0, [x1]', 8],
    ['ldarb', 'w0, [x1]', 1], ['ldarh', 'w0, [x1]', 2],
  ];
  for (const [mn, ops, bytes] of ORDERED_LOADS) {
    const result = explain(mn, ops, 0x1000n, {});
    const plain = explain('ldr', ops, 0x1000n, {});
    assert.equal(result.handlerError, undefined, `${mn} handler must not throw (#3740)`);
    assert.equal(categoryOf(mn), 'load', `${mn} must retain the load category (#3740)`);
    assert.match(result.pseudo, new RegExp(`uint${bytes * 8}`), `${mn} must preserve ${bytes}-byte width (#3740)`);
    assert.match(result.summary, /acquire/i, `${mn} must identify acquire ordering (#3740)`);
    assert.notEqual(result.summary, plain.summary, `${mn} must remain distinct from LDR (#3740)`);
  }

  const ORDERED_STORES = [
    ['stlr', 'w0, [x1]', 4], ['stlr', 'x0, [x1]', 8],
    ['stlrb', 'w0, [x1]', 1], ['stlrh', 'w0, [x1]', 2],
  ];
  for (const [mn, ops, bytes] of ORDERED_STORES) {
    const result = explain(mn, ops, 0x1000n, {});
    const plain = explain('str', ops, 0x1000n, {});
    assert.equal(result.handlerError, undefined, `${mn} handler must not throw (#3740)`);
    assert.equal(categoryOf(mn), 'store', `${mn} must retain the store category (#3740)`);
    assert.match(result.pseudo, new RegExp(`uint${bytes * 8}`), `${mn} must preserve ${bytes}-byte width (#3740)`);
    assert.match(result.summary, /release/i, `${mn} must identify release ordering (#3740)`);
    assert.notEqual(result.summary, plain.summary, `${mn} must remain distinct from STR (#3740)`);
  }
} finally {
  setLang(exclusiveOrderingLang);
}
console.log('  ok 4c ordered/exclusive narrow families retain width, monitor, status, and ordering (#3713 #3740)');

/* ── #3775 pair-exclusive families preserve both registers and total width ── */

try {
  setLang('en');
  const PAIR_LOADS = [
    ['ldxp', 'x0, x1, [x2]', 'x0', 'x1', 'uint64', 16, false],
    ['ldxp', 'w0, w1, [x2]', 'w0', 'w1', 'uint32', 8, false],
    ['ldaxp', 'x0, x1, [x2]', 'x0', 'x1', 'uint64', 16, true],
    ['ldaxp', 'w0, w1, [x2]', 'w0', 'w1', 'uint32', 8, true],
  ];
  for (const [mn, ops, first, second, type, bytes, acquire] of PAIR_LOADS) {
    const result = explain(mn, ops, 0x1000n, {});
    const rendered = [result.title, result.summary, result.pseudo, ...result.detail].join(' ');
    assert.equal(result.handlerError, undefined, `${mn} handler must not throw (#3775)`);
    assert.equal(categoryOf(mn), 'load', `${mn} must retain the load category (#3775)`);
    assert.match(result.pseudo, new RegExp(`${first}, ${second} = load_pair_exclusive\\(x2, ${type}, ${bytes} bytes\\)`),
      `${mn} must expose both pair destinations and its total width (#3775)`);
    assert.match(rendered, new RegExp(`${bytes} bytes`), `${mn} must state the pair total width (#3775)`);
    const elementBits = type === 'uint32' ? 32 : 64;
    assert.match(rendered, new RegExp(`two ${elementBits}-bit elements`),
      `${mn} must distinguish W-pair and X-pair element widths (#3775)`);
    if (type === 'uint32') {
      assert.match(rendered, /A W pair is single-copy atomic at 64-bit doubleword granularity\./,
        `${mn} must state the W-pair 64-bit single-copy guarantee (#3775)`);
      assert.doesNotMatch(rendered, /whole 128-bit atomicity is not guaranteed/i,
        `${mn} must not apply the X-pair 128-bit limitation to a W pair (#3775)`);
    } else {
      assert.match(rendered, /Each 64-bit element of an X pair is single-copy atomic at doubleword granularity; whole 128-bit atomicity is not guaranteed by this load\./,
        `${mn} must scope X-pair atomicity to each element (#3775)`);
    }
    assert.match(rendered, /exclusive monitor|watching/i, `${mn} must explain the exclusive monitor (#3775)`);
    assert.match(rendered, new RegExp(`${first}.*${second}`), `${mn} must identify both destinations (#3775)`);
    assert.ok(result.terms.includes('atomic') && result.terms.includes('memory'), `${mn} must retain atomic memory terms (#3775)`);
    if (acquire) assert.match(rendered, /acquire/i, `${mn} must explain acquire ordering (#3775)`);
  }

  assert.match(explain('ldxp', 'x0, x1, [x2]', 0x1000n, {}).pseudo,
    /\/\* start exclusive monitor \*\//,
    'English pair-load pseudo comments must be localized through J (#3775)');
  setLang('ja');
  assert.match(explain('ldxp', 'w0, w1, [x2]', 0x1000n, {}).pseudo,
    /\/\* 監視開始 \*\//,
    'Japanese pair-load pseudo comments must remain localized through J (#3775)');
  setLang('en');

  const PAIR_STORES = [
    ['stxp', 'w0, x1, x2, [x3]', 'w0', 'x1', 'x2', 'uint64', 16, false],
    ['stxp', 'w0, w1, w2, [x3]', 'w0', 'w1', 'w2', 'uint32', 8, false],
    ['stlxp', 'w0, x1, x2, [x3]', 'w0', 'x1', 'x2', 'uint64', 16, true],
    ['stlxp', 'w0, w1, w2, [x3]', 'w0', 'w1', 'w2', 'uint32', 8, true],
  ];
  for (const [mn, ops, status, first, second, type, bytes, release] of PAIR_STORES) {
    const result = explain(mn, ops, 0x1000n, {});
    const rendered = [result.title, result.summary, result.pseudo, ...result.detail].join(' ');
    assert.equal(result.handlerError, undefined, `${mn} handler must not throw (#3775)`);
    assert.equal(categoryOf(mn), 'store', `${mn} must retain the store category (#3775)`);
    assert.equal(result.pseudo, `${status} = try_store_pair(x3, ${first}, ${second}, ${type}, ${bytes} bytes)`,
      `${mn} must distinguish status from both pair data operands (#3775)`);
    assert.match(rendered, new RegExp(`${bytes} bytes`), `${mn} must state the pair total width (#3775)`);
    assert.match(rendered, new RegExp(`${first}.*${second}`), `${mn} must identify both data operands (#3775)`);
    assert.match(rendered, new RegExp(`${status}.*0 on success.*1 on failure`, 'i'),
      `${mn} must explain the status result (#3775)`);
    assert.match(rendered, /exclusive monitor|matching exclusive monitor/i, `${mn} must explain conditional exclusivity (#3775)`);
    assert.ok(result.terms.includes('atomic') && result.terms.includes('memory'), `${mn} must retain atomic memory terms (#3775)`);
    if (release) assert.match(rendered, /release/i, `${mn} must explain release ordering (#3775)`);
  }
} finally {
  setLang(exclusiveOrderingLang);
}
console.log('  ok 4d pair-exclusive families retain destinations, status, width, and ordering (#3775)');

/* ── #3620 conditional compare/select aliases keep their own semantics ── */

const conditionalLang = lang();
try {
  setLang('en');
  const CONDITIONAL_CASES = [
    ['ccmp', 'w0, w1, #0, eq', 'if (eq) flags = w0 − w1 else flags = 0', /subtract|compare again/i],
    ['ccmp', 'x0, x1, #0, ne', 'if (ne) flags = x0 − x1 else flags = 0', /subtract|compare again/i],
    ['ccmn', 'x0, x1, #0, ne', 'if (ne) flags = x0 + x1 else flags = 0', /add.*flags|negative/i],
    ['ccmn', 'w0, w1, #0, eq', 'if (eq) flags = w0 + w1 else flags = 0', /add.*flags|negative/i],
    ['csinc', 'w0, w1, w2, eq', 'w0 = eq ? w1 : w2 + 1', /adding one/i],
    ['csinc', 'x0, x1, x2, ne', 'x0 = ne ? x1 : x2 + 1', /adding one/i],
    ['csinv', 'x0, x1, x2, eq', 'x0 = eq ? x1 : ~x2', /bitwise inverse|invert/i],
    ['csinv', 'w0, w1, w2, ne', 'w0 = ne ? w1 : ~w2', /bitwise inverse|invert/i],
    ['csneg', 'w0, w1, w2, ne', 'w0 = ne ? w1 : -w2', /negat|negative/i],
    ['csneg', 'x0, x1, x2, eq', 'x0 = eq ? x1 : -x2', /negat|negative/i],
    ['cinc', 'x0, x1, eq', 'x0 = eq ? x1 + 1 : x1', /add one/i],
    ['cinc', 'w0, w1, ne', 'w0 = ne ? w1 + 1 : w1', /add one/i],
    ['cinv', 'w0, w1, ne', 'w0 = ne ? ~w1 : w1', /bitwise inverse|invert/i],
    ['cinv', 'x0, x1, eq', 'x0 = eq ? ~x1 : x1', /bitwise inverse|invert/i],
    ['cneg', 'x0, x1, eq', 'x0 = eq ? -x1 : x1', /negat|negative/i],
    ['cneg', 'w0, w1, ne', 'w0 = ne ? -w1 : w1', /negat|negative/i],
  ];

  for (const [mn, ops, pseudo, summary] of CONDITIONAL_CASES) {
    const e = explain(mn, ops, 0x1000n, {});
    assert.equal(e.handlerError, undefined, `${mn} ${ops} handler must not throw (#3620)`);
    assert.equal(e.pseudo, pseudo, `${mn} ${ops} must preserve both condition paths (#3620)`);
    assert.match(e.summary, summary, `${mn} ${ops} summary must describe its operation (#3620)`);
  }
} finally {
  setLang(conditionalLang);
}
console.log('  ok 4c conditional compare/select aliases retain W/X and true/false-path semantics (#3620)');

/* ── #3677 literal LDR uses the destination transfer width ─────────────── */

for (const [reg, type] of [
  ['w0', 'uint32'], ['x0', 'uint64'], ['s0', 'uint32'], ['d0', 'uint64'], ['q0', 'uint128'],
]) {
  const e = explain('ldr', `${reg}, #0x1000`, 0x2000n, {});
  assert.equal(e.handlerError, undefined, `ldr ${reg} literal handler must not throw (#3677)`);
  assert.equal(e.pseudo, `${reg} = *(${type}*)0x1000`,
    `ldr ${reg} literal must describe its ${type} transfer width (#3677)`);
}

// The ordinary base-plus-displacement path remains delegated to loadStore.
const offsetLoad = explain('ldr', 'w0, [x1, #4]', 0x2000n, {});
assert.equal(offsetLoad.pseudo, 'w0 = *(uint32*)(x1 + 4)',
  'non-literal ldr must retain its existing addressing path (#3677)');
console.log('  ok 4d LDR literal explanations retain W/X/S/D/Q transfer widths (#3677)');

/* ── handler が例外で落ちていないこと ───────────────────────── */

const CORPUS = [
  ['ldr', 'x0, [x1, #0x10]'], ['ldr', 'x0, [x1, x2, lsl #3]'], ['ldr', 'x0, #0x2000'],
  ['ldrb', 'w0, [x1]'], ['ldrsw', 'x0, [x1, #4]'], ['ldur', 'x0, [x1, #-8]'],
  ['str', 'w2, [x1, x3, lsl #2]'], ['strb', 'w0, [x1], #1'], ['stur', 'x0, [x29, #-16]'],
  ['ldp', 'x0, x1, [sp, #0x10]'], ['stp', 'x29, x30, [sp, #-16]!'], ['prfm', 'pldl1keep, [x0]'],
  ['ld1', '{v0.16b}, [x0]'], ['ld4', '{v0.16b, v1.16b, v2.16b, v3.16b}, [x0]'],
  ['st1', '{v0.16b}, [x0]'], ['st4', '{v0.16b, v1.16b, v2.16b, v3.16b}, [x0]'],
  ['ldxr', 'x0, [x1]'], ['stxr', 'w0, x1, [x2]'],
  ['movk', 'x0, #0x1234, lsl #16'], ['movz', 'x0, #0x1234'], ['movn', 'x0, #0'],
  ['ubfx', 'x0, x1, #4, #8'], ['sbfx', 'x0, x1, #4, #8'], ['bfi', 'x0, x1, #4, #8'],
  ['bfxil', 'x0, x1, #4, #8'], ['extr', 'x0, x1, x2, #8'], ['ccmp', 'x0, x1, #0, eq'],
  ['movi', 'v0.16b, #0'], ['add', 'x0, x1, #4'], ['add', 'x0, x1, x2, lsl #3'],
  ['sub', 'sp, sp, #0x20'], ['adrp', 'x8, #0x1000'], ['adr', 'x0, #0x100'],
  ['b', '#0x100'], ['b.eq', '#0x100'], ['cbz', 'x0, #0x100'], ['tbz', 'x0, #3, #0x100'],
  ['bl', '#0x2000'], ['blr', 'x8'], ['ret', ''], ['svc', '#0'], ['brk', '#1'],
  ['dmb', 'ish'], ['mov', 'x0, x1'], ['cmp', 'x0, #0'], ['csel', 'x0, x1, x2, eq'],
];

for (const [mn, ops] of CORPUS) {
  const e = explain(mn, ops, 0x1000, {});
  assert.equal(e.handlerError, undefined, `explain(${mn} ${ops}) threw: ${e.handlerError}`);
  assert.ok(e.summary, `explain(${mn} ${ops}) produced no summary`);
  assert.ok(e.pseudo, `explain(${mn} ${ops}) produced no pseudocode`);
}
console.log(`  ok 5 no handler throws across ${CORPUS.length} instruction forms`);

// operandNotes も同じヘルパーを使う。
const notes = operandNotes('ldr', 'x0, [x1, #-0x10]');
assert.ok(notes.length >= 2, 'operandNotes must describe every operand');
assert.ok(notes.some((n) => n.kind === 'mem' && n.text), 'the memory operand must carry a description');

const immNotes = operandNotes('add', 'x0, x1, #0x20');
const imm = immNotes.find((n) => n.kind === 'imm');
assert.ok(imm && /0x20/i.test(imm.text), 'an immediate note must include its hex form');
console.log('  ok 6 operand notes render immediates and memory operands');

/* ── #6271 pair register identity is GP-class-sensitive ───────────────── */

const canonicalPairPush = explain('stp', 'x29, x30, [sp, #-16]!');
assert.ok(canonicalPairPush.terms.includes('prologue'), 'x29/x30 stack save must remain a prologue');

const canonicalPairPop = explain('ldp', 'x29, x30, [sp], #16');
assert.ok(canonicalPairPop.terms.includes('epilogue'), 'x29/x30 stack restore must remain an epilogue');

for (const [mn, ops] of [
  ['stp', 'q29, q30, [sp, #-32]!'],
  ['ldp', 'q29, q30, [sp], #32'],
  ['stp', 'd29, d30, [sp, #-16]!'],
]) {
  const result = explain(mn, ops);
  assert.ok(!result.terms.includes('prologue'), `${mn} ${ops} must not impersonate x29/x30 prologue`);
  assert.ok(!result.terms.includes('epilogue'), `${mn} ${ops} must not impersonate x29/x30 epilogue`);
}

const vectorSavedPair = explain('stp', 'q19, q20, [sp, #-32]!');
assert.ok(!vectorSavedPair.terms.includes('calleesaved'), 'SIMD q19/q20 must not inherit GP callee-saved explanation');
const gpSavedPair = explain('stp', 'x19, x20, [sp, #-16]!');
assert.ok(gpSavedPair.terms.includes('calleesaved'), 'GP x19/x20 must retain callee-saved explanation');
console.log('  ok 7 pair register identity is class-sensitive (#6271)');

/* ── #3612 SBFIZ/BFXIL は似た形でも別の bitfield semantics ───── */

const sbfizX = explain('sbfiz', 'x0, x1, #8, #8');
const ubfizX = explain('ubfiz', 'x0, x1, #8, #8');
assert.equal(sbfizX.handlerError, undefined, 'SBFIZ X handler must not throw');
assert.equal(ubfizX.handlerError, undefined, 'UBFIZ X handler must not throw');
assert.notEqual(sbfizX.pseudo, ubfizX.pseudo, 'SBFIZ must not reuse UBFIZ presentation');
assert.match(sbfizX.pseudo, /sign_extend\(x1\[0\.\.7\], 64\)/, 'SBFIZ must expose signed low-field extension');
assert.match(sbfizX.pseudo, /<< 8$/, 'SBFIZ must place the signed field at its destination lsb');
assert.match(sbfizX.summary + ' ' + sbfizX.detail.join(' '), /符号|sign/i, 'SBFIZ explanation must mention sign extension');
assert.match(ubfizX.pseudo, /x1 & mask\) << 8/, 'UBFIZ zero-fill explanation must remain unchanged');

const bfxilX = explain('bfxil', 'x0, x1, #8, #8');
const bfiX = explain('bfi', 'x0, x1, #8, #8');
assert.equal(bfxilX.handlerError, undefined, 'BFXIL X handler must not throw');
assert.equal(bfiX.handlerError, undefined, 'BFI X handler must not throw');
assert.notEqual(bfxilX.pseudo, bfiX.pseudo, 'BFXIL must not reuse BFI presentation');
assert.equal(bfxilX.pseudo, 'x0[0..7] = x1[8..15]', 'BFXIL must map source bits 8..15 to destination bits 0..7');
assert.match(bfxilX.summary, /上のビットはそのまま|higher destination bits stay unchanged/i, 'BFXIL must preserve higher destination bits');
assert.ok(bfiX.pseudo.includes('x0[8…]'), 'BFI must retain its destination insertion position');

const sbfizW = explain('sbfiz', 'w0, w1, #24, #8');
const bfxilW = explain('bfxil', 'w0, w1, #24, #8');
assert.match(sbfizW.pseudo, /sign_extend\(w1\[0\.\.7\], 32\) << 24/, 'SBFIZ W boundary must use 32-bit signed extension');
assert.equal(bfxilW.pseudo, 'w0[0..7] = w1[24..31]', 'BFXIL W boundary must retain source/destination direction');

const sbfizXBoundary = explain('sbfiz', 'x0, x1, #56, #8');
const bfxilXBoundary = explain('bfxil', 'x0, x1, #56, #8');
assert.match(sbfizXBoundary.pseudo, /sign_extend\(x1\[0\.\.7\], 64\) << 56/, 'SBFIZ X boundary must retain 64-bit width');
assert.equal(bfxilXBoundary.pseudo, 'x0[0..7] = x1[56..63]', 'BFXIL X boundary must retain source/destination direction');
console.log('  ok 8 SBFIZ/BFXIL aliases preserve signedness and bit direction (#3612)');


/* ── #3627 width and signedness semantics must not collapse into aliases ─── */

// A64 REV reverses the complete register, while REV16 and REV32 reverse bytes
// inside each 16-bit halfword or 32-bit word.  For the ordinary X-register
// example x1 = 0x1122334455667788, these are respectively
// 0x8877665544332211, 0x2211443366558877, and 0x4433221188776655.
const reverseX = [
  ['rev', 'byteswap'],
  ['rev16', 'byteswap16'],
  ['rev32', 'byteswap32'],
];
for (const [mn, operation] of reverseX) {
  const result = explain(mn, 'x0, x1');
  assert.equal(result.handlerError, undefined, `${mn} handler must not throw (#3627)`);
  assert.equal(result.pseudo, `x0 = ${operation}(x1)`, `${mn} must describe its byte scope (#3627)`);
  assert.ok(result.terms.includes('endian'), `${mn} must retain the endian term (#3627)`);
}
assert.notEqual(explain('rev16', 'x0, x1').pseudo, explain('rev32', 'x0, x1').pseudo);
for (const [mn, widths] of [['rev16', ['w', 'x']], ['rev32', ['x']]]) {
  for (const width of widths) {
    const result = explain(mn, `${width}0, ${width}1`);
    assert.equal(result.handlerError, undefined, `${mn} ${width}-form must remain valid (#3627)`);
    assert.equal(result.pseudo, `${width}0 = byteswap${mn.slice(3)}(${width}1)`);
  }
}

const smull = explain('smull', 'x0, w1, w2');
const umull = explain('umull', 'x0, w1, w2');
// With w1 = 0xffffffff and w2 = 2, UMULL produces 0x00000001fffffffe;
// SMULL interprets w1 as -1 and produces 0xfffffffffffffffe.
assert.equal(smull.handlerError, undefined, 'SMULL handler must not throw (#3627)');
assert.equal(umull.handlerError, undefined, 'UMULL handler must not throw (#3627)');
assert.equal(smull.pseudo, 'x0 = (signed)w1 × (signed)w2', 'SMULL must preserve signed operands (#3627)');
assert.equal(umull.pseudo, 'x0 = (unsigned)w1 × (unsigned)w2', 'UMULL must zero-extend operands (#3627)');
assert.notEqual(smull.pseudo, umull.pseudo, 'SMULL and UMULL must not share a signedness-blind explanation (#3627)');
assert.match(smull.summary, /符号付き|Sign-extend/i, 'SMULL summary must state signed widening (#3627)');
assert.match(umull.summary, /符号なし|Zero-extend/i, 'UMULL summary must state unsigned widening (#3627)');
console.log('  ok 8 REV16/REV32 scope and SMULL/UMULL signedness stay distinct (#3627)');

/* SIMD encodings must not inherit scalar explanations (#3627) */
const smullVector = explain('smull', 'v0.4s, v1.4h, v2.4h');
const umullVector = explain('umull', 'v0.4s, v1.4h, v2.4h');
assert.equal(smullVector.handlerError, undefined, 'SIMD SMULL handler must not throw (#3627)');
assert.equal(umullVector.handlerError, undefined, 'SIMD UMULL handler must not throw (#3627)');
assert.equal(smullVector.pseudo, 'v0.4s = signed_lane_widen_mul(v1.4h, v2.4h)');
assert.equal(umullVector.pseudo, 'v0.4s = unsigned_lane_widen_mul(v1.4h, v2.4h)');
assert.ok(smullVector.terms.includes('simd'));
assert.ok(umullVector.terms.includes('simd'));
assert.match(smullVector.summary, /レーン|lane/i);
assert.match(umullVector.summary, /レーン|lane/i);

const rev16Vector = explain('rev16', 'v0.8h, v1.8h');
const rev32Vector = explain('rev32', 'v0.4s, v1.4s');
assert.equal(rev16Vector.handlerError, undefined, 'SIMD REV16 handler must not throw (#3627)');
assert.equal(rev32Vector.handlerError, undefined, 'SIMD REV32 handler must not throw (#3627)');
assert.equal(rev16Vector.pseudo, 'v0.8h = vector_byteswap16(v1.8h)');
assert.equal(rev32Vector.pseudo, 'v0.4s = vector_byteswap32(v1.4s)');
assert.ok(rev16Vector.terms.includes('simd'));
assert.ok(rev32Vector.terms.includes('simd'));
assert.match(rev16Vector.summary, /レーン|lane/i);
assert.match(rev32Vector.summary, /レーン|lane/i);
console.log('  ok 9 SIMD encodings retain lane-specific semantics (#3627)');

/* ── #3653 UDIV keeps unsigned wording in every display language ──────── */

const previousLang = lang();
const highBitDividend = 0xffffffffn;
const divisor = 2n;
try {
  // This concrete 32-bit fixture is the semantic distinction that the
  // presentation must not reverse: 0xffffffff is 2147483647 unsigned, but
  // -1 divided by 2 truncates to 0 under signed ARM64 division.
  assert.equal(highBitDividend / divisor, 2147483647n, 'the high-bit fixture must be unsigned 32-bit division');
  assert.equal(-1n / divisor, 0n, 'the high-bit fixture must distinguish signed division');

  setLang('en');
  const unsignedEnglish = explain('udiv', 'w0, w1, w2', 0n, {});
  const signedEnglish = explain('sdiv', 'w0, w1, w2', 0n, {});
  assert.equal(unsignedEnglish.title, 'Unsigned divide');
  assert.equal(unsignedEnglish.summary, 'Divide w1 by w2 (truncating), unsigned.');
  assert.doesNotMatch(unsignedEnglish.summary, /\bsigned\b/i, 'English UDIV must not retain SDIV wording (#3653)');
  assert.match(signedEnglish.summary, /\bsigned\b/i, 'English SDIV must retain signed wording (#3653)');

  setLang('ja');
  const unsignedJapanese = explain('udiv', 'w0, w1, w2', 0n, {});
  const signedJapanese = explain('sdiv', 'w0, w1, w2', 0n, {});
  assert.equal(unsignedJapanese.title, '割り算（符号なし）');
  assert.match(unsignedJapanese.summary, /マイナスは扱いません/);
  assert.match(signedJapanese.summary, /マイナスも扱えます/);
} finally {
  setLang(previousLang);
}
console.log('  ok 10 UDIV/SDIV presentation signedness stays distinct (#3653)');

/* ── #3750 UDF is not a debugger breakpoint alias for BRK ────────────── */

const trapLang = lang();
try {
  setLang('en');
  const brkEnglish = explain('brk', '#0', 0n, {});
  const udfEnglish = explain('udf', '#0', 0n, {});
  assert.equal(brkEnglish.title, 'Breakpoint / trap', 'BRK keeps its debugger-facing title (#3750)');
  assert.match(brkEnglish.summary, /debuggers?/i, 'BRK keeps its debugger explanation (#3750)');
  assert.match(brkEnglish.detail.join(' '), /Swift traps/i, 'BRK keeps its trap detail (#3750)');
  assert.equal(udfEnglish.title, 'Permanently undefined instruction');
  assert.equal(udfEnglish.pseudo, 'undefined_instruction_exception()');
  assert.match(udfEnglish.summary, /permanently undefined/i);
  assert.match(udfEnglish.summary, /Undefined Instruction exception/i);
  assert.match(udfEnglish.detail.join(' '), /#imm16.*operation selector/i);
  assert.doesNotMatch(
    [udfEnglish.title, udfEnglish.summary, ...udfEnglish.detail].join(' '),
    /(?:used by|for) debuggers?|Breakpoint \/ trap|debugger-facing/i,
    'UDF must not be described as a debugger breakpoint (#3750)',
  );
  assert.notEqual(udfEnglish.summary, brkEnglish.summary, 'UDF and BRK summaries must stay distinct (#3750)');

  setLang('ja');
  const brkJapanese = explain('brk', '#0', 0n, {});
  const udfJapanese = explain('udf', '#0', 0n, {});
  assert.equal(brkJapanese.title, 'わざと止める', 'BRK keeps its Japanese title (#3750)');
  assert.match(brkJapanese.summary, /デバッガ用/, 'BRK keeps its Japanese debugger explanation (#3750)');
  assert.match(udfJapanese.title, /永久に未定義/);
  assert.match(udfJapanese.summary, /未定義命令例外/);
  assert.match(udfJapanese.detail.join(' '), /#imm16.*動作を選ぶ値ではありません/);
  assert.doesNotMatch(
    [udfJapanese.title, udfJapanese.summary, ...udfJapanese.detail].join(' '),
    /デバッガ用、または|わざと止める/,
    'UDF must not be described as a Japanese debugger breakpoint (#3750)',
  );
  assert.notEqual(udfJapanese.summary, brkJapanese.summary, 'UDF and BRK Japanese summaries must stay distinct (#3750)');
} finally {
  setLang(trapLang);
}
console.log('  ok 11 UDF/BRK exception intent stays distinct in both languages (#3750)');

/* #3668 Floating comparisons write flags, never their input FP register. */
const fpCompareLang = lang();
try {
  for (const language of ['en', 'ja']) {
    setLang(language);
    for (const width of ['s', 'd']) {
      for (const mnemonic of ['fcmp', 'fcmpe']) {
        const result = explain(mnemonic, `${width}0, ${width}1`);
        assert.equal(result.handlerError, undefined);
        assert.equal(result.pseudo, `flags = ${width}0 ⋛ ${width}1`);
        assert.ok(result.terms.includes('flags'));
        if (mnemonic === 'fcmpe') assert.match(result.detail.join(' '), /quiet NaN.*Invalid Operation/);
      }
      for (const [mnemonic, condition, fallback] of [['fccmp', 'eq', 0], ['fccmpe', 'ne', 15]]) {
        const result = explain(mnemonic, `${width}0, ${width}1, #${fallback}, ${condition}`);
        assert.equal(result.handlerError, undefined);
        assert.equal(result.pseudo, `if (${condition}) flags = ${width}0 ⋛ ${width}1 else flags = ${fallback}`);
        assert.match(result.summary, /NZCV/);
        assert.ok(result.terms.includes('float') && result.terms.includes('flags'));
        if (mnemonic === 'fccmpe') assert.match(result.detail.join(' '), /quiet NaN.*Invalid Operation/);
      }
      for (const [mnemonic, operator] of [['fadd', '+'], ['fsub', '−'], ['fmul', '×'], ['fdiv', '÷']]) {
        assert.equal(explain(mnemonic, `${width}0, ${width}1, ${width}2`).pseudo,
          `${width}0 = ${width}1 ${operator} ${width}2`, 'ordinary FP arithmetic retains its destination');
      }
    }
    assert.equal(explain('fcmpe', 's0, #0.0').pseudo, 'flags = s0 ⋛ 0');
  }
} finally { setLang(fpCompareLang); }
console.log('  ok floating compare flags and conditional NZCV fallback (#3668)');

console.log('ARM64 explainer semantics: PASS');
