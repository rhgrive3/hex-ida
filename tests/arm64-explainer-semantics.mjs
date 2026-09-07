/**
 * ARM64 行説明器のセマンティクス回帰テスト。
 *
 * ここが守るのは 6 つの確定した欠陥です。どれも「表示が壊れている」ではなく
 * 「事実でないことを事実として見せる／本当にある参照を落とす」種類なので、
 * semantic correctness の回帰として恒久的に固定します。
 *
 *   #1288  アドレス 0 の分岐先・参照先が落ちる
 *   #1289  無関係な adrp + add から実在しない参照先を作る
 *   #1293  アドレスの前後関係だけでループと断定する
 *   #1294  ld2/3/4・st2/3/4 の転送量を常に 16 バイトと説明する
 *   #3627  REV16/REV32 と UMULL が別のバイト範囲・符号であることを落とす
 *   (new)  immShort / absHex / memExpr が import されておらず、
 *          メモリ系・即値系の説明が例外で空になる
 *
 * 最後の 1 件は `explain()` の catch が例外を握りつぶしていたため、
 * 「説明がまだ無い命令」と見分けが付きませんでした。そこで handler の失敗は
 * `out.handlerError` に残るようにし、このテストが機械的に検出します。
 */
import assert from 'node:assert/strict';
import { explain, referenceTarget, operandNotes } from '../js/arm64.js';

console.log('Testing ARM64 explainer semantics...');

/* ── #1288 アドレス 0 は「参照なし」ではない ───────────────── */

assert.equal(referenceTarget('b', '#0x0'), 0n, 'b to address 0 must keep its target');
assert.equal(referenceTarget('bl', '#0x0'), 0n, 'bl to address 0 must keep its target');
assert.equal(referenceTarget('b.eq', '#0x0'), 0n, 'conditional branch to 0 must keep its target');
assert.equal(referenceTarget('cbz', 'x0, #0x0'), 0n, 'cbz to address 0 must keep its target');
assert.equal(referenceTarget('tbz', 'x0, #3, #0x0'), 0n, 'tbz must report the branch target, not the bit index');
assert.equal(referenceTarget('adr', 'x0, #0x0'), 0n, 'adr of address 0 must keep its target');
assert.equal(referenceTarget('adrp', 'x0, #0x0'), 0n, 'adrp of page 0 must keep its target');
assert.equal(referenceTarget('ldr', 'x0, #0x0'), 0n, 'literal load from address 0 must keep its target');
// 通常の正のアドレスは今までどおり。
assert.equal(referenceTarget('b', '#0x1000'), 0x1000n);
assert.equal(referenceTarget('tbz', 'x0, #3, #0x1000'), 0x1000n);
// 参照を持たない命令は今までどおり null。
assert.equal(referenceTarget('add', 'x0, x1, #4'), null);
assert.equal(referenceTarget('ret', ''), null);
console.log('  ok 1 address-zero targets survive (#1288)');

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

console.log('ARM64 explainer semantics: PASS');
