import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceOf } from '../../../js/decompiler/ast/nodes.js';
import { PASS_STAGES } from '../../../js/decompiler/phase8/contract.js';
import {
  applyStructuredControlProjection,
  readStructuredControlProjection,
  STRUCTURED_CONTROL_PROJECTION_VERSION,
  isAdoptableConditionalRegion,
  edgeAccountingFailures,
  runPhase8Stage,
} from '../../../js/decompiler/phase8/index.js';
import {
  readSemanticControlLineHistory,
  registerSemanticControlLineHistory,
} from '../../../js/decompiler/semantic-core.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

function analyze(ir) {
  const { ledger, analysis } = runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs: 5000 });
  assert.equal(ledger.published, true, 'acceptance requires a published Phase 8 ledger');
  const facts = analysis.get('structuredRegions');
  assert.ok(facts, 'acceptance requires structured-region facts');
  assert.equal(facts.completeness, 'complete');
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);
  return { ledger, analysis, facts };
}

function makeLine(kind, indent, text, block, row, addr) {
  const node = {
    kind,
    indent,
    text,
    row,
    block,
    addr: BigInt(addr),
    source: sourceOf({ row, address: BigInt(addr), ir: [`inst_${row}`] }),
    semantic: { op: kind === 'ctrl' ? 'control-render' : 'statement', block, ir: `inst_${row}` },
  };
  return node;
}

function withArm64ProducerLayout(ir, baseAddress = 0x1000n) {
  const instructions = [];
  for (const block of ir.blocks ?? []) {
    const row = block.index;
    block.startRow = row;
    block.endRow = row;
    delete block.address;
    for (const instruction of block.insts ?? []) {
      instruction.row = row;
      instruction.address = baseAddress + BigInt(row) * 4n;
      instructions.push(instruction);
    }
  }
  ir.instructions = instructions;
  return ir;
}

function diamondIr() {
  const f = fixture('diamond');
  const cond = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(cond, 1, 2);
  f.block(1, { succ: [3] }).store(f.constant(42, 32));
  f.branch(3);
  f.block(2, { succ: [3] }).store(f.constant(99, 32));
  f.branch(3);
  f.block(3).ret();
  return withArm64ProducerLayout(f.build());
}

function oneSidedIr() {
  const f = fixture('one-sided');
  const cond = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(cond, 1, 2);
  f.block(1, { succ: [2] }).store(f.constant(100, 32));
  f.branch(2);
  f.block(2).ret();
  return withArm64ProducerLayout(f.build());
}

function nestedIr() {
  const f = fixture('nested');
  // Block 0: if c0 goto 1 else 4
  const c0 = f.block(0, { succ: [1, 4] }).opaque(1);
  f.conditionalBranch(c0, 1, 4);
  // Block 1: if c1 goto 2 else 3
  const c1 = f.block(1, { succ: [2, 3] }).opaque(1);
  f.conditionalBranch(c1, 2, 3);
  // Block 2: arm inner-true -> 3
  f.block(2, { succ: [3] }).store(f.constant(222, 32));
  f.branch(3);
  // Block 3: inner join -> 5
  f.block(3, { succ: [5] }).store(f.constant(333, 32));
  f.branch(5);
  // Block 4: outer else arm -> 5
  f.block(4, { succ: [5] }).store(f.constant(444, 32));
  f.branch(5);
  // Block 5: outer join
  f.block(5).ret();
  return withArm64ProducerLayout(f.build());
}

function irreducibleIr() {
  const f = fixture('irreducible');
  const pick = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(pick, 1, 2);
  f.block(1, { succ: [2] }).branch(2);
  f.block(2, { succ: [1, 3] });
  f.conditionalBranch(f.opaque(1), 1, 3);
  f.block(3).ret();
  return withArm64ProducerLayout(f.build({ loops: [{ header: 1, latches: new Set([2]), nodes: new Set([1, 2]), exits: new Set([3]) }] }));
}

function unwindIr() {
  const f = fixture('unwind');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3, 4], edges: [{ to: 3, kind: 'branch' }, { to: 4, kind: 'unwind' }] });
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  f.block(4).ret();
  return withArm64ProducerLayout(f.build());
}

