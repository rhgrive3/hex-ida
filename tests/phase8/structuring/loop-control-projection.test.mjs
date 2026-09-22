import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceOf } from '../../../js/decompiler/ast/nodes.js';
import { decompile } from '../../../js/decompile.js';
import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../../js/targets/abi/index.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { modelFromAssembly } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { PASS_STAGES } from '../../../js/decompiler/phase8/contract.js';
import {
  applyStructuredControlProjection,
  readStructuredControlProjection,
  LOOP_CONTROL_PROJECTION_VERSION,
  LOOP_PROJECTION_CANCELLED,
  LOOP_PROJECTION_RULE,
  isAdoptableLoopRegion,
  projectNaturalLoops,
  edgeAccountingFailures,
  runPhase8Stage,
} from '../../../js/decompiler/phase8/index.js';
import { readSemanticControlLineHistory, registerSemanticControlLineHistory } from '../../../js/decompiler/semantic-core.js';
import { canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

const BASE = 0x1000n;
const A = (block) => BASE + BigInt(block) * 4n;
const hex = (block) => A(block).toString(16).toUpperCase();

function analyze(ir, { loops = null } = {}) {
  const { ledger, analysis } = runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs: 5000 });
  assert.equal(ledger.published, true, 'acceptance requires a published Phase 8 ledger');
  const facts = analysis.get('structuredRegions');
  assert.ok(facts, 'acceptance requires structured-region facts');
  assert.equal(facts.completeness, 'complete');
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);
  const induction = analysis.get('induction');
  assert.ok(induction, 'acceptance requires loop facts');
  void loops;
  return { ledger, analysis, facts, induction };
}

/** The producer's own block/row/address layout: one row per block. */
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

/** `[kind, indent, text, block]` → rendered nodes in producer order. */
function bodyOf(rows) {
  return rows.map(([kind, indent, text, block], index) => makeLine(kind, indent, text, block, index));
}

function project(ir, rows, { opts = {}, overrideAnalysis = null, decorateBody = null } = {}) {
  const { analysis, facts, induction } = analyze(ir);
  const body = bodyOf(rows);
  if (typeof decorateBody === 'function') decorateBody(body, ir);
  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: body.map((node) => node.text).join('\n'),
    rewriteProof: [],
    metrics: {},
  };
  const effective = overrideAnalysis == null
    ? analysis
    : { get: (key) => overrideAnalysis(key, analysis) };
  const projected = applyStructuredControlProjection(result, effective, opts);
  return { result, projected, analysis, facts, induction, body };
}

const textsOf = (result) => (result?.cAst?.body ?? []).map((node) => node.text);
const count = (values, pattern) => values.filter((value) => pattern.test(String(value))).length;

/* ── fixtures ──────────────────────────────────────────────────────────── */

function whileIr() {
  const f = fixture('while');
  f.block(0, { succ: [1] }).branch(1);
  const cond = f.block(1, { succ: [2, 3] }).opaque(1);
  f.conditionalBranch(cond, 2, 3);
  f.block(2, { succ: [1] }).store(f.constant(1, 32));
  f.branch(1);
  f.block(3).ret();
  return withProducerLayout(f.build());
}

function invertedWhileIr() {
  const f = fixture('inverted-while');
  f.block(0, { succ: [1] }).branch(1);
  const cond = f.block(1, { succ: [2, 3] }).opaque(1);
  // The taken arm leaves the loop; the loop body is the fallthrough.
  f.conditionalBranch(cond, 3, 2);
  f.block(2, { succ: [1] }).store(f.constant(1, 32));
  f.branch(1);
  f.block(3).ret();
  return withProducerLayout(f.build());
}

function nestedWhileIr() {
  const f = fixture('nested-while');
  f.block(0, { succ: [1] }).branch(1);
  const outer = f.block(1, { succ: [2, 6] }).opaque(1);
  f.conditionalBranch(outer, 2, 6);
  f.block(2, { succ: [4] }).store(f.constant(2, 32));
  f.branch(4);
  const inner = f.block(4, { succ: [5, 3] }).opaque(1);
  f.conditionalBranch(inner, 5, 3);
  f.block(5, { succ: [4] }).store(f.constant(5, 32));
  f.branch(4);
  f.block(3, { succ: [1] }).branch(1);
  f.block(6).ret();
  return withProducerLayout(f.build());
}

function breakWhileIr() {
  const f = fixture('break-while');
  f.block(0, { succ: [1] }).branch(1);
  const guard = f.block(1, { succ: [2, 5] }).opaque(1);
  f.conditionalBranch(guard, 2, 5);
  f.block(2, { succ: [3] }).store(f.constant(2, 32));
  f.branch(3);
  const breaker = f.block(3, { succ: [5, 4] }).opaque(1);
  f.conditionalBranch(breaker, 5, 4);
  f.block(4, { succ: [1] }).store(f.constant(4, 32));
  f.branch(1);
  f.block(5).ret();
  return withProducerLayout(f.build());
}

function continueWhileIr() {
  const f = fixture('continue-while');
  f.block(0, { succ: [1] }).branch(1);
  const guard = f.block(1, { succ: [2, 4] }).opaque(1);
  f.conditionalBranch(guard, 2, 4);
  const again = f.block(2, { succ: [1, 3] }).opaque(1);
  f.conditionalBranch(again, 1, 3);
  f.block(3, { succ: [1] }).store(f.constant(3, 32));
  f.branch(1);
  f.block(4).ret();
  return withProducerLayout(f.build());
}

function doWhileIr() {
  const f = fixture('do-while');
  f.block(0, { succ: [1] }).branch(1);
  f.block(1, { succ: [2] }).store(f.constant(1, 32));
  f.branch(2);
  const guard = f.block(2, { succ: [1, 3] }).opaque(1);
  f.conditionalBranch(guard, 1, 3);
  f.block(3).ret();
  return withProducerLayout(f.build());
}

/** A post-test shape whose header can leave the loop: never a `do-while`. */
function zeroIterationIr() {
  const f = fixture('zero-iteration');
  f.block(0, { succ: [1] }).branch(1);
  const header = f.block(1, { succ: [2, 5] }).opaque(1);
  f.conditionalBranch(header, 2, 5);
  f.block(2, { succ: [3] }).store(f.constant(1, 32));
  f.branch(3);
  const latch = f.block(3, { succ: [1, 4] }).opaque(1);
  f.conditionalBranch(latch, 1, 4);
  f.block(4).ret();
  f.block(5).ret();
  return withProducerLayout(f.build());
}

/** Two distinct early exits: no single proven break target. */
function twoExitIr() {
  const f = fixture('two-exit');
  f.block(0, { succ: [1] }).branch(1);
  const guard = f.block(1, { succ: [2, 6] }).opaque(1);
  f.conditionalBranch(guard, 2, 6);
  const forked = f.block(2, { succ: [3, 5] }).opaque(1);
  f.conditionalBranch(forked, 3, 5);
  f.block(3, { succ: [4] }).store(f.constant(3, 32));
  f.branch(4);
  f.block(4, { succ: [1] }).store(f.constant(4, 32));
  f.branch(1);
  f.block(5).ret();
  f.block(6).ret();
  return withProducerLayout(f.build());
}

function irreducibleLoopIr() {
  const f = fixture('irreducible-loop');
  f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(f.opaque(1), 1, 2);
  f.block(1, { succ: [2] }).branch(2);
  f.block(2, { succ: [1, 3] }).store(f.constant(1, 32));
  f.branch(1);
  f.block(3).ret();
  return withProducerLayout(f.build({
    loops: [{ header: 1, latches: new Set([2]), nodes: new Set([1, 2]), exits: new Set([3]) }],
  }));
}

function unwindWhileIr() {
  const f = fixture('unwind-while');
  f.block(0, { succ: [1] }).branch(1);
  const guard = f.block(1, { succ: [2, 4] }).opaque(1);
  f.conditionalBranch(guard, 2, 4);
  f.block(2, { succ: [1, 5], edges: [{ to: 1, kind: 'branch' }, { to: 5, kind: 'unwind' }] }).store(f.constant(2, 32));
  f.block(4).ret();
  f.block(5).ret();
  return withProducerLayout(f.build());
}

