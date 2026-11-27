import assert from 'node:assert/strict';
import test from 'node:test';

import { PASS_STAGES } from '../js/decompiler/phase8/contract.js';
import {
  applyStructuredControlProjection,
  projectNaturalLoops,
  runPhase8Stage,
} from '../js/decompiler/phase8/index.js';
import { RewriteEngine } from '../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { expr, sourceOf, structuralKey } from '../js/decompiler/ast/nodes.js';
import { factFromRange, rangeOf, truncateFact } from '../js/decompiler/phase8/range.js';
import { createRebuildPlan, materializeRebuildPlan, validateRebuildOutput } from '../js/rebuild/index.js';
import { stableDigestBytes } from '../js/core/identity/index.js';
import { recoverArm64ClangIdiom, recognizeClamp } from '../js/decompiler/idioms/arm64-clang.js';
import { recoverExactStackReturn } from '../js/decompiler/passes/stack-return-recovery.js';
import { recoverExactStackPhiExpressions } from '../js/decompiler/passes/stack-phi-recovery.js';
import { OP, VK } from '../js/ir.js';
import { fixture } from './phase8/helpers/ir-fixtures.mjs';

const BASE = 0x1000n;
const A = (block) => BASE + BigInt(block) * 4n;
const hex = (block) => A(block).toString(16).toUpperCase();

function withProducerLayout(ir) {
  const instructions = [];
  for (const block of ir.blocks ?? []) {
    block.startRow = block.index;
    block.endRow = block.index;
    delete block.address;
    for (const instruction of block.insts ?? []) {
      instruction.row = block.index;
      instruction.address = A(block.index);
      instructions.push(instruction);
    }
  }
  ir.instructions = instructions;
  return ir;
}

function makeLine(kind, indent, text, block, index) {
  return {
    kind,
    indent,
    text,
    row: index,
    block,
    addr: A(block),
    source: sourceOf({ row: index, address: A(block), ir: [`inst_${block}_${index}`] }),
    semantic: { op: kind === 'ctrl' ? 'control-render' : 'statement', block, ir: `inst_${block}_${index}` },
  };
}

function bodyOf(rows) {
  return rows.map(([kind, indent, text, block], index) => makeLine(kind, indent, text, block, index));
}

// ---------------------------------------------------------------------------
// 1. [P0] loop-control-projection: projectOneLoop must not rewrite gotos inside
//    nestedRanges (inner loop / switch) into bare break;/continue;
// ---------------------------------------------------------------------------
test('[E-1 P0] projectOneLoop excludes gotos inside nested already-projected loop/switch', () => {
  // Outer loop: block 0 (header/guard: if c goto 1 else 4),
  // block 1 (inner already-projected while loop with goto to outer exit 4),
  // block 2 (latch -> 0), block 4 (exit).
  const f = fixture('outer-nested-loop');
  const c0 = f.block(0, { succ: [1, 3] }).opaque(1);
  f.conditionalBranch(c0, 1, 3);
  const c1 = f.block(1, { succ: [2, 3] }).opaque(1);
  f.conditionalBranch(c1, 2, 3);
  f.block(2, { succ: [0] }).branch(0);
  f.block(3).ret();
  const ir = withProducerLayout(f.build());

  const { ledger, analysis } = runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs: 5000 });
  assert.equal(ledger.published, true);
  const facts = analysis.get('structuredRegions');
  const induction = analysis.get('induction');
  const cfg = analysis.get('cfg');
  const dominators = analysis.get('dominators');

  const body = bodyOf([
    ['label', 1, `loc_${hex(0)}:`, 0],
    ['ctrl', 1, `if (c0) goto loc_${hex(1)};`, 0],
    ['stmt', 1, `goto loc_${hex(3)};`, 0],
    ['ctrl', 1, 'while (c1) {', 1],
    ['stmt', 2, `if (err) goto loc_${hex(3)};`, 1],
    ['ctrl', 1, '}', 1],
    ['stmt', 1, `goto loc_${hex(0)};`, 2],
    ['label', 1, `loc_${hex(3)}:`, 3],
    ['stmt', 1, 'return;', 3],
  ]);

  const res = projectNaturalLoops(body, {
    ir,
    cfg,
    dominators,
    facts,
    induction,
    blockOfNode: (n) => n.block ?? null,
    blockAddress: (idx) => A(idx),
    textJumpsToAddress: (text, addr) => typeof text === 'string' && addr != null && text.includes(`loc_${addr.toString(16).toUpperCase()}`),
    renderCondition: () => 'c0',
    controlSource: (inst, b) => sourceOf({ row: inst?.row ?? b, address: A(b), ir: [inst?.id].filter(Boolean) }),
  });

  assert.ok(res, 'outer loop should be projected');
  const rendered = res.body.map((n) => n.text).join('\n');
  assert.ok(rendered.includes('while (c0) {'), 'outer loop becomes while');
  assert.ok(rendered.includes(`if (err) goto loc_${hex(3)};`), 'goto inside nested while must NOT become bare break;');
});