function switchFallthroughIr() {
  const f = fixture('switch-fallthrough');
  const selector = f.block(0, { succ: [1, 2, 3] }).opaque(32);
  f.switchBranch(selector, [[0, 1], [1, 2]], 3);
  f.block(1, { succ: [2], edges: [{ to: 2, kind: 'fallthrough' }] }).branch(2);
  f.block(2, { succ: [4] }).branch(4);
  f.block(3, { succ: [4] }).branch(4);
  f.block(4).ret();
  return withArm64ProducerLayout(f.build());
}

function flattenedDispatcherIr() {
  const f = fixture('flattened-dispatcher');
  f.block(0, { succ: [1] }).branch(1);
  const selector = f.block(1, { succ: [2, 3, 4] }).opaque(32);
  f.switchBranch(selector, [[0, 2], [1, 3]], 4);
  f.block(2, { succ: [1] }).branch(1);
  f.block(3, { succ: [1] }).branch(1);
  f.block(4).ret();
  return withArm64ProducerLayout(f.build());
}

// 1. Reducible if/else diamond
test('1. reducible if/else diamond emits structured if/else and preserves semantics', () => {
  const ir = diamondIr();
  assert.equal(Object.prototype.hasOwnProperty.call(ir.blocks[0], 'address'), false,
    'real ARM64 blocks expose rows, not a synthetic block.address');
  assert.equal(ir.instructions.find(i => i.row === ir.blocks[3].startRow)?.address, 0x100Cn);
  const { analysis } = analyze(ir);

  const body = [
    makeLine('ctrl', 1, 'if (c0) goto loc_1004;', 0, 0, 0x1000),
    makeLine('stmt', 1, 'goto loc_1008;', 0, 1, 0x1002),
    makeLine('label', 0, 'loc_1004:', 1, 2, 0x1004),
    makeLine('stmt', 1, 'x = 42;', 1, 3, 0x1004),
    makeLine('stmt', 1, 'goto loc_100C;', 1, 4, 0x1006),
    makeLine('label', 0, 'loc_1008:', 2, 5, 0x1008),
    makeLine('stmt', 1, 'x = 99;', 2, 6, 0x1008),
    makeLine('stmt', 1, 'goto loc_100C;', 2, 7, 0x100a),
    makeLine('label', 0, 'loc_100C:', 3, 8, 0x100c),
    makeLine('stmt', 1, 'return x;', 3, 9, 0x100c),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: '',
    rewriteProof: [],
    metrics: {},
  };

  const projected = applyStructuredControlProjection(result, analysis);

  assert.notEqual(projected.cAst, result.cAst, 'cAst must be transformed');
  assert.ok(projected.pseudocode.includes('if (c0) {'), 'should contain structured if header');
  assert.ok(projected.pseudocode.includes('} else {'), 'should contain structured else');
  assert.ok(projected.pseudocode.includes('x = 42;'), 'should contain if arm statement');
  assert.ok(projected.pseudocode.includes('x = 99;'), 'should contain else arm statement');
  assert.ok(projected.pseudocode.includes('return x;'), 'should contain join return');
  assert.ok(!projected.pseudocode.includes('goto loc_'), 'internal gotos eliminated');
  assert.ok(!projected.pseudocode.includes('loc_1004:'), 'internal labels eliminated');
  assert.ok(!projected.pseudocode.includes('loc_1008:'), 'internal labels eliminated');
});