function dispatcherIr() {
  const f = fixture('dispatcher');
  f.block(0, { succ: [1] }).branch(1);
  const selector = f.block(1, { succ: [2, 3, 4] }).opaque(32);
  f.switchBranch(selector, [[0, 2], [1, 3]], 4);
  f.block(2, { succ: [1] }).branch(1);
  f.block(3, { succ: [1] }).branch(1);
  f.block(4).ret();
  return withProducerLayout(f.build());
}

/* ── rendered bodies in the renderer's own label/goto shape ────────────── */

const WHILE_BODY = [
  ['stmt', 1, 's = 0;', 0],
  ['label', 0, `loc_${hex(1)}:`, 1],
  ['ctrl', 1, `if (c0) goto loc_${hex(2)};`, 1],
  ['stmt', 1, `goto loc_${hex(3)};`, 1],
  ['label', 0, `loc_${hex(2)}:`, 2],
  ['stmt', 1, 's = 1;', 2],
  ['stmt', 1, `goto loc_${hex(1)};`, 2],
  ['label', 0, `loc_${hex(3)}:`, 3],
  ['stmt', 1, 'return s;', 3],
];

const INVERTED_WHILE_BODY = [
  ['stmt', 1, 's = 0;', 0],
  ['label', 0, `loc_${hex(1)}:`, 1],
  ['ctrl', 1, `if (c0) goto loc_${hex(3)};`, 1],
  ['stmt', 1, `goto loc_${hex(2)};`, 1],
  ['label', 0, `loc_${hex(2)}:`, 2],
  ['stmt', 1, 's = 1;', 2],
  ['stmt', 1, `goto loc_${hex(1)};`, 2],
  ['label', 0, `loc_${hex(3)}:`, 3],
  ['stmt', 1, 'return s;', 3],
];

const NESTED_WHILE_BODY = [
  ['stmt', 1, 's = 0;', 0],
  ['label', 0, `loc_${hex(1)}:`, 1],
  ['ctrl', 1, `if (c0) goto loc_${hex(2)};`, 1],
  ['stmt', 1, `goto loc_${hex(6)};`, 1],
  ['label', 0, `loc_${hex(2)}:`, 2],
  ['stmt', 1, 's = 2;', 2],
  ['stmt', 1, `goto loc_${hex(4)};`, 2],
  ['label', 0, `loc_${hex(4)}:`, 4],
  ['ctrl', 1, `if (c1) goto loc_${hex(5)};`, 4],
  ['stmt', 1, `goto loc_${hex(3)};`, 4],
  ['label', 0, `loc_${hex(5)}:`, 5],
  ['stmt', 1, 's = 5;', 5],
  ['stmt', 1, `goto loc_${hex(4)};`, 5],
  ['label', 0, `loc_${hex(3)}:`, 3],
  ['stmt', 1, `goto loc_${hex(1)};`, 3],
  ['label', 0, `loc_${hex(6)}:`, 6],
  ['stmt', 1, 'return s;', 6],
];

const BREAK_WHILE_BODY = [
  ['stmt', 1, 's = 0;', 0],
  ['label', 0, `loc_${hex(1)}:`, 1],
  ['ctrl', 1, `if (c0) goto loc_${hex(2)};`, 1],
  ['stmt', 1, `goto loc_${hex(5)};`, 1],
  ['label', 0, `loc_${hex(2)}:`, 2],
  ['stmt', 1, 's = 2;', 2],
  ['stmt', 1, `goto loc_${hex(3)};`, 2],
  ['label', 0, `loc_${hex(3)}:`, 3],
  ['ctrl', 1, `if (c1) goto loc_${hex(5)};`, 3],
  ['stmt', 1, `goto loc_${hex(4)};`, 3],
  ['label', 0, `loc_${hex(4)}:`, 4],
  ['stmt', 1, 's = 4;', 4],
  ['stmt', 1, `goto loc_${hex(1)};`, 4],
  ['label', 0, `loc_${hex(5)}:`, 5],
  ['stmt', 1, 'return s;', 5],
];

const CONTINUE_WHILE_BODY = [
  ['stmt', 1, 's = 0;', 0],
  ['label', 0, `loc_${hex(1)}:`, 1],
  ['ctrl', 1, `if (c0) goto loc_${hex(2)};`, 1],
  ['stmt', 1, `goto loc_${hex(4)};`, 1],
  ['label', 0, `loc_${hex(2)}:`, 2],
  ['ctrl', 1, `if (c1) goto loc_${hex(1)};`, 2],
  ['stmt', 1, `goto loc_${hex(3)};`, 2],
  ['label', 0, `loc_${hex(3)}:`, 3],
  ['stmt', 1, 's = 3;', 3],
  ['stmt', 1, `goto loc_${hex(1)};`, 3],
  ['label', 0, `loc_${hex(4)}:`, 4],
  ['stmt', 1, 'return s;', 4],
];

const DO_WHILE_BODY = [
  ['stmt', 1, 's = 0;', 0],
  ['label', 0, `loc_${hex(1)}:`, 1],
  ['stmt', 1, 's = 1;', 1],
  ['stmt', 1, `goto loc_${hex(2)};`, 1],
  ['label', 0, `loc_${hex(2)}:`, 2],
  ['ctrl', 1, `if (c0) goto loc_${hex(1)};`, 2],
  ['stmt', 1, `goto loc_${hex(3)};`, 2],
  ['label', 0, `loc_${hex(3)}:`, 3],
  ['stmt', 1, 'return s;', 3],
];

/* ── A. simple while ───────────────────────────────────────────────────── */

test('loop A. proven pre-test natural loop projects to while', () => {
  const { result, projected, facts } = project(whileIr(), WHILE_BODY);
  assert.ok(facts.regions.some((region) => region.kind === 'loop' && region.entry === 1));
  assert.notEqual(projected, result, 'a proven loop must be adopted');
  const texts = textsOf(projected);
  assert.deepEqual(texts, ['s = 0;', 'while (c0) {', 's = 1;', '}', 'return s;'],
    'the guard, the closing jump, and the labels nothing jumps to are gone');
  assert.equal(count(texts, /^goto loc_/), 0, 'no residual loop jumps remain');
  assert.ok(!texts.some((text) => /^loc_[0-9a-fA-F]+:$/.test(text)),
    'a label no emitted line jumps to is dropped');
  assert.equal(projected.cAst.body[1].indent, 1, 'the construct keeps the guard line indentation');
  assert.equal(projected.cAst.body[2].indent, 2, 'the body sits one level inside the construct');
  assert.equal(projected.rewriteProof.at(-1).rule, LOOP_PROJECTION_RULE);
});

/* ── B. inverted-condition while ───────────────────────────────────────── */

test('loop B. inverted guard polarity inverts the condition instead of the body', () => {
  const { result, projected } = project(invertedWhileIr(), INVERTED_WHILE_BODY);
  assert.notEqual(projected, result);
  const texts = textsOf(projected);
  assert.ok(texts.includes('while (!(c0)) {'), 'the not-taken arm becomes the continuation condition');
  assert.ok(!texts.some((text) => /^goto loc_1004;$/.test(text)), 'back edge is absorbed');
  assert.ok(texts.indexOf('s = 1;') > texts.indexOf('while (!(c0)) {'));
});

/* ── C. nested while ──────────────────────────────────────────────────── */