// ---------------------------------------------------------------------------
// 2. [P0] structured-control-projection: preserve goto loc_join when an
//    unrelated block sits between the structured if and join
// ---------------------------------------------------------------------------
test('[E-2 P0] structured-control-projection keeps goto loc_join when unrelated block intervenes', () => {
  const f = fixture('diamond-intervening');
  const cond = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(cond, 1, 2);
  f.block(1, { succ: [3] }).store(f.constant(42, 32));
  f.branch(3);
  f.block(2, { succ: [3] }).store(f.constant(99, 32));
  f.branch(3);
  f.block(3).ret();
  const ir = withProducerLayout(f.build());

  const { ledger, analysis } = runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs: 5000 });
  assert.equal(ledger.published, true);

  // Unrelated block 99 placed immediately after entry in workingBody!
  const body = bodyOf([
    ['ctrl', 1, `if (cond) goto loc_${hex(1)};`, 0],
    ['stmt', 1, `goto loc_${hex(2)};`, 0],
    ['label', 1, 'loc_9999:', 99],
    ['stmt', 1, 'return 99;', 99],
    ['label', 1, `loc_${hex(1)}:`, 1],
    ['stmt', 1, 'x = 1;', 1],
    ['stmt', 1, `goto loc_${hex(3)};`, 1],
    ['label', 1, `loc_${hex(2)}:`, 2],
    ['stmt', 1, 'x = 2;', 2],
    ['stmt', 1, `goto loc_${hex(3)};`, 2],
    ['label', 1, `loc_${hex(3)}:`, 3],
    ['stmt', 1, 'return x;', 3],
  ]);

  const out = applyStructuredControlProjection({
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: body.map((n) => n.text).join('\n'),
  }, analysis);

  const text = out.cAst.body.map((n) => n.text).join('\n');
  assert.ok(text.includes('if (cond) {'), 'should structure if-else');
  assert.ok(text.includes(`goto loc_${hex(3)};`), 'must preserve goto loc_join when unrelated block intervenes');
  assert.ok(text.includes(`loc_${hex(3)}:`), 'must preserve join label');
});

// ---------------------------------------------------------------------------
// 3. [P1] structured-control-projection: fallback condition respects whether
//    existing goto targets trueTarget or falseTarget
// ---------------------------------------------------------------------------
test('[E-3 P1] structured-control-projection fallback inverts when existing goto jumps to falseTarget', () => {
  const f = fixture('diamond-fallback-invert');
  const cond = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(cond, 1, 2);
  f.block(1, { succ: [3] }).store(f.constant(42, 32));
  f.branch(3);
  f.block(2, { succ: [3] }).store(f.constant(99, 32));
  f.branch(3);
  f.block(3).ret();
  const ir = withProducerLayout(f.build());

  const { ledger, analysis } = runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs: 5000 });
  assert.equal(ledger.published, true);

  // Existing branch jumps to falseTarget (block 2), not trueTarget (block 1)!
  const body = bodyOf([
    ['ctrl', 1, `if (a == 0) goto loc_${hex(2)};`, 0],
    ['stmt', 1, `goto loc_${hex(1)};`, 0],
    ['label', 1, `loc_${hex(1)}:`, 1],
    ['stmt', 1, 'x = 1;', 1],
    ['stmt', 1, `goto loc_${hex(3)};`, 1],
    ['label', 1, `loc_${hex(2)}:`, 2],
    ['stmt', 1, 'x = 2;', 2],
    ['stmt', 1, `goto loc_${hex(3)};`, 2],
    ['label', 1, `loc_${hex(3)}:`, 3],
    ['stmt', 1, 'return x;', 3],
  ]);

  const out = applyStructuredControlProjection({
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: body.map((n) => n.text).join('\n'),
  }, analysis);

  const header = out.cAst.body.find((n) => n.kind === 'ctrl' && n.text.startsWith('if '));
  assert.equal(header?.text, 'if (!(a == 0)) {', 'must negate fallback condition when existing goto targets falseTarget');
});