// 2. One-sided conditional
test('2. one-sided conditional emits if without else and does not absorb join', () => {
  const ir = oneSidedIr();
  const { analysis } = analyze(ir);

  const body = [
    makeLine('ctrl', 1, 'if (c0) goto loc_1004;', 0, 0, 0x1000),
    makeLine('stmt', 1, 'goto loc_1008;', 0, 1, 0x1002),
    makeLine('label', 0, 'loc_1004:', 1, 2, 0x1004),
    makeLine('stmt', 1, 'x = 100;', 1, 3, 0x1004),
    makeLine('stmt', 1, 'goto loc_1008;', 1, 4, 0x1006),
    makeLine('label', 0, 'loc_1008:', 2, 5, 0x1008),
    makeLine('stmt', 1, 'return x;', 2, 6, 0x1008),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: '',
    rewriteProof: [],
    metrics: {},
  };

  const projected = applyStructuredControlProjection(result, analysis);

  assert.notEqual(projected.cAst, result.cAst);
  assert.ok(projected.pseudocode.includes('if (c0) {'));
  assert.ok(!projected.pseudocode.includes('else'), 'must not emit empty else branch');
  assert.ok(projected.pseudocode.includes('x = 100;'));
  assert.ok(projected.pseudocode.includes('return x;'));
  assert.ok(!projected.pseudocode.includes('goto loc_1008;'));
});

// 3. Nested reducible conditional
test('3. nested reducible conditional maintains distinct inner and outer joins', () => {
  const ir = nestedIr();
  const { analysis } = analyze(ir);

  const body = [
    makeLine('ctrl', 1, 'if (c0) goto loc_1004;', 0, 0, 0x1000),
    makeLine('stmt', 1, 'goto loc_1010;', 0, 1, 0x1002),
    makeLine('label', 0, 'loc_1004:', 1, 2, 0x1004),
    makeLine('ctrl', 1, 'if (c1) goto loc_1008;', 1, 3, 0x1004),
    makeLine('stmt', 1, 'goto loc_100C;', 1, 4, 0x1006),
    makeLine('label', 0, 'loc_1008:', 2, 5, 0x1008),
    makeLine('stmt', 1, 's2 = 222;', 2, 6, 0x1008),
    makeLine('stmt', 1, 'goto loc_100C;', 2, 7, 0x100a),
    makeLine('label', 0, 'loc_100C:', 3, 8, 0x100c),
    makeLine('stmt', 1, 's3 = 333;', 3, 9, 0x100c),
    makeLine('stmt', 1, 'goto loc_1014;', 3, 10, 0x100e),
    makeLine('label', 0, 'loc_1010:', 4, 11, 0x1010),
    makeLine('stmt', 1, 's4 = 444;', 4, 12, 0x1010),
    makeLine('stmt', 1, 'goto loc_1014;', 4, 13, 0x1012),
    makeLine('label', 0, 'loc_1014:', 5, 14, 0x1014),
    makeLine('stmt', 1, 'return s;', 5, 15, 0x1014),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: '',
    rewriteProof: [],
    metrics: {},
  };

  const projected = applyStructuredControlProjection(result, analysis);

  assert.notEqual(projected.cAst, result.cAst);
  assert.ok(projected.pseudocode.includes('s2 = 222;'));
  assert.ok(projected.pseudocode.includes('s3 = 333;'));
  assert.ok(projected.pseudocode.includes('s4 = 444;'));
  assert.ok(projected.pseudocode.includes('return s;'));
  const meta = readStructuredControlProjection(projected);
  assert.ok(meta);
  assert.ok(meta.adoptedRegions.length >= 1);
});

// 4. Observable operations count and order
test('4. observable operations count and relative order are exactly preserved', () => {
  const ir = diamondIr();
  const { analysis } = analyze(ir);

  const body = [
    makeLine('ctrl', 1, 'if (c0) goto loc_1004;', 0, 0, 0x1000),
    makeLine('stmt', 1, 'goto loc_1008;', 0, 1, 0x1002),
    makeLine('label', 0, 'loc_1004:', 1, 2, 0x1004),
    makeLine('stmt', 1, 'store1();', 1, 3, 0x1004),
    makeLine('stmt', 1, 'call1();', 1, 4, 0x1005),
    makeLine('stmt', 1, 'goto loc_100C;', 1, 5, 0x1006),
    makeLine('label', 0, 'loc_1008:', 2, 6, 0x1008),
    makeLine('stmt', 1, 'store2();', 2, 7, 0x1008),
    makeLine('stmt', 1, 'call2();', 2, 8, 0x1009),
    makeLine('stmt', 1, 'goto loc_100C;', 2, 9, 0x100a),
    makeLine('label', 0, 'loc_100C:', 3, 10, 0x100c),
    makeLine('stmt', 1, 'return 0;', 3, 11, 0x100c),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: '',
    rewriteProof: [],
    metrics: {},
  };

  const projected = applyStructuredControlProjection(result, analysis);

  const texts = projected.cAst.body.map(n => n.text);
  const s1Idx = texts.indexOf('store1();');
  const c1Idx = texts.indexOf('call1();');
  const s2Idx = texts.indexOf('store2();');
  const c2Idx = texts.indexOf('call2();');
  const retIdx = texts.indexOf('return 0;');

  assert.ok(s1Idx >= 0 && c1Idx > s1Idx, 'arm 1 operations preserved in exact order');
  assert.ok(s2Idx >= 0 && c2Idx > s2Idx, 'arm 2 operations preserved in exact order');
  assert.ok(retIdx > c2Idx, 'continuation preserved after both arms');
});