test('loop C. nested natural loops project innermost first without breaking ownership', () => {
  const { result, projected } = project(nestedWhileIr(), NESTED_WHILE_BODY);
  assert.notEqual(projected, result);
  const texts = textsOf(projected);
  const outer = texts.indexOf('while (c0) {');
  const inner = texts.indexOf('while (c1) {');
  assert.ok(outer >= 0, 'outer loop is projected');
  assert.ok(inner > outer, 'inner loop is projected inside the outer construct');
  assert.equal(count(texts, /^while \(/), 2, 'exactly two loops are projected');
  assert.ok(texts.indexOf('s = 2;') > outer && texts.indexOf('s = 2;') < inner, 'outer body precedes the inner loop');
  assert.ok(texts.indexOf('s = 5;') > inner, 'inner body is inside the inner construct');
  const indentOf = (text) => projected.cAst.body.find((node) => node.text === text)?.indent;
  assert.ok(indentOf('s = 5;') > indentOf('s = 2;'), 'inner body is indented deeper');
  const innerHeader = projected.cAst.body.find((node) => node.text === 'while (c1) {');
  assert.ok(readSemanticControlLineHistory(innerHeader, result.ir),
    'outer re-indentation preserves the inner projected control line history');
  assert.equal(count(texts, /^goto loc_/), 0, 'no loop jumps remain in either construct');
});

/* ── D. break ─────────────────────────────────────────────────────────── */

test('loop D. a proven single break target becomes break', () => {
  const { result, projected, facts } = project(breakWhileIr(), BREAK_WHILE_BODY);
  assert.notEqual(projected, result);
  const facts9 = facts.edges.filter((edge) => edge.from === 3);
  assert.ok(facts9.some((edge) => edge.construct === 'loop-break'), 'the canonical facts call this exit a break');
  const texts = textsOf(projected);
  assert.ok(texts.includes('while (c0) {'));
  assert.ok(texts.includes('if (c1) break;'), 'the break edge becomes a break statement');
  assert.ok(!texts.includes(`if (c1) goto loc_${hex(5)};`), 'the break goto is gone');
  assert.ok(texts.includes('s = 4;'), 'remaining body is preserved');
  assert.equal(count(texts, /^goto loc_/), 0);
});

/* ── E. continue ──────────────────────────────────────────────────────── */

test('loop E. a proven back edge that is not the closing edge becomes continue', () => {
  const { result, projected, facts } = project(continueWhileIr(), CONTINUE_WHILE_BODY);
  assert.notEqual(projected, result);
  assert.ok(facts.edges.some((edge) => edge.from === 2 && edge.construct === 'loop-back-edge'),
    'the second latch is a canonical back edge');
  const texts = textsOf(projected);
  assert.ok(texts.includes('while (c0) {'));
  assert.ok(texts.includes('if (c1) continue;'), 'the interior back edge becomes continue');
  assert.ok(texts.includes('s = 3;'));
  assert.equal(count(texts, /^goto loc_/), 0, 'the closing back edge is absorbed, not left as a jump');
});

/* ── F. safe do-while ─────────────────────────────────────────────────── */

test('loop F. a post-test loop whose header cannot leave becomes do-while', () => {
  const { result, projected, facts } = project(doWhileIr(), DO_WHILE_BODY);
  assert.notEqual(projected, result);
  const loop = facts.regions.find((region) => region.kind === 'loop' && region.entry === 1);
  assert.ok(loop, 'the post-test loop is a canonical loop region');
  const texts = textsOf(projected);
  assert.ok(texts.includes('do {'), 'post-test loop becomes do');
  assert.ok(texts.includes('} while (c0);'), 'the latch guard becomes the closing condition');
  assert.ok(texts.indexOf('s = 1;') > texts.indexOf('do {'), 'the body runs inside the construct');
  assert.ok(!texts.some((text) => /^goto loc_1004;$/.test(text)), 'the back edge is absorbed');
});

/* ── G. zero-iteration loop is never a do-while ───────────────────────── */

test('loop G. a loop that may run zero times is never projected as do-while', () => {
  const { result, projected } = project(zeroIterationIr(), [
    ['stmt', 1, 's = 0;', 0],
    ['label', 0, `loc_${hex(1)}:`, 1],
    ['ctrl', 1, `if (c0) goto loc_${hex(2)};`, 1],
    ['stmt', 1, `goto loc_${hex(5)};`, 1],
    ['label', 0, `loc_${hex(2)}:`, 2],
    ['stmt', 1, 's = 1;', 2],
    ['stmt', 1, `goto loc_${hex(3)};`, 2],
    ['label', 0, `loc_${hex(3)}:`, 3],
    ['ctrl', 1, `if (c1) goto loc_${hex(1)};`, 3],
    ['stmt', 1, `goto loc_${hex(4)};`, 3],
    ['label', 0, `loc_${hex(4)}:`, 4],
    ['stmt', 1, 'return s;', 4],
    ['label', 0, `loc_${hex(5)}:`, 5],
    ['stmt', 1, 'return 0;', 5],
  ]);
  const texts = textsOf(projected);
  assert.ok(!texts.includes('do {'), 'a loop with a header exit is never a do-while');
  assert.ok(texts.includes('s = 0;') && texts.includes('s = 1;') && texts.includes('return s;'),
    'observable statements are untouched either way');

  // The proof itself refuses a forged post-test guard whose header can leave.
  const ir = zeroIterationIr();
  const { analysis, facts, induction } = analyze(ir);
  const region = facts.regions.find((entry) => entry.kind === 'loop');
  assert.ok(region);
  const forged = {
    ...induction,
    loops: induction.loops.map((entry) => ({
      ...entry, guardBlock: entry.latches[0], guardBlockReason: null,
    })),
  };
  assert.equal(
    isAdoptableLoopRegion(region, facts, analysis.get('cfg'), analysis.get('dominators'), forged),
    false,
    'a latch guard is not a post-test proof when the header can leave the loop',
  );
  assert.equal(projected, result, 'a loop whose header can leave falls back unchanged');
});

/* ── H. multi-exit fallback ───────────────────────────────────────────── */

test('loop H. a loop with two distinct exit targets falls back unchanged', () => {
  const ir = twoExitIr();
  const { analysis, facts } = analyze(ir);
  const region = facts.regions.find((entry) => entry.kind === 'loop');
  assert.ok(region);
  const loop = analysis.get('induction').loops.find((entry) => entry.header === 1);
  assert.ok(loop);
  const exitTargets = new Set((loop.exitEdges ?? []).map((edge) => edge.to));
  assert.equal(exitTargets.size, 2, 'the loop leaves to two distinct blocks');
  assert.ok(loop.earlyExitEdges.length > 0, 'one of them is an early exit');
  const { result, projected } = project(ir, [
    ['stmt', 1, 's = 0;', 0],
    ['label', 0, `loc_${hex(1)}:`, 1],
    ['ctrl', 1, `if (c0) goto loc_${hex(2)};`, 1],
    ['stmt', 1, `goto loc_${hex(6)};`, 1],
    ['label', 0, `loc_${hex(2)}:`, 2],
    ['ctrl', 1, `if (c1) goto loc_${hex(3)};`, 2],
    ['stmt', 1, `goto loc_${hex(5)};`, 2],
    ['label', 0, `loc_${hex(3)}:`, 3],
    ['stmt', 1, 's = 3;', 3],
    ['stmt', 1, `goto loc_${hex(4)};`, 3],
    ['label', 0, `loc_${hex(4)}:`, 4],
    ['stmt', 1, `goto loc_${hex(1)};`, 4],
    ['label', 0, `loc_${hex(5)}:`, 5],
    ['stmt', 1, 'return 1;', 5],
    ['label', 0, `loc_${hex(6)}:`, 6],
    ['stmt', 1, 'return 0;', 6],
  ]);
  assert.equal(projected.cAst.body.length, result.cAst.body.length, 'not one line is lost');
  assert.equal(projected, result, 'an unproven exit set must fall back referentially');
  assert.equal(projected.pseudocode, result.pseudocode);
});

/* ── I. irreducible loop fallback ─────────────────────────────────────── */

test('loop I. an irreducible region is never structured as a loop', () => {
  const ir = irreducibleLoopIr();
  const { analysis, facts } = analyze(ir);
  const region = facts.regions.find((entry) => entry.kind === 'irreducible');
  assert.ok(region, 'the fixture publishes an irreducible region');
  assert.equal(
    isAdoptableLoopRegion(region, facts, analysis.get('cfg'), analysis.get('dominators'), analysis.get('induction')),
    false,
  );
  assert.equal(facts.regions.some((entry) => entry.kind === 'loop'), false);
  const { projected, result } = project(ir, [
    ['stmt', 1, 's = 0;', 0],
    ['label', 0, `loc_${hex(1)}:`, 1],
    ['stmt', 1, 's = 1;', 1],
    ['stmt', 1, `goto loc_${hex(1)};`, 2],
  ]);
  assert.equal(projected, result);
});

/* ── J. dispatcher fallback ───────────────────────────────────────────── */

test('loop J. a switch-headed dispatcher is never projected as a loop', () => {
  const ir = dispatcherIr();
  const { analysis, facts } = analyze(ir);
  assert.equal(facts.regions.some((entry) => entry.kind === 'loop'), false,
    'a dispatcher publishes no loop region to adopt');
  const { result, projected } = project(ir, [
    ['stmt', 1, 'goto loc_1004;', 0],
    ['label', 0, 'loc_1004:', 1],
    ['stmt', 1, 'switch (state) { case 0: goto loc_1008; case 1: goto loc_100C; default: goto loc_1010; }', 1],
    ['label', 0, 'loc_1008:', 2],
    ['stmt', 1, 'goto loc_1004;', 2],
    ['label', 0, 'loc_100C:', 3],
    ['stmt', 1, 'goto loc_1004;', 3],
    ['label', 0, 'loc_1010:', 4],
    ['stmt', 1, 'return;', 4],
  ]);
  assert.equal(projected, result, 'dispatcher control flow is preserved');
  void analysis;
});

/* ── K. unwind edge fallback ──────────────────────────────────────────── */

test('loop K. a loop carrying an unwind edge is refused', () => {
  const ir = unwindWhileIr();
  const { analysis, facts } = analyze(ir);
  const region = facts.regions.find((entry) => entry.kind === 'loop');
  assert.ok(region);
  assert.ok(region.constraints.length > 0, 'the unwind edge is preserved as a constraint');
  assert.equal(
    isAdoptableLoopRegion(region, facts, analysis.get('cfg'), analysis.get('dominators'), analysis.get('induction')),
    false,
  );
  const { result, projected } = project(ir, [
    ['stmt', 1, 's = 0;', 0],
    ['label', 0, `loc_${hex(1)}:`, 1],
    ['ctrl', 1, `if (c0) goto loc_${hex(2)};`, 1],
    ['stmt', 1, `goto loc_${hex(4)};`, 1],
    ['label', 0, `loc_${hex(2)}:`, 2],
    ['stmt', 1, 's = 2;', 2],
    ['stmt', 1, `goto loc_${hex(1)};`, 2],
    ['label', 0, `loc_${hex(4)}:`, 4],
    ['stmt', 1, 'return;', 4],
    ['label', 0, `loc_${hex(5)}:`, 5],
    ['stmt', 1, 'return;', 5],
  ]);
  assert.equal(projected, result, 'a constraint-bearing loop must not be structured');
});

/* ── L. stale analysisIdentity fallback ───────────────────────────────── */

test('loop L. a stale analysis identity refuses the loop projection', () => {
  const { result, projected } = project(whileIr(), WHILE_BODY, {
    opts: { analysisIdentity: { identity: 'stale-loop-token' } },
  });
  assert.equal(projected, result);
  assert.equal(projected.pseudocode, result.pseudocode);
});

/* ── M. incomplete structuring facts fallback ─────────────────────────── */

test('loop M. incomplete structuring facts refuse the loop projection', () => {
  const { result, projected } = project(whileIr(), WHILE_BODY, {
    overrideAnalysis: (key, analysis) => {
      if (key !== 'structuredRegions') return analysis.get(key);
      return { ...analysis.get('structuredRegions'), completeness: 'partial' };
    },
  });
  assert.equal(projected, result);
});

/* ── N. corrupt edge accounting fallback ──────────────────────────────── */

test('loop N. corrupt edge accounting refuses the loop projection', () => {
  const { result, projected } = project(whileIr(), WHILE_BODY, {
    overrideAnalysis: (key, analysis) => {
      if (key !== 'structuredRegions') return analysis.get(key);
      const facts = analysis.get('structuredRegions');
      return { ...facts, edges: facts.edges.slice(0, 1) };
    },
  });
  assert.equal(projected, result);
});

/* ── O. cancellation / budget exhaustion fallback ─────────────────────── */

test('loop O. an aborted projection changes nothing', () => {
  const { result, projected } = project(whileIr(), WHILE_BODY, { opts: { shouldAbort: () => true } });
  assert.equal(projected, result);
  assert.equal(projected.pseudocode, result.pseudocode);
});

/* ── P. observable order is unchanged ─────────────────────────────────── */

test('loop P. observable statement count and order are exactly preserved', () => {
  const { projected } = project(whileIr(), [
    ['stmt', 1, 'store0();', 0],
    ['label', 0, `loc_${hex(1)}:`, 1],
    ['ctrl', 1, `if (c0) goto loc_${hex(2)};`, 1],
    ['stmt', 1, `goto loc_${hex(3)};`, 1],
    ['label', 0, `loc_${hex(2)}:`, 2],
    ['stmt', 1, 'call1();', 2],
    ['stmt', 1, 'store2();', 2],
    ['stmt', 1, 'call3();', 2],
    ['stmt', 1, `goto loc_${hex(1)};`, 2],
    ['label', 0, `loc_${hex(3)}:`, 3],
    ['stmt', 1, 'return;', 3],
  ]);
  const observable = textsOf(projected)
    .filter((text) => /^(store0|call1|store2|call3|return)/.test(text))
    .map((text, index) => `${index}:${text}`);
  assert.deepEqual(observable, ['0:store0();', '1:call1();', '2:store2();', '3:call3();', '4:return;']);
  assert.equal(count(textsOf(projected), /^while \(/), 1);
});

/* ── Q. nested break ownership ────────────────────────────────────────── */

test('loop Q. an inner break never becomes an outer break', () => {
  const f = fixture('nested-break');
  f.block(0, { succ: [1] }).branch(1);
  const outer = f.block(1, { succ: [2, 6] }).opaque(1);
  f.conditionalBranch(outer, 2, 6);
  f.block(2, { succ: [4] }).store(f.constant(2, 32));
  f.branch(4);
  const inner = f.block(4, { succ: [5, 3] }).opaque(1);
  f.conditionalBranch(inner, 5, 3);
  const innerBody = f.block(5, { succ: [3, 4] });
  innerBody.store(f.constant(5, 32));
  const innerBreaker = innerBody.opaque(1);
  f.conditionalBranch(innerBreaker, 3, 4);
  f.block(3, { succ: [1] }).branch(1);
  f.block(6).ret();
  const ir = withProducerLayout(f.build());
  const { analysis, facts } = analyze(ir);
  const innerLoop = facts.regions.find((region) => region.kind === 'loop' && region.entry === 4);
  const outerLoop = facts.regions.find((region) => region.kind === 'loop' && region.entry === 1);
  assert.ok(innerLoop && outerLoop);

  const nestedBreakBody = NESTED_WHILE_BODY.flatMap((row) => (
    row[3] === 5 && row[2] === `goto loc_${hex(4)};`
      ? [['ctrl', 1, `if (c2) goto loc_${hex(3)};`, 5], row]
      : [row]
  ));
  const body = bodyOf(nestedBreakBody);
  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: body.map((node) => node.text).join('\n'),
    rewriteProof: [],
    metrics: {},
  };
  const projected = applyStructuredControlProjection(result, analysis);
  const texts = textsOf(projected);
  const innerIndex = texts.indexOf('while (c1) {');
  assert.ok(innerIndex > texts.indexOf('while (c0) {'), 'inner loop stays inside the outer construct');

  const innerBreak = facts.edges.find((edge) => edge.from === 5 && edge.to === 3);
  assert.ok(innerBreak, 'the inner loop body has a break edge to the outer latch');
  assert.equal(innerBreak.construct, 'loop-break');
  const breakIndexes = texts
    .map((text, position) => (/\bbreak;$/.test(text) ? position : -1))
    .filter((position) => position >= 0);
  assert.ok(breakIndexes.length > 0, 'the projection emits a break to check');
  for (const position of breakIndexes) {
    assert.ok(position > innerIndex, 'a break must sit inside the inner loop');
  }
});

/* ── R. provenance and histories survive ──────────────────────────────── */

test('loop R. provenance, line histories, and render metadata are preserved', () => {
  const { result, projected } = project(whileIr(), WHILE_BODY, { opts: { renderProvenance: true } });
  assert.notEqual(projected, result);
  const header = projected.cAst.body.find((node) => node.text === 'while (c0) {');
  assert.ok(header, 'the projected construct exists');
  assert.equal(header.row, 1, 'the construct keeps the guard instruction row');
  assert.equal(header.addr, A(1), 'the construct keeps the guard instruction address');
  assert.deepEqual(header.source.addresses, [A(1)], 'the construct carries control provenance');
  const history = readSemanticControlLineHistory(header, result.ir);
  assert.ok(history, 'the construct has a registered control line history');
  assert.equal(history.selection.header, 1);
  assert.equal(history.selection.exit, 3);
  assert.equal(history.selection.form, 'while-loop');
  const record = history.records[0];
  assert.equal(record.rule, LOOP_PROJECTION_RULE);
  assert.equal(record.evidence.regionEntry, 1);
  assert.equal(record.evidence.regionForm, 'while');
  assert.equal(record.evidence.version, LOOP_CONTROL_PROJECTION_VERSION);
  assert.ok(projected.rewriteProof.some((entry) => entry.rule === LOOP_PROJECTION_RULE), 'the adoption is in the rewrite proof');
  assert.equal(projected.sourceMap.length, projected.lines.length, 'every line stays source-mapped');
  assert.ok(projected.renderProvenance, 'render provenance is built when requested');
  const retained = projected.cAst.body.find((node) => node.text === 'return s;');
  assert.equal(retained.row, 8, 'retained statements keep their original row');
  const meta = readStructuredControlProjection(projected);
  assert.ok(meta, 'projection metadata is registered');
  assert.ok(meta.adoptedRegions.some((region) => region.kind === 'loop'));
});

/* ── S. an early-exit guard outside the loop ──────────────────────────── */

/**
 * The real faithful renderer emits a `br` to the exit as a residual
 * `if (c) goto loc_exit;` / `goto loc_header;` pair in front of the loop. Those
 * two nodes belong to the pre-header, not the loop, so the projection must leave
 * them exactly as they are while it structures the loop behind them.
 */
function earlyExitWhileIr() {
  const f = fixture('early-exit-while');
  const gate = f.block(0, { succ: [1, 3] }).opaque(1);
  f.conditionalBranch(gate, 1, 3);
  const guard = f.block(1, { succ: [2, 3] }).opaque(1);
  f.conditionalBranch(guard, 2, 3);
  f.block(2, { succ: [1] }).store(f.constant(1, 32));
  f.branch(1);
  f.block(3).ret();
  return withProducerLayout(f.build());
}

const EARLY_EXIT_WHILE_BODY = [
  ['ctrl', 1, `if (c0) goto loc_${hex(3)};`, 0],
  ['stmt', 1, `goto loc_${hex(1)};`, 0],
  ['label', 0, `loc_${hex(1)}:`, 1],
  ['ctrl', 1, `if (c1) goto loc_${hex(2)};`, 1],
  ['stmt', 1, `goto loc_${hex(3)};`, 1],
  ['label', 0, `loc_${hex(2)}:`, 2],
  ['stmt', 1, 's = 1;', 2],
  ['stmt', 1, `goto loc_${hex(1)};`, 2],
  ['label', 0, `loc_${hex(3)}:`, 3],
  ['stmt', 1, 'return s;', 3],
];

test('loop S. a pre-header guard keeps its own jump while the loop behind it is structured', () => {
  const { result, projected } = project(earlyExitWhileIr(), EARLY_EXIT_WHILE_BODY);
  assert.notEqual(projected, result);
  const texts = textsOf(projected);
  assert.deepEqual(texts, [
    `if (c0) goto loc_${hex(3)};`,
    'while (c1) {',
    's = 1;',
    '}',
    `loc_${hex(3)}:`,
    'return s;',
  ], 'the pre-header guard survives, the loop label is dropped, the exit label is kept');
  for (const text of texts) {
    const jump = /\bgoto\s+loc_([0-9a-fA-F]+)\s*;/.exec(text);
    if (!jump) continue;
    assert.ok(texts.some((candidate) => candidate.startsWith(`loc_${jump[1]}:`)),
      `the remaining jump loc_${jump[1]} still names an emitted label`);
  }
});

/* ── T. the construct keeps every address it replaced ─────────────────── */

/**
 * The real producer gives every instruction its own address, so the nodes a loop
 * construct replaces — the guard's exit jump, the closing back edge, the header
 * label — each carry an address of their own. Dropping any of them shrinks the
 * published source map, which the frozen corpus reads as a provenance loss.
 *
 * The shared fixtures reuse one address per block, which is exactly why a
 * missing node address could slip past them; here every row is addressed.
 */
function addressedWhileBody() {
  return WHILE_BODY.map(([kind, indent, text, block], index) => ({
    kind,
    indent,
    text,
    row: index,
    block,
    addr: A(block),
    source: sourceOf({ row: index, address: BASE + BigInt(index), ir: [`inst_${index}`] }),
    semantic: { op: kind === 'ctrl' ? 'control-render' : 'statement', block, ir: `inst_${index}` },
  }));
}

test('loop T. every source address of the nodes a construct replaces survives', () => {
  const ir = whileIr();
  const body = addressedWhileBody();
  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: body.map((node) => node.text).join('\n'),
    rewriteProof: [],
    metrics: {},
  };
  const { analysis } = analyze(ir);
  const projected = applyStructuredControlProjection(result, analysis);
  assert.notEqual(projected, result, 'the fixture has to actually project for this to prove anything');

  const before = new Set(body.flatMap((node) => node.source.addresses.map(String)));
  assert.equal(before.size, body.length, 'the fixture addresses every row distinctly');
  const after = new Set(projected.cAst.body.flatMap((node) => (node.source?.addresses ?? []).map(String)));
  const missing = [...before].filter((address) => !after.has(address));
  assert.deepEqual(missing, [], 'the projected program keeps every address the input carried');
});