// ---------------------------------------------------------------------------
// 4. [P1] rewrite/rules: select-abs requires q.compareSigned === true
// ---------------------------------------------------------------------------
test('[E-4 P1] select-abs does not rewrite unsigned comparison to signed abs()', () => {
  const engine = new RewriteEngine(DEFAULT_RULES);
  const x = expr.variable('x', 32, false, null, { ssaId: 'x_u' });
  const zero = expr.constant(0, 32, false);
  const unsignedCmp = expr.compare('lt', x, zero, false, null, { compareSigned: false });
  const unsignedSel = expr.select(unsignedCmp, expr.unary('neg', x, 32, false), x, 32, false);
  const unsignedOut = engine.rewrite(unsignedSel, { deterministicTransforms: true });
  assert.equal(unsignedOut.root.kind, 'select', 'unsigned select must not become abs()');
  assert.equal(structuralKey(unsignedOut.root), structuralKey(unsignedSel));

  const signedX = expr.variable('x', 32, true, null, { ssaId: 'x_s' });
  const signedZero = expr.constant(0, 32, true);
  const signedCmp = expr.compare('lt', signedX, signedZero, true, null, { compareSigned: true });
  const signedSel = expr.select(signedCmp, expr.unary('neg', signedX, 32, true), signedX, 32, true);
  const signedOut = engine.rewrite(signedSel, { deterministicTransforms: true });
  assert.equal(signedOut.root.kind, 'intrinsic');
  assert.equal(signedOut.root.name, 'abs');
});

// ---------------------------------------------------------------------------
// 5. [P1] phase8/range: truncateFact reduces congruence.modulus with gcd
// ---------------------------------------------------------------------------
test('[E-5 P1] truncateFact reduces congruence modulus to target width without becoming malformed', () => {
  const f64 = factFromRange(rangeOf(5n, 5n, 64), {
    congruence: { remainder: 5n, modulus: 1n << 64n },
    status: 'exact',
  });
  assert.equal(f64.status, 'exact');
  const t8 = truncateFact(f64, 8);
  assert.equal(t8.status, 'exact');
  assert.equal(t8.congruence.modulus, 256n);
  assert.equal(t8.congruence.remainder, 5n);

  const f32 = factFromRange(rangeOf(1n, 1n, 32), {
    congruence: { remainder: 1n, modulus: 16n },
    status: 'exact',
  });
  const t1 = truncateFact(f32, 1);
  assert.equal(t1.status, 'exact');
  assert.equal(t1.congruence.modulus, 2n);
  assert.equal(t1.congruence.remainder, 1n);
});

// ---------------------------------------------------------------------------
// 6. [P1] rebuild/index: validateRebuildOutput reflects independentOracle
//    failure in failures and valid even when not in requiredValidators
// ---------------------------------------------------------------------------
test('[E-6 P1] validateRebuildOutput marks output invalid when independentOracle fails', async () => {
  const original = Uint8Array.from([0x10, 0x20, 0x30, 0x40]);
  const sourceHash = `bytes:${stableDigestBytes(original)}`;
  const plan = createRebuildPlan({
    binaryId: 'bin-e6',
    sourceHash,
    operations: [{ offset: 1, before: [0x20], after: [0x99] }],
  });
  const materialized = await materializeRebuildPlan(plan, original);
  assert.equal(materialized.status, 'materialized');

  const validation = await validateRebuildOutput(plan, materialized, {
    original,
    loaderReparse: () => ({ ok: true }),
    validators: { evidence: () => ({ ok: true }) },
    independentOracle: () => ({ ok: false, reason: 'differential-mismatch' }),
  });
  assert.equal(validation.status, 'invalid');
  assert.equal(validation.independentDifferential, 'failed');
  assert.ok(
    validation.failures.some((f) => f.validator === 'independent-differential' && f.reason === 'differential-mismatch'),
    'failures must include independent-differential',
  );
});

// ---------------------------------------------------------------------------
// 7. [P1] idioms/arm64-clang: bit_extract rejects mask === 0n
// ---------------------------------------------------------------------------
test('[E-7 P1] recoverArm64ClangIdiom rejects mask === 0n for bit_extract', () => {
  const x = expr.variable('x', 32, false);
  const zeroMask = expr.binary('and', expr.binary('lshr', x, expr.constant(4, 32), 32), expr.constant(0, 32), 32);
  const resZero = recoverArm64ClangIdiom(zeroMask);
  assert.notEqual(resZero.kind, 'intrinsic', 'mask === 0n must not produce width-0 bit_extract');

  const validMask = expr.binary('and', expr.binary('lshr', x, expr.constant(4, 32), 32), expr.constant(0xf, 32), 32);
  const resValid = recoverArm64ClangIdiom(validMask);
  assert.equal(resValid.kind, 'intrinsic');
  assert.equal(resValid.name, 'bit_extract');
  assert.equal(resValid.args[2].value, 4n);
});