// 5. Irreducible CFG falls back to original output
test('5. irreducible CFG falls back cleanly to unmodified output', () => {
  const ir = irreducibleIr();
  const { analysis } = analyze(ir);

  const body = [
    makeLine('ctrl', 1, 'if (c0) goto loc_1004;', 0, 0, 0x1000),
    makeLine('stmt', 1, 'goto loc_1008;', 0, 1, 0x1002),
    makeLine('label', 0, 'loc_1004:', 1, 2, 0x1004),
    makeLine('stmt', 1, 'goto loc_1008;', 1, 3, 0x1004),
    makeLine('label', 0, 'loc_1008:', 2, 4, 0x1008),
    makeLine('ctrl', 1, 'if (c1) goto loc_1004;', 2, 5, 0x1008),
    makeLine('stmt', 1, 'goto loc_100C;', 2, 6, 0x100a),
    makeLine('label', 0, 'loc_100C:', 3, 7, 0x100c),
    makeLine('stmt', 1, 'return;', 3, 8, 0x100c),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: 'fallback',
    rewriteProof: [],
    metrics: {},
  };

  const projected = applyStructuredControlProjection(result, analysis);

  assert.equal(projected, result, 'irreducible CFG must return unchanged result');
  assert.equal(projected.cAst, result.cAst);
});

// 6. Exception / unwind edge is not swallowed
test('6. exception/unwind edge is not swallowed as a branch', () => {
  const ir = unwindIr();
  const { analysis } = analyze(ir);

  const body = [
    makeLine('ctrl', 1, 'if (c0) goto loc_1004;', 0, 0, 0x1000),
    makeLine('stmt', 1, 'goto loc_1008;', 0, 1, 0x1002),
    makeLine('label', 0, 'loc_1004:', 1, 2, 0x1004),
    makeLine('stmt', 1, 'unwind_step();', 1, 3, 0x1004),
    makeLine('label', 0, 'loc_1008:', 2, 4, 0x1008),
    makeLine('stmt', 1, 'normal_step();', 2, 5, 0x1008),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: 'unwind',
    rewriteProof: [],
    metrics: {},
  };

  const projected = applyStructuredControlProjection(result, analysis);

  assert.equal(projected, result, 'unwind region must not be transformed');
});

// 7. Flattened dispatcher / residual jumps preserved
test('7. flattened dispatcher preserves residual jumps', () => {
  const ir = flattenedDispatcherIr();
  const { analysis } = analyze(ir);

  const body = [
    makeLine('stmt', 1, 'goto loc_1004;', 0, 0, 0x1000),
    makeLine('label', 0, 'loc_1004:', 1, 1, 0x1004),
    makeLine('stmt', 1, 'switch (state) { case 0: goto loc_1008; case 1: goto loc_100C; default: goto loc_1010; }', 1, 2, 0x1004),
    makeLine('label', 0, 'loc_1008:', 2, 3, 0x1008),
    makeLine('stmt', 1, 'goto loc_1004;', 2, 4, 0x1008),
    makeLine('label', 0, 'loc_100C:', 3, 5, 0x100c),
    makeLine('stmt', 1, 'goto loc_1004;', 3, 6, 0x100c),
    makeLine('label', 0, 'loc_1010:', 4, 7, 0x1010),
    makeLine('stmt', 1, 'return;', 4, 8, 0x1010),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: 'dispatcher',
    rewriteProof: [],
    metrics: {},
  };

  const projected = applyStructuredControlProjection(result, analysis);

  assert.equal(projected, result, 'dispatcher residual jumps must not be mangled');
});