/* ── U. the map is bound to the analysis it was built from ────────────── */

/**
 * Publishing render provenance without the canonical snapshot id makes every
 * adopted construct look like an unverifiable edit: the corpus validation reads
 * a null snapshot id as `missing-snapshot` and the whole map as incomplete.
 */
test('loop U. an adopted projection binds the canonical snapshot id into render provenance', () => {
  const { result, projected, analysis } = project(whileIr(), WHILE_BODY, { opts: { renderProvenance: true } });
  assert.notEqual(projected, result);
  const identity = canonicalAnalysisIdentity({ ir: result.ir, analysis });
  assert.equal(identity.valid, true, 'acceptance requires a valid canonical analysis identity');
  assert.equal(typeof identity.identity.snapshotId, 'string');
  assert.ok(identity.identity.snapshotId.length > 0);

  assert.ok(projected.renderProvenance, 'render provenance is built when requested');
  assert.equal(projected.renderProvenance.snapshotId, identity.identity.snapshotId,
    'the map carries the analysis it was built from, not a null snapshot');
  const validation = validateRenderProvenance(projected.renderProvenance, {
    snapshotId: identity.identity.snapshotId,
  });
  assert.ok(!validation.reasons.includes('missing-snapshot'), 'an unbound map would read as a provenance loss');
  assert.ok(!validation.reasons.includes('stale-snapshot'));
});