// ---------------------------------------------------------------------------
// 8. [P2] idioms/arm64-clang: recognizeClamp excludes non-clamp min(x, max(x, y))
//    and uses structural sameExpr in shared path
// ---------------------------------------------------------------------------
test('[E-8 P2] recognizeClamp excludes non-clamp min(x, max(x, y)) and uses sameExpr', () => {
  const x = expr.variable('x', 32, true);
  const y = expr.variable('y', 32, true);
  const add1 = expr.binary('add', x, expr.constant(1, 32, true), 32, true);
  const add2 = expr.binary('add', x, expr.constant(1, 32, true), 32, true);

  assert.equal(recognizeClamp(expr.intrinsic('min', [x, expr.intrinsic('max', [x, y], 32, true)], 32, true)), null);
  assert.equal(recognizeClamp(expr.intrinsic('min', [add1, expr.intrinsic('max', [add2, add2], 32, true)], 32, true)), null);

  const low = expr.constant(0, 32, true);
  const historical = recognizeClamp(expr.intrinsic('min', [add1, expr.intrinsic('max', [add2, low], 32, true)], 32, true));
  assert.equal(historical?.kind, 'clamp');
  assert.equal(historical?.low?.value, 0n);
});

// ---------------------------------------------------------------------------
// 9. [P2] stack-phi-recovery & stack-return-recovery: tbz/tbnz testing cset
//    requires Number(term.extra?.bit) === 0
// ---------------------------------------------------------------------------
test('[E-9 P2] tbz/tbnz testing cset (sub=set) requires bit === 0', () => {
  const buildIr = (bit) => {
    const a = { id: 1, kind: VK.ARG, reg: 'w0', bits: 32, def: null, uses: [] };
    const b = { id: 2, kind: VK.ARG, reg: 'w1', bits: 32, def: null, uses: [] };
    const flags = { id: 3, kind: VK.UNKNOWN, bits: 32, def: null, uses: [] };
    const csetOut = { id: 4, kind: VK.REG, bits: 32, def: null, uses: [] };
    const cmp = { id: 10, block: 0, row: 0, op: OP.CMP, sub: 'sub', bits: 32, dst: flags, args: [{ value: a }, { value: b }] };
    const cset = { id: 11, block: 0, row: 1, op: OP.SEL, sub: 'set', cond: 'eq', bits: 32, dst: csetOut, args: [{ value: flags }] };
    const tbnz = { id: 12, block: 0, row: 2, op: OP.CBR, sub: 'tbnz', extra: { kind: 'tbnz', bit }, args: [{ value: csetOut }], target: 0x1020n, fallthrough: 0x1010n };
    const ret1 = { id: 13, block: 1, row: 3, op: OP.RET, args: [{ value: { id: 5, kind: VK.CONST, value: 10n, bits: 32 } }] };
    const ret2 = { id: 14, block: 2, row: 4, op: OP.RET, args: [{ value: { id: 6, kind: VK.CONST, value: 20n, bits: 32 } }] };
    flags.def = cmp;
    csetOut.def = cset;
    return {
      blocks: [
        { index: 0, startRow: 0, endRow: 2, address: 0x1000n, succ: [2, 1], insts: [cmp, cset, tbnz] },
        { index: 1, startRow: 3, endRow: 3, address: 0x1010n, succ: [], insts: [ret1] },
        { index: 2, startRow: 4, endRow: 4, address: 0x1020n, succ: [], insts: [ret2] },
      ],
      instructions: [cmp, cset, tbnz, ret1, ret2],
    };
  };

  const irBit1 = buildIr(1);
  const resBit1 = recoverExactStackReturn({ ir: irBit1 });
  assert.notEqual(resBit1?.condition?.op, 'eq', 'tbnz bit 1 on cset must not fold to eq');
  assert.equal(typeof recoverExactStackPhiExpressions, 'function');
});

// ---------------------------------------------------------------------------
// 10. [P2] phase8/induction: resolveStep guards unsupported bit widths
// ---------------------------------------------------------------------------
test('[E-10 P2] induction resolveStep guards unsupported bit widths without throwing TypeError', () => {
  const f = fixture('unsupported-width-induction');
  f.block(0);
  const init = f.constant(0, 48);
  const limit = f.constant(10, 48);
  f.branch(1);
  f.block(1, { succ: [2, 3] });
  const counter = f.phi([[0, init], [2, null]], 48);
  const cond = f.binary('ult', counter, limit, 1);
  f.conditionalBranch(cond, 2, 3);
  f.block(2, { succ: [1] });
  const step = f.constant(1, 48);
  const next = f.binary('add', counter, step, 48);
  f.closePhi(counter, 2, next);
  f.branch(1);
  f.block(3).ret();
  const ir = f.build();

  const { ledger, analysis } = runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs: 2000 });
  assert.equal(ledger.published, true);
  const induction = analysis.get('induction');
  assert.equal(induction.loops.length, 1);
  assert.equal(induction.loops[0].inductions.length, 0, 'unsupported 48-bit induction must be refused gracefully without throwing');
});