// 8. Switch fallthrough remains intact
test('8. switch fallthrough semantics remain intact without bogus breaks', () => {
  const ir = switchFallthroughIr();
  const { analysis } = analyze(ir);

  const body = [
    makeLine('stmt', 1, 'switch (sel) {', 0, 0, 0x1000),
    makeLine('stmt', 2, 'case 0: goto loc_1004;', 0, 1, 0x1000),
    makeLine('stmt', 2, 'case 1: goto loc_1008;', 0, 2, 0x1000),
    makeLine('stmt', 1, '}', 0, 3, 0x1000),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: 'switch',
    rewriteProof: [],
    metrics: {},
  };

  const projected = applyStructuredControlProjection(result, analysis);

  assert.equal(projected, result, 'switch fallthrough remains intact');
});

// 9. Stale artifact rejects adoption
test('9. stale artifact identity mismatch rejects adoption', () => {
  const ir = diamondIr();
  const { analysis } = analyze(ir);

  const body = [
    makeLine('ctrl', 1, 'if (c0) goto loc_1004;', 0, 0, 0x1000),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: '',
    rewriteProof: [],
    metrics: {},
  };

  // Provide a mismatching analysisIdentity
  const projected = applyStructuredControlProjection(result, analysis, {
    analysisIdentity: { identity: 'mismatched-stale-token' },
  });

  assert.equal(projected, result, 'stale analysis identity must reject adoption');
});

// 10. Partial / budget / cancellation retains original output
test('10. cancelled / budget-exhausted fact retains original output', () => {
  const ir = diamondIr();
  const { analysis } = analyze(ir);

  const body = [
    makeLine('ctrl', 1, 'if (c0) goto loc_1004;', 0, 0, 0x1000),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: '',
    rewriteProof: [],
    metrics: {},
  };

  const aborted = applyStructuredControlProjection(result, analysis, {
    shouldAbort: () => true,
  });

  assert.equal(aborted, result, 'aborted projector must return original result');
});

// 11. Edge-accounting mutation corruption rejects adoption
test('11. edge-accounting corruption rejects adoption', () => {
  const ir = diamondIr();
  const { analysis } = analyze(ir);

  // Corrupt facts by modifying edge
  const rawFacts = analysis.get('structuredRegions');
  const corruptedFacts = {
    ...rawFacts,
    edges: rawFacts.edges.slice(0, 1), // Lose edges
  };

  const corruptedAnalysis = {
    get(key) {
      if (key === 'structuredRegions') return corruptedFacts;
      return analysis.get(key);
    },
  };

  const body = [
    makeLine('ctrl', 1, 'if (c0) goto loc_1004;', 0, 0, 0x1000),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: '',
    rewriteProof: [],
    metrics: {},
  };

  const rejected = applyStructuredControlProjection(result, corruptedAnalysis);
  assert.equal(rejected, result, 'corrupted edge accounting must reject adoption');
});