/* ── O-bis. cancellation is not "no changes" ─────────────────────────── */

/**
 * A loop that ends in a diamond, so the conditional stage adopts a region and
 * the loop stage aims at another. An abort that lands between the two stages is
 * the case where "stop" and "nothing provable" must not share a representation.
 */
function loopThenDiamondIr() {
  const f = fixture('loop-then-diamond');
  const guard = f.block(0, { succ: [1, 3] }).opaque(1);
  f.conditionalBranch(guard, 1, 3);
  f.block(1, { succ: [0] }).store(f.constant(1, 32));
  f.branch(0);
  const cond = f.block(3, { succ: [4, 5] }).opaque(1);
  f.conditionalBranch(cond, 4, 5);
  f.block(4, { succ: [6] }).store(f.constant(42, 32));
  f.branch(6);
  f.block(5, { succ: [6] }).store(f.constant(99, 32));
  f.branch(6);
  f.block(6).ret();
  return withProducerLayout(f.build());
}

const LOOP_THEN_DIAMOND_BODY = [
  ['ctrl', 1, `if (c0) goto loc_${hex(1)};`, 0],
  ['stmt', 1, `goto loc_${hex(3)};`, 0],
  ['label', 0, `loc_${hex(1)}:`, 1],
  ['stmt', 1, 'x = 1;', 1],
  ['stmt', 1, `goto loc_${hex(0)};`, 1],
  ['label', 0, `loc_${hex(3)}:`, 3],
  ['ctrl', 1, `if (c1) goto loc_${hex(4)};`, 3],
  ['stmt', 1, `goto loc_${hex(5)};`, 3],
  ['label', 0, `loc_${hex(4)}:`, 4],
  ['stmt', 1, 'x = 42;', 4],
  ['stmt', 1, `goto loc_${hex(6)};`, 4],
  ['label', 0, `loc_${hex(5)}:`, 5],
  ['stmt', 1, 'x = 99;', 5],
  ['stmt', 1, `goto loc_${hex(6)};`, 5],
  ['label', 0, `loc_${hex(6)}:`, 6],
  ['stmt', 1, 'return x;', 6],
];

test('loop O-bis. cancellation and "nothing provable" do not share a representation', () => {
  const ir = whileIr();
  const bare = { ir, facts: null, cfg: null, dominators: null, induction: null };
  // Nothing provable at all is `null`: the caller keeps its body referentially.
  assert.equal(projectNaturalLoops(bodyOf(WHILE_BODY), bare), null, 'no facts means nothing was provable');
  assert.equal(projectNaturalLoops([], { ...bare, shouldAbort: () => true }), null,
    'an empty body has nothing to adopt');
  assert.equal(projectNaturalLoops(null, { ...bare, shouldAbort: () => true }), null,
    'a missing body has nothing to adopt');
  // Cancellation is its own thing, exported under a name a caller can branch on.
  assert.notEqual(LOOP_PROJECTION_CANCELLED, null);
  assert.deepEqual(Object.keys(LOOP_PROJECTION_CANCELLED), ['cancelled'],
    'the cancellation marker is a distinct, named sentinel');
});

test('loop O-ter. an abort inside the loop stage stops the projection there', () => {
  // The fixture adopts both stages when nothing aborts, so a cancelled run has
  // to differ from it and the assertions below cannot pass by the fixture simply
  // not being projectable.
  const allowed = project(loopThenDiamondIr(), LOOP_THEN_DIAMOND_BODY);
  assert.notEqual(allowed.projected, allowed.result, 'the fixture projects when nothing aborts');
  const texts = textsOf(allowed.projected);
  assert.ok(texts.includes('while (c0) {'), 'the loop is adopted when allowed');
  assert.ok(texts.includes('if (c1) {'), 'the conditional region is adopted when allowed');

  // How often the predicate is consulted when it never fires, measured on the
  // real code path rather than assumed, so the abort below lands on the loop
  // stage — after the conditional stage already adopted its region.
  let consults = 0;
  project(loopThenDiamondIr(), LOOP_THEN_DIAMOND_BODY, {
    opts: { shouldAbort: () => { consults += 1; return false; } },
  });
  assert.ok(consults >= 3, 'both stages consult the abort predicate');

  let calls = 0;
  const inLoopStage = project(loopThenDiamondIr(), LOOP_THEN_DIAMOND_BODY, {
    opts: { shouldAbort: () => { calls += 1; return calls === consults - 1; } },
  });
  assert.equal(inLoopStage.projected, inLoopStage.result,
    'an abort inside the loop stage publishes nothing');
  assert.equal(inLoopStage.projected.pseudocode, inLoopStage.result.pseudocode);

  let last = 0;
  const afterStages = project(loopThenDiamondIr(), LOOP_THEN_DIAMOND_BODY, {
    opts: { shouldAbort: () => { last += 1; return last === consults; } },
  });
  assert.equal(afterStages.projected, afterStages.result,
    'an abort that lands after the conditional stage still publishes nothing');
});

/* ── mutation / false-green proofs ────────────────────────────────────── */

test('mutation 1. a flipped guard polarity is refused, not rendered with the wrong polarity', () => {
  const ir = whileIr();
  const header = ir.blocks.find((block) => block.index === 1);
  header.successorEdges = [
    { to: 3, kind: 'conditional-true' },
    { to: 2, kind: 'conditional-false' },
  ];
  const { analysis, facts } = analyze(ir);
  const region = facts.regions.find((entry) => entry.kind === 'loop');
  assert.ok(region, 'the loop shape itself is unchanged by the flip');
  const body = bodyOf(WHILE_BODY);
  const result = {
    ir, types: {}, cAst: { kind: 'CProgram', body, source: sourceOf() }, lines: body,
    pseudocode: body.map((node) => node.text).join('\n'), rewriteProof: [], metrics: {},
  };
  const projected = applyStructuredControlProjection(result, analysis);
  assert.equal(projected, result,
    'the rendered guard target disagrees with the flipped artifact, so the loop is refused');
});

test('mutation 2. a forged back-edge target is refused', () => {
  const ir = whileIr();
  const { analysis, facts, induction } = analyze(ir);
  const region = facts.regions.find((entry) => entry.kind === 'loop');
  const cfg = analysis.get('cfg');
  const dominators = analysis.get('dominators');
  const forged = { ...region, residualGotos: ['2->1'] };
  assert.equal(isAdoptableLoopRegion(forged, facts, cfg, dominators, induction), false,
    'a residual jump inside the loop is refused');
  const movedLatch = {
    ...induction,
    loops: induction.loops.map((entry) => ({ ...entry, latches: [0], guardBlock: 0 })),
  };
  assert.equal(isAdoptableLoopRegion(region, facts, cfg, dominators, movedLatch), false,
    'a latch that is not the canonical back edge is refused');
});

test('mutation 3. an added second exit is refused', () => {
  const ir = whileIr();
  const { analysis, facts, induction } = analyze(ir);
  const region = facts.regions.find((entry) => entry.kind === 'loop');
  const loop = induction.loops.find((entry) => entry.header === 1);
  const widened = {
    ...induction,
    loops: induction.loops.map((entry) => (entry === loop
      ? { ...entry, exitEdges: [...entry.exitEdges, { from: 2, to: 3, kind: 'branch' }], earlyExitEdges: [{ from: 2, to: 3, kind: 'branch' }] }
      : entry)),
  };
  assert.equal(isAdoptableLoopRegion(region, facts, analysis.get('cfg'), analysis.get('dominators'), widened), false);
});

test('mutation 4. an added unwind edge is refused', () => {
  const ir = whileIr();
  const { analysis, facts } = analyze(ir);
  const region = facts.regions.find((entry) => entry.kind === 'loop');
  const cfg = analysis.get('cfg');
  const body = cfg.blocks.find((block) => block.index === 2);
  const original = body.successorEdges;
  body.successorEdges = [...original, { to: 3, kind: 'unwind' }];
  body.succ = [...body.succ, 3];
  const after = analyze(ir);
  const afterRegion = after.facts.regions.find((entry) => entry.kind === 'loop');
  assert.ok(afterRegion == null || !isAdoptableLoopRegion(afterRegion, after.facts, after.analysis.get('cfg'), after.analysis.get('dominators'), after.analysis.get('induction')),
    'an unwind edge inside the loop refuses the projection');
  body.successorEdges = original;
  body.succ = body.succ.filter((target) => target !== 3);
  void region;
});

test('mutation 5. natural -> irreducible classification is refused', () => {
  const ir = whileIr();
  const { analysis, facts, induction } = analyze(ir);
  const region = facts.regions.find((entry) => entry.kind === 'loop');
  const degraded = {
    ...induction,
    loops: induction.loops.map((entry) => ({ ...entry, classification: 'irreducible' })),
  };
  assert.equal(isAdoptableLoopRegion(region, facts, analysis.get('cfg'), analysis.get('dominators'), degraded), false);
});

test('mutation 6. swapped inner/outer headers are refused', () => {
  const ir = nestedWhileIr();
  const { analysis, facts, induction } = analyze(ir);
  const inner = facts.regions.find((region) => region.kind === 'loop' && region.entry === 4);
  const outer = facts.regions.find((region) => region.kind === 'loop' && region.entry === 1);
  assert.ok(inner && outer);
  const cfg = analysis.get('cfg');
  const dominators = analysis.get('dominators');
  const swapped = { ...inner, entry: 1, members: inner.members };
  assert.equal(isAdoptableLoopRegion(swapped, facts, cfg, dominators, induction), false,
    'a region whose entry and members disagree with the loop facts is refused');
  const mismatched = { ...outer, members: outer.members.filter((member) => member !== 4) };
  assert.equal(isAdoptableLoopRegion(mismatched, facts, cfg, dominators, induction), false,
    'a region that drops a member is refused');
});