// 12. Unknown branch polarity must fail closed
test('12. successor order is never used as branch polarity evidence', () => {
  const ir = diamondIr();
  const { analysis } = analyze(ir);

  const entry = ir.blocks[0];
  delete entry.successorEdges;
  const term = entry.insts.find(i => i.op === 'cbr');
  assert.ok(term);
  if (term.extra) {
    delete term.extra.targetBlock;
    delete term.extra.target;
  }

  // Deliberately choose an order that would invert semantics if interpreted as
  // [true, false]. The projector must leave the legacy rendering untouched.
  entry.succ = [2, 1];

  const body = [
    makeLine('ctrl', 1, 'if (c0) goto loc_1004;', 0, 0, 0x1000),
    makeLine('stmt', 1, 'goto loc_1008;', 0, 1, 0x1002),
    makeLine('label', 0, 'loc_1004:', 1, 2, 0x1004),
    makeLine('stmt', 1, 'x = 42;', 1, 3, 0x1004),
    makeLine('stmt', 1, 'goto loc_100C;', 1, 4, 0x1006),
    makeLine('label', 0, 'loc_1008:', 2, 5, 0x1008),
    makeLine('stmt', 1, 'x = 99;', 2, 6, 0x1008),
    makeLine('stmt', 1, 'goto loc_100C;', 2, 7, 0x100a),
    makeLine('label', 0, 'loc_100C:', 3, 8, 0x100c),
    makeLine('stmt', 1, 'return x;', 3, 9, 0x100c),
  ];
  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: 'legacy-polarity',
    rewriteProof: [],
    metrics: {},
  };

  const projected = applyStructuredControlProjection(result, analysis);
  assert.equal(projected, result, 'unknown branch polarity must preserve the original result');
  assert.equal(projected.pseudocode, 'legacy-polarity');
});

// 13. Provenance and metadata
test('13. provenance, line histories, and render metadata are correctly populated', () => {
  const ir = diamondIr();
  const { analysis } = analyze(ir);

  const body = [
    makeLine('ctrl', 1, 'if (c0) goto loc_1004;', 0, 0, 0x1000),
    makeLine('stmt', 1, 'goto loc_1008;', 0, 1, 0x1002),
    makeLine('label', 0, 'loc_1004:', 1, 2, 0x1004),
    makeLine('stmt', 1, 'x = 42;', 1, 3, 0x1004),
    makeLine('stmt', 1, 'goto loc_100C;', 1, 4, 0x1006),
    makeLine('label', 0, 'loc_1008:', 2, 5, 0x1008),
    makeLine('stmt', 1, 'x = 99;', 2, 6, 0x1008),
    makeLine('stmt', 1, 'goto loc_100C;', 2, 7, 0x100a),
    makeLine('label', 0, 'loc_100C:', 3, 8, 0x100c),
    makeLine('stmt', 1, 'return x;', 3, 9, 0x100c),
  ];

  const result = {
    ir,
    types: {},
    cAst: { kind: 'CProgram', body, source: sourceOf() },
    lines: body,
    pseudocode: '',
    rewriteProof: [],
    metrics: {},
  };

  const projected = applyStructuredControlProjection(result, analysis, { renderProvenance: true });

  assert.notEqual(projected.cAst, result.cAst);

  // 1. Metadata via readStructuredControlProjection
  const meta = readStructuredControlProjection(projected);
  assert.ok(meta, 'structured control projection metadata must exist');
  assert.equal(
    Object.prototype.hasOwnProperty.call(projected, 'structuredControlProjection'),
    false,
    'observer-bearing projection metadata must stay behind the public result boundary',
  );
  assert.equal(meta.version, STRUCTURED_CONTROL_PROJECTION_VERSION);
  assert.equal(meta.completeness, 'complete');
  assert.equal(meta.ir, ir);
  assert.ok(meta.adoptedRegions.length >= 1);
  assert.ok(meta.records.length >= 1);
  assert.equal(meta.records[0].rule, 'project-canonical-structured-conditional');

  // 2. Line histories
  const headerNode = projected.cAst.body.find(n => n.text?.startsWith('if ('));
  assert.ok(headerNode, 'header node must exist');
  const headerHistory = readSemanticControlLineHistory(headerNode, ir);
  assert.ok(headerHistory, 'header node must have semantic control line history');
  assert.equal(headerHistory.selection.header, 0);

  // 3. Rewrite proof
  assert.ok(projected.rewriteProof.some(r => r.rule === 'project-canonical-structured-conditional'));

  // 4. SourceMap
  assert.ok(Array.isArray(projected.sourceMap));
  assert.equal(projected.sourceMap.length, projected.lines.length);

  // 5. Render provenance
  assert.ok(projected.renderProvenance, 'renderProvenance must be built when requested');
});