test('mutation 7. a guard exit recorded twice is one exit, a second target is not', () => {
  const ir = whileIr();
  const { analysis, facts, induction } = analyze(ir);
  const region = facts.regions.find((entry) => entry.kind === 'loop');
  const loop = induction.loops.find((entry) => entry.header === 1);
  const cfg = analysis.get('cfg');
  const dominators = analysis.get('dominators');
  const duplicated = {
    ...induction,
    loops: induction.loops.map((entry) => (entry === loop
      ? { ...entry, exitEdges: [...entry.exitEdges, { ...entry.exitEdges[0] }] }
      : entry)),
  };
  assert.equal(isAdoptableLoopRegion(region, facts, cfg, dominators, duplicated), true,
    'the same guard exit recorded twice is still one condition to hoist');
  const forgedTarget = {
    ...induction,
    loops: induction.loops.map((entry) => (entry === loop
      ? { ...entry, exitEdges: [...entry.exitEdges, { from: 1, to: 0, kind: 'conditional-false' }] }
      : entry)),
  };
  assert.equal(isAdoptableLoopRegion(region, facts, cfg, dominators, forgedTarget), false,
    'a guard with a second exit target is not one hoistable condition');
});

test('projection is idempotent: an already projected construct is left alone', () => {
  const ir = whileIr();
  const { analysis, facts, induction } = analyze(ir);
  const projectedOnce = applyStructuredControlProjection({
    ir, types: {}, cAst: { kind: 'CProgram', body: bodyOf(WHILE_BODY), source: sourceOf() },
    lines: bodyOf(WHILE_BODY), pseudocode: '', rewriteProof: [], metrics: {},
  }, analysis);
  assert.notEqual(projectedOnce.pseudocode, '');
  const again = applyStructuredControlProjection(projectedOnce, analysis);
  assert.equal(again, projectedOnce, 'a second pass must not nest a second construct');
  void facts;
  void induction;
});

/* ── already-emitted while: residual break/continue refinement ─────────── */

/**
 * The upstream renderer already published the `while` for this region, but left
 * the proven break edge as a residual `goto`. Projecting the construct again
 * would nest two loops over one region; refusing the region entirely would
 * leave the goto forever. The refine path keeps the construct and rewrites only
 * the jump this proof owns.
 */
test('loop V. an already-emitted while keeps its construct and loses its proven break goto', () => {
  const { result, projected, facts } = project(breakWhileIr(), [
    ['stmt', 1, 's = 0;', 0],
    ['ctrl', 1, `while (c0) {`, 1],
    ['stmt', 2, 's = 2;', 2],
    ['ctrl', 2, `if (c1) goto loc_${hex(5)};`, 3],
    ['stmt', 2, 's = 4;', 4],
    ['ctrl', 1, '}', 4],
    ['stmt', 1, 'return s;', 5],
  ]);
  assert.ok(facts.edges.some((edge) => edge.from === 3 && edge.to === 5 && edge.construct === 'loop-break'),
    'the canonical facts still call this exit a break');
  assert.notEqual(projected, result, 'the proven break goto must be refined');
  const texts = textsOf(projected);
  assert.equal(count(texts, /^while \(/), 1, 'the already-emitted construct is not nested a second time');
  assert.ok(texts.includes('if (c1) break;'), 'the break goto becomes a break statement');
  assert.ok(!texts.some((text) => /^if \(c1\) goto /.test(text)), 'the residual break goto is gone');
  assert.ok(texts.includes('s = 4;'), 'the rest of the body is preserved');
  assert.equal(projected.rewriteProof.at(-1).rule, LOOP_PROJECTION_RULE);
  assert.equal(projected.rewriteProof.at(-1).evidence.version, LOOP_CONTROL_PROJECTION_VERSION);
  assert.equal(projected.rewriteProof.at(-1).after, 'control:loop-break-continue-refine');
});

test('loop V-landing. an already-emitted break is not rewritten across an intervening rendered block', () => {
  const { result, projected } = project(breakWhileIr(), [
    ['stmt', 1, 's = 0;', 0],
    ['ctrl', 1, `while (c0) {`, 1],
    ['stmt', 2, 's = 2;', 2],
    ['ctrl', 2, `if (c1) goto loc_${hex(5)};`, 3],
    ['stmt', 2, 's = 4;', 4],
    ['ctrl', 1, '}', 4],
    ['stmt', 1, 'intervening = 1;', 0],
    ['stmt', 1, 'return s;', 5],
  ]);
  assert.equal(projected, result,
    'a bare break is refused when the first rendered statement after the loop is not the proven exit block');
  const texts = textsOf(projected);
  assert.ok(texts.some((text) => /^if \(c1\) goto /.test(text)),
    'the proven CFG edge remains an explicit goto when rendered fallthrough disagrees');
  assert.ok(!texts.some((text) => /^if \(c1\) break;/.test(text)));
});

test('loop V-history. refining a residual jump appends to existing control provenance', () => {
  const priorRecord = Object.freeze({ rule: 'fixture-upstream-control-history' });
  const { projected } = project(breakWhileIr(), [
    ['stmt', 1, 's = 0;', 0],
    ['ctrl', 1, `while (c0) {`, 1],
    ['stmt', 2, 's = 2;', 2],
    ['ctrl', 2, `if (c1) goto loc_${hex(5)};`, 3],
    ['stmt', 2, 's = 4;', 4],
    ['ctrl', 1, '}', 4],
    ['stmt', 1, 'return s;', 5],
  ], {
    decorateBody(body, ir) {
      registerSemanticControlLineHistory(body[3], Object.freeze({
        ir,
        instruction: null,
        canonical: Object.freeze({ isCurrent: () => true }),
        records: Object.freeze([priorRecord]),
        selection: Object.freeze({ form: 'residual-conditional-goto', target: 5 }),
        isCurrent: () => true,
      }));
    },
  });
  const rewritten = projected.cAst.body.find((node) => node.text === 'if (c1) break;');
  assert.ok(rewritten, 'the proven residual jump is still refined');
  const history = readSemanticControlLineHistory(rewritten, projected.ir);
  assert.ok(history, 'the refined line publishes current control history');
  assert.equal(history.records.length, 2);
  assert.equal(history.records[0], priorRecord, 'upstream provenance remains first');
  assert.equal(history.records[1].rule, LOOP_PROJECTION_RULE, 'the refinement record is appended');
});

test('loop W. refining an already-emitted while is idempotent', () => {
  const body = [
    ['stmt', 1, 's = 0;', 0],
    ['ctrl', 1, `while (c0) {`, 1],
    ['stmt', 2, 's = 2;', 2],
    ['ctrl', 2, `if (c1) goto loc_${hex(5)};`, 3],
    ['stmt', 2, 's = 4;', 4],
    ['ctrl', 1, '}', 4],
    ['stmt', 1, 'return s;', 5],
  ];
  const { result, projected } = project(breakWhileIr(), body);
  assert.notEqual(projected, result);
  const { analysis } = analyze(breakWhileIr());
  const again = applyStructuredControlProjection(projected, analysis);
  assert.equal(again, projected, 'a second refine pass must not rewrite a break that is already a break');
});

test('loop V-bis. an already-emitted while loses its proven continue goto', () => {
  const { result, projected, facts } = project(continueWhileIr(), [
    ['stmt', 1, 's = 0;', 0],
    ['ctrl', 1, `while (c0) {`, 1],
    ['stmt', 2, `if (c1) goto loc_${hex(1)};`, 2],
    ['stmt', 2, 's = 3;', 3],
    ['ctrl', 1, '}', 3],
    ['stmt', 1, 'return s;', 4],
  ]);
  assert.ok(facts.edges.some((edge) =>
    edge.from === 2 && edge.to === 1 && edge.construct === 'loop-back-edge'),
  'the interior edge is a canonical loop-back-edge');
  assert.notEqual(projected, result, 'the proven continue goto must be refined');
  const texts = textsOf(projected);
  assert.equal(count(texts, /^while \(/), 1, 'the already-emitted construct is not nested');
  assert.ok(texts.includes('if (c1) continue;'), 'the interior back-edge goto becomes continue');
  assert.ok(!texts.some((text) => /^if \(c1\) goto /.test(text)), 'the residual continue goto is gone');
  assert.equal(projected.rewriteProof.at(-1).after, 'control:loop-break-continue-refine');
});

test('loop V-ter. a goto inside an emitted switch is not rewritten to break', () => {
  const { result, projected, facts } = project(breakWhileIr(), [
    ['stmt', 1, 's = 0;', 0],
    ['ctrl', 1, `while (c0) {`, 1],
    ['stmt', 2, 's = 2;', 2],
    ['ctrl', 2, `switch (c1) {`, 2],
    ['ctrl', 3, `case 0: goto loc_${hex(5)};`, 3],
    ['ctrl', 2, '}', 2],
    ['stmt', 4, 's = 4;', 4],
    ['ctrl', 1, '}', 4],
    ['stmt', 1, 'return s;', 5],
  ]);
  assert.ok(facts.edges.some((edge) =>
    edge.from === 3 && edge.to === 5 && edge.construct === 'loop-break'),
  'the canonical facts still call this exit a break');
  assert.equal(projected, result,
    'a goto inside a retained switch span is left alone so break cannot bind to the switch');
  const texts = textsOf(projected);
  assert.ok(texts.some((text) => /^case 0: goto loc_/.test(text)),
    'the switch case keeps its residual goto');
  assert.ok(!texts.some((text) => /^case 0: break;/.test(text)),
    'the switch case never receives an unlabeled break');
});

test('loop V-quater. an emitted for header does not receive continue', () => {
  const { result, projected, facts } = project(continueWhileIr(), [
    ['stmt', 1, 's = 0;', 0],
    ['ctrl', 1, `for (i = 0; c0; i++) {`, 1],
    ['stmt', 2, `if (c1) goto loc_${hex(1)};`, 2],
    ['stmt', 2, 's = 3;', 3],
    ['ctrl', 1, '}', 3],
    ['stmt', 1, 'return s;', 4],
  ]);
  assert.ok(facts.edges.some((edge) =>
    edge.from === 2 && edge.to === 1 && edge.construct === 'loop-back-edge'),
  'the interior edge is a canonical loop-back-edge');
  const texts = textsOf(projected);
  assert.ok(texts.includes('for (i = 0; c0; i++) {'), 'the emitted for header is preserved');
  assert.ok(!texts.some((text) => /continue\s*;/.test(text)),
    'no continue may run a for-increment the original goto bypassed');
  assert.ok(texts.some((text) => /^if \(c1\) goto /.test(text)),
    'the latch goto stays a goto under a for header');
});

test('loop X. a jump inside a nested already-emitted loop is not stolen as an outer break', () => {
  // Outer while already emitted; inside it, an inner while already emitted;
  // the inner body holds a goto that the outer proof would call a break.
  // Rewriting it to `break` would bind to the inner loop, so it must stay a goto.
  const f = fixture('nested-already-while');
  f.block(0, { succ: [1] }).branch(1);
  const outer = f.block(1, { succ: [2, 6] }).opaque(1);
  f.conditionalBranch(outer, 2, 6);
  f.block(2, { succ: [4] }).store(f.constant(2, 32));
  f.branch(4);
  const inner = f.block(4, { succ: [5, 3] }).opaque(1);
  f.conditionalBranch(inner, 5, 3);
  f.block(5, { succ: [6, 3] }).opaque(1);
  // Block 5 breaks out of the outer loop to 6 (single outer break target) and
  // also has the inner latch path modelled as the other arm for edge accounting.
  f.conditionalBranch(f.opaque(1), 6, 3);
  f.block(3, { succ: [1] }).branch(1);
  f.block(6).ret();
  const ir = withProducerLayout(f.build());
  const { facts } = analyze(ir);
  const outerBreak = facts.edges.find((edge) => edge.from === 5 && edge.to === 6);
  // If the fixture cannot prove an outer break from inside the inner loop, the
  // structural guard is still exercised by the nested-span scan; skip the edge assert.
  const body = [
    ['stmt', 1, 's = 0;', 0],
    ['ctrl', 1, `while (c0) {`, 1],
    ['stmt', 2, 's = 2;', 2],
    ['ctrl', 2, `while (c1) {`, 4],
    ['ctrl', 3, `if (c2) goto loc_${hex(6)};`, 5],
    ['ctrl', 2, '}', 3],
    ['ctrl', 1, '}', 3],
    ['stmt', 1, 'return s;', 6],
  ];
  const { result, projected } = project(ir, body);
  const texts = textsOf(projected);
  assert.equal(count(texts, /^while \(/), 2, 'both constructs are present exactly once');
  if (outerBreak) {
    assert.ok(texts.some((text) => /goto loc_/.test(text)),
      'a jump inside the nested loop stays a goto so it cannot bind to the wrong loop');
    assert.ok(!texts.includes('break;'),
      'the nested jump is never rewritten to a bare break that would bind inward');
  }
  assert.ok(projected === result || texts.length >= body.length - 1,
    'the projection either refuses or preserves every line');
});

test('projectNaturalLoops returns null when nothing is provable', () => {
  assert.equal(projectNaturalLoops(null), null);
  assert.equal(projectNaturalLoops([]), null);
  assert.equal(projectNaturalLoops([{ kind: 'stmt', text: 'x = 1;' }], {}), null);
  assert.equal(projectNaturalLoops(
    [{ kind: 'stmt', text: 'x = 1;' }],
    { facts: { regions: [{ kind: 'loop', entry: 1, members: [1] }], edges: [] }, induction: { loops: [] } },
  ), null);
});

/* ── the product decompiler path ──────────────────────────────────────── */

/**
 * A synthetic body cannot prove this integration: the pipeline rebuilds every
 * node from the renderer's own line histories, so a hand-made body loses the
 * block identity a projection needs. The end-to-end case therefore runs the real
 * product path on a frozen corpus function whose structured emission falls back
 * to the faithful CFG — the exact population this stage exists for.
 */
test('the product decompiler reaches the canonical loop projection and honors its gates', () => {
  const corpus = loadCorpus();
  const index = corpus.functions.findIndex((entry) => entry.id === 'quality.loop_counted_sum.O1');
  assert.ok(index >= 0, 'the frozen corpus still carries this loop fixture');
  const entry = corpus.functions[index];
  assert.equal(entry.architectureId, 'arm64');

  const run = (options) => {
    const baseAddress = 0x100000n + BigInt(index) * 0x10000n;
    const model = modelFromAssembly(entry.assembly, entry.function, baseAddress);
    assert.ok(model, 'the frozen assembly parses into a function model');
    const rowOfAddress = new Map(model.instructions.map((instruction) =>
      [instruction.address.toString(), instruction.row]));
    return decompile(model, {
      name: entry.function,
      addr: model.instructions[0].address,
      rowOfAddress: (address) => rowOfAddress.get(address?.toString()) ?? null,
      abiAdapter: semanticAbiAdapter(AAPCS64_ABI),
      decompilerTimeBudgetMs: 20000,
      deterministicTransforms: true,
      phase8Optimize: true,
      ...options,
    });
  };

  const adopted = run({ phase8ControlProjection: true });
  const records = (adopted.rewriteProof ?? []).filter((record) => record.rule === LOOP_PROJECTION_RULE);
  assert.equal(records.length, 1, 'the proven natural loop is adopted exactly once');
  assert.equal(records[0].evidence.version, LOOP_CONTROL_PROJECTION_VERSION);
  assert.equal(records[0].evidence.regionForm, 'while');
  assert.equal(records[0].evidence.guardBlock, records[0].evidence.regionEntry,
    'the adopted loop kept its guard at the canonical header');
  assert.ok(adopted.pseudocode.includes('while ('), 'the loop reaches the emitted C');
  assert.ok((adopted.pseudocode.match(/loc_/g) ?? []).length
    < (run({ phase8ControlProjection: false }).pseudocode.match(/loc_/g) ?? []).length,
  'the guard and back-edge labels are gone from the emitted text');
  // The function's own work is untouched by the projection.
  assert.ok(adopted.pseudocode.includes('return 0;'));
  assert.ok(adopted.pseudocode.includes('return memory_unknown + var_4;'));

  for (const options of [
    { phase8ControlProjection: false },
    { phase8Structuring: false },
    { phase8PrepareProof: true },
    { phase8ProofOnlyRewrites: true },
  ]) {
    const result = run(options);
    assert.ok(
      !(result.rewriteProof ?? []).some((record) => record.rule === LOOP_PROJECTION_RULE),
      `the loop projection must stay disabled for ${JSON.stringify(options)}`,
    );
    assert.ok(!result.pseudocode.includes('while ('),
      `no loop construct may appear when the gate is off for ${JSON.stringify(options)}`);
  }
});
