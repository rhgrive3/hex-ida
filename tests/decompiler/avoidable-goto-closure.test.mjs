import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { eliminateAvoidableGotos } from '../../js/decompiler/goto-closure.js';
import { registerSemanticControlLineHistory } from '../../js/decompiler/semantic-core.js';

/*
 * The avoidable-goto closure runs on the finished rendered line array, so these
 * cases are the exact line arrays the renderer produces: the indentation lives
 * in the `indent` field (the printers turn it into leading whitespace) and the
 * text never carries it.  Every expected value here was observed on the module
 * before it was asserted, and every case keeps the two invariants that make the
 * rendered C addressable at all: no jump without its label, no unbalanced brace.
 */

const line = (kind, indent, text) => ({ kind, indent, text, row: null, addr: null, note: null });
const stmt = (indent, text) => line('stmt', indent, text);
const ctrl = (indent, text) => line('ctrl', indent, text);
const label = (indent, name) => line('label', indent, `${name}:`);

const render = (lines) => lines.map((item) => `${'    '.repeat(Math.max(0, item.indent || 0))}${item.text}`);

function closeGotos(lines, options = {}) {
  const result = {
    semantic: true,
    ir: options.ir || { instructions: [], values: [], blocks: [] },
    lines,
    warnings: options.warnings || [],
    ...(options.labels ? { labels: options.labels } : {}),
    ...(options.renderProvenance ? { renderProvenance: options.renderProvenance } : {}),
  };
  return { result, output: eliminateAvoidableGotos(result, {}) };
}

function stripNonCode(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Every jump in the text names a label the text still defines, and braces balance. */
function assertJumpsResolveAndBracesBalance(output) {
  const texts = output.lines.map((item) => item.text);
  const defined = new Set();
  for (const text of texts) {
    const match = /^\s*(loc_[0-9a-fA-F]+)\s*:\s*$/.exec(text);
    if (match) defined.add(match[1].toLowerCase());
  }
  const jump = /\bgoto\s+(loc_[0-9a-fA-F]+)\s*;/g;
  for (const text of texts) {
    jump.lastIndex = 0;
    let match;
    while ((match = jump.exec(text)) !== null) {
      assert.ok(defined.has(match[1].toLowerCase()),
        `jump target ${match[1]} has no label line in:\n${render(output.lines).join('\n')}`);
    }
  }
  let depth = 0;
  for (const text of texts) {
    for (const character of stripNonCode(text)) {
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        assert.ok(depth >= 0, `unbalanced closing brace in:\n${render(output.lines).join('\n')}`);
      }
    }
  }
  assert.equal(depth, 0, `unbalanced output:\n${render(output.lines).join('\n')}`);
}

function clangSyntaxOk(source) {
  const out = spawnSync('/usr/bin/clang', ['-target', 'aarch64-linux-gnu', '-fsyntax-only', '-w', '-x', 'c', '-'],
    { input: source, encoding: 'utf8', timeout: 30000 });
  return { ok: out.status === 0, stderr: String(out.stderr ?? '') };
}

test('a jump to the next statement is dropped with its label and its stale edge warning', () => {
  const { result, output } = closeGotos(
    [stmt(1, 'goto loc_10;'), label(1, 'loc_10')],
    {
      labels: new Set(['loc_10']),
      warnings: ['1 control-flow edge(s) remain explicit because a safe source structure was not proven.'],
    },
  );
  assert.deepEqual(render(output.lines), []);
  assert.equal(output.pseudocode, '');
  assert.deepEqual([...output.labels], []);
  assert.deepEqual(output.warnings, [], 'the warning may not keep claiming an edge that is gone');
  assert.notEqual(output, result);
  assertJumpsResolveAndBracesBalance(output);
});

test('a fallthrough jump over comments and blank lines is still a fallthrough', () => {
  const { output } = closeGotos([
    stmt(1, 'goto loc_10;'), line('raw', 0, ''), line('raw', 1, '/* note */'), label(1, 'loc_10'),
  ]);
  assert.deepEqual(render(output.lines).map((text) => text.trim()), ['', '/* note */']);
  assertJumpsResolveAndBracesBalance(output);
});

test('a jump over real statements keeps its goto and label', () => {
  const { result, output } = closeGotos([stmt(1, 'goto loc_10;'), stmt(1, 'a1 = 1;'), label(1, 'loc_10')]);
  assert.equal(output, result, 'nothing is provable here, so the result must pass through untouched');
});

test('a jump that leaves a loop keeps its goto: the fallthrough re-tests the loop', () => {
  const { result, output } = closeGotos([
    ctrl(1, 'while (a1 != 0) {'), stmt(2, 'goto loc_10;'), ctrl(1, '}'), label(1, 'loc_10'),
  ]);
  assert.equal(output, result);
});

test('a jump inside an if body to the label after the if is dropped with the orphan label', () => {
  const { output } = closeGotos([
    ctrl(1, 'if (a1 != 0) {'), stmt(2, 'goto loc_10;'), ctrl(1, '}'), label(1, 'loc_10'),
  ]);
  assert.deepEqual(render(output.lines), ['    if (a1 != 0) {', '    }']);
  assertJumpsResolveAndBracesBalance(output);
});

test('a conditional skip over one balanced region becomes a guarded block at the jump indentation', () => {
  const { output } = closeGotos([
    ctrl(1, 'if (a1 != 0) goto loc_20;'), stmt(1, 'a2 = 1;'), label(1, 'loc_20'), stmt(1, 'a3 = 2;'),
  ]);
  assert.deepEqual(render(output.lines), [
    '    if (!(a1 != 0)) {',
    '        a2 = 1;',
    '    }',
    '    a3 = 2;',
  ]);
  assert.equal(output.pseudocode, render(output.lines).join('\n'), 'pseudocode must describe the emitted lines');
  assertJumpsResolveAndBracesBalance(output);
});

test('the guarded block is refused when the region is not a balanced scope of the jump', () => {
  const cases = {
    'case entry inside the region': [
      ctrl(1, 'if (a1 != 0) goto loc_20;'), ctrl(2, 'case 3:'), stmt(1, 'a2 = 1;'), label(1, 'loc_20'),
    ],
    'label inside a nested block': [
      ctrl(1, 'if (a1 != 0) goto loc_20;'), ctrl(1, 'if (a2 != 0) {'), stmt(2, 'a3 = 1;'), label(2, 'loc_20'), ctrl(1, '}'),
    ],
    'jump out of an if/else': [
      ctrl(1, 'if (b1 != 0) {'), ctrl(2, 'if (a1 != 0) goto loc_20;'), stmt(2, 'a2 = 1;'),
      ctrl(1, '} else {'), stmt(2, 'a3 = 2;'), ctrl(1, '}'), label(1, 'loc_20'),
    ],
  };
  for (const [name, lines] of Object.entries(cases)) {
    const { result, output } = closeGotos(lines);
    assert.equal(output, result, `${name}: the rewrite is not provable and must not happen`);
    assertJumpsResolveAndBracesBalance(output);
  }
});

test('a two-sided region pair sharing one join becomes if/else with the same evaluation order', () => {
  const { output } = closeGotos([
    ctrl(1, 'if (a1 != 0) goto loc_30;'), stmt(1, 'a2 = 1;'), stmt(1, 'goto loc_40;'),
    label(1, 'loc_30'), stmt(1, 'a3 = 2;'), label(1, 'loc_40'), stmt(1, 'a4 = 3;'),
  ]);
  assert.deepEqual(render(output.lines), [
    '    if (a1 != 0) {',
    '        a3 = 2;',
    '    } else {',
    '        a2 = 1;',
    '    }',
    '    a4 = 3;',
  ]);
  assertJumpsResolveAndBracesBalance(output);
});

test('an if/else pair keeps both labels alive when anything else addresses them', () => {
  const { output } = closeGotos([
    ctrl(1, 'if (a1 != 0) goto loc_30;'), stmt(1, 'a2 = 1;'), stmt(1, 'goto loc_40;'),
    label(1, 'loc_30'), stmt(1, 'a3 = 2;'), label(1, 'loc_40'),
    ctrl(1, 'if (a5 != 0) goto loc_40;'), stmt(1, 'a4 = 3;'),
  ]);
  assert.deepEqual(render(output.lines), [
    '    if (!(a1 != 0)) {',
    '        a2 = 1;',
    '        goto loc_40;',
    '    }',
    '    a3 = 2;',
    '    loc_40:',
    '    if (a5 != 0) goto loc_40;',
    '    a4 = 3;',
  ]);
  assertJumpsResolveAndBracesBalance(output);
});

test('a fallthrough jump is kept when dropping it would leave its label without a statement', () => {
  // Every rule below is textual, so a rewrite the text cannot state must be
  // refused: `if (...) { loc_10: goto loc_20; }` may not lose the jump, because
  // the label would then be the last thing before `}` and that is not C.  The
  // label is targeted from elsewhere, so it cannot be dropped either.
  const { result, output } = closeGotos([
    ctrl(1, 'if (a1 != 0) {'), label(2, 'loc_10'), stmt(2, 'goto loc_20;'), ctrl(1, '}'),
    label(1, 'loc_20'), stmt(1, 'a1 = 1;'), stmt(1, 'if (a2 != 0) goto loc_10;'),
  ]);
  assert.equal(output, result, 'the jump is the only statement that label has');
  assertJumpsResolveAndBracesBalance(output);
});

test('a guarded region that ends on a label is not wrappable', () => {
  // Wrapping the region would close the new block right after `loc_30:`,
  // publishing a label with no statement.  loc_30 is targeted from elsewhere,
  // so the label must stay and the conditional jump stays honest with it.
  const { result, output } = closeGotos([
    ctrl(1, 'if (a1 != 0) goto loc_20;'), stmt(1, 'a2 = 1;'), label(1, 'loc_30'), label(1, 'loc_20'),
    stmt(1, 'a3 = 2;'), stmt(1, 'goto loc_30;'),
  ]);
  assert.equal(output, result);
  assertJumpsResolveAndBracesBalance(output);
});

test('text that already leaves a label without a statement is never rewritten', () => {
  // The producer's own defect is out of this closure's scope: building a
  // rewrite on top of text that is already not C would only hide where it came
  // from.  The line array passes through untouched.
  const { result, output } = closeGotos([
    ctrl(1, 'if (a1 != 0) {'), label(2, 'loc_10'), ctrl(1, '}'), stmt(1, 'a1 = 1;'),
    stmt(1, 'goto loc_10;'),
  ]);
  assert.equal(output, result);
});

test('a case dispatch jump is never read as a fallthrough', () => {
  const { result, output } = closeGotos([
    ctrl(1, 'switch (x0) {'), ctrl(2, 'case 1: goto loc_10;'), ctrl(1, '}'), label(1, 'loc_10'), stmt(1, 'a1 = 1;'),
  ]);
  assert.equal(output, result);
});

test('a no-op conditional branch is removed only for a proven fault-free, observation-free condition', () => {
  const registerIr = { instructions: [], values: [], blocks: [] };
  const registerValue = { id: 2, reg: 'x0', def: null };
  const registerBranch = { id: 3, op: 'cbr', kind: 'cbnz', args: [{ value: registerValue, bits: 64 }], dst: null };
  registerIr.instructions = [registerBranch];
  const registerLine = ctrl(1, 'if (x0 != 0) goto loc_20;');
  registerSemanticControlLineHistory(registerLine, {
    ir: registerIr, instruction: registerBranch, canonical: { isCurrent: () => true }, records: [], isCurrent: () => true,
  });
  const { output } = closeGotos([registerLine, label(1, 'loc_20')], { ir: registerIr });
  assert.deepEqual(render(output.lines), [], 'a register test cannot be observed, so the branch is dead');

  const unprovable = [
    ['a load can fault', { op: 'load', args: [], addr: {} }],
    ['a call can be observed', { op: 'call', args: [] }],
    ['a division can trap', { op: 'bin', sub: 'sdiv', args: [] }],
    ['an unresolved operation is not proven pure', { op: 'unknown', args: [] }],
  ];
  for (const [name, def] of unprovable) {
    const ir = { instructions: [], values: [], blocks: [] };
    const value = { id: 4, def: { id: 5, ...def } };
    const branch = { id: 6, op: 'cbr', kind: 'cbnz', args: [{ value, bits: 32 }], dst: null };
    ir.instructions = [branch];
    const branchLine = ctrl(1, 'if (value_5 != 0) goto loc_20;');
    registerSemanticControlLineHistory(branchLine, {
      ir, instruction: branch, canonical: { isCurrent: () => true }, records: [], isCurrent: () => true,
    });
    const kept = closeGotos([branchLine, label(1, 'loc_20')], { ir });
    assert.equal(kept.output, kept.result, `${name}: the branch must stay`);
  }

  const orphaned = closeGotos([ctrl(1, 'if (x0 != 0) goto loc_20;'), label(1, 'loc_20')]);
  assert.equal(orphaned.output, orphaned.result, 'no control-line history means no purity proof');
});

test('a published render-provenance map blocks the rewrite instead of going stale', () => {
  const { result, output } = closeGotos(
    [stmt(1, 'goto loc_10;'), label(1, 'loc_10')],
    { renderProvenance: { completeness: 'complete' } },
  );
  assert.equal(output, result);
});

test('the public C output boundary runs the closure and owns the provenance refresh', async () => {
  // The production entry point publishes results that already carry an
  // index-keyed provenance map, so the boundary is what supplies the refresh
  // hook.  This pins that wiring: the jump goes away there, while the same
  // result handed to the closure directly (no hook) is left alone.
  const { closePublicCOutputForTesting } = await import('../../js/decompile-base.js');
  const build = () => ({
    semantic: true,
    ir: { instructions: [], values: [], blocks: [] },
    lines: [stmt(1, 'goto loc_10;'), label(1, 'loc_10')],
    warnings: [],
    renderProvenance: { completeness: 'complete', snapshotId: 'regression' },
  });
  const closed = closePublicCOutputForTesting(build(), {});
  assert.deepEqual(render(closed.lines), [], 'the public boundary must remove the redundant jump');
  const direct = closeGotos(build().lines, { renderProvenance: { completeness: 'complete' } });
  assert.equal(direct.output, direct.result, 'without a refresh hook the map still blocks the rewrite');
});

/* -------------------------------------------------------------------------
 * Cost units (deterministic, no host timing)
 * ---------------------------------------------------------------------- */

function closeWithStats(lines, options = {}) {
  const result = {
    semantic: true,
    ir: options.ir || { instructions: [], values: [], blocks: [] },
    lines,
    warnings: [],
  };
  const stats = {};
  const output = eliminateAvoidableGotos(result, {}, stats);
  return { result, output, stats };
}

/** `count` labels immediately followed by the brace that closes their block. */
function strandedLabelBlock(count) {
  const lines = [ctrl(0, '{')];
  for (let index = 0; index < count; index += 1) lines.push(label(1, `loc_${(0x1000 + index).toString(16)}`));
  lines.push(ctrl(0, '}'));
  return lines;
}

/**
 * The work unit is `stats.scanSteps`: the number of line visits the closure
 * performed.  It is a property of the input and the algorithm only, so these
 * assertions hold on any host — unlike a wall-clock bound, which is exactly the
 * fragility this replaces.
 */
test('the label gate answers every label without rescanning the body per label', () => {
  const small = closeWithStats(strandedLabelBlock(400));
  const large = closeWithStats(strandedLabelBlock(1600));
  assert.equal(small.output, small.result, 'text that strands a label is never rewritten');
  assert.ok(small.stats.scanSteps >= 400, 'the counter must report real work');
  assert.ok(large.stats.scanSteps <= small.stats.scanSteps * 5,
    `4x the labels cost ${large.stats.scanSteps} vs ${small.stats.scanSteps} steps: the gate is not linear`);
  assert.ok(large.stats.scanSteps <= 12 * 1602,
    `${large.stats.scanSteps} steps for 1602 lines is more than a constant per line`);
});

test('the closure work stays bounded when every conditional jump refuses', () => {
  // Each conditional jump skips a region that leaves its scope, so every
  // candidate is refused at the end of its walk.  The bound is a per-candidate
  // fence, never a rescan of the body per candidate.
  const build = (count) => {
    const lines = [];
    for (let index = 0; index < count; index += 1) {
      lines.push(ctrl(2, `if (a${index} != 0) goto loc_9000;`));
      lines.push(stmt(2, `b${index} = a${index};`));
    }
    lines.push(ctrl(1, '}'));
    lines.push(label(1, 'loc_9000'));
    return lines;
  };
  const small = closeWithStats(build(200));
  const large = closeWithStats(build(800));
  assert.ok(large.stats.scanSteps <= small.stats.scanSteps * 5,
    `4x the jumps cost ${large.stats.scanSteps} vs ${small.stats.scanSteps} steps: the refusal path is not linear`);
  assert.ok(large.stats.scanSteps <= 6 * 1602 + 300 * 800,
    `${large.stats.scanSteps} steps exceeds a constant per line plus a bounded walk per jump`);
  assert.equal(large.stats.guardBlocks, 0, 'every candidate in this body is refused');
});

test('the reported work is deterministic for identical input', () => {
  const build = () => [
    ctrl(1, 'if (a1 != 0) goto loc_20;'), stmt(1, 'a2 = 1;'), label(1, 'loc_20'), stmt(1, 'a3 = 2;'),
    stmt(1, 'goto loc_30;'), label(1, 'loc_30'),
  ];
  const first = closeWithStats(build());
  const second = closeWithStats(build());
  assert.equal(first.stats.scanSteps, second.stats.scanSteps);
  assert.deepEqual(render(first.output.lines), render(second.output.lines));
  assert.equal(first.stats.removedGotos, second.stats.removedGotos);
});

/* -------------------------------------------------------------------------
 * Rule (3): backward natural-loop latches
 * ---------------------------------------------------------------------- */

const labelAtAddress = (indent, name, address) => ({ kind: 'label', indent, text: `${name}:`, row: null, addr: address, note: null });

/**
 * A minimal canonical loop record plus the exact line provenance the renderer
 * registers: the label is the entry of block `header`, the jump is the terminator
 * of block `latch`.  Nothing else is invented — this is the same shape
 * `js/controlflow.js` materializes from proven back edges.
 */
function loopFacts({ header, latch, headerName, loops = null }) {
  const blocks = Array.from({ length: Math.max(header, latch) + 2 }, (_unused, index) => ({ index }));
  const ir = {
    instructions: [], values: [], blocks,
    loops: loops || [{ header, latches: new Set([latch]), nodes: new Set([header, latch]), exits: new Set() }],
  };
  return { ir, header, latch, headerName };
}

function registerBranchLine(line, ir, { target, block }) {
  registerSemanticControlLineHistory(line, {
    ir,
    instruction: { id: block, op: block == null ? 'br' : 'br', block },
    selection: target == null ? undefined : { target },
    canonical: { isCurrent: () => true },
    records: [],
    isCurrent: () => true,
  });
}

test('a backward jump the IR proves is a natural-loop latch becomes an endless loop', () => {
  const { ir, header, latch } = loopFacts({ header: 1, latch: 2, headerName: 'loc_10' });
  const headerLine = labelAtAddress(1, 'loc_10', 0x10n);
  const jumpLine = stmt(2, 'goto loc_10;');
  registerBranchLine(headerLine, ir, { target: header, block: null });
  registerBranchLine(jumpLine, ir, { target: null, block: latch });
  const lines = [stmt(1, 'a0 = 0;'), headerLine, stmt(2, 'a1 = a1 + 1;'), jumpLine, stmt(1, 'a2 = 2;')];
  const { output, stats } = closeWithStats(lines, { ir });
  assert.deepEqual(render(output.lines), [
    '    a0 = 0;',
    '    while (1) {',
    '        a1 = a1 + 1;',
    '    }',
    '    a2 = 2;',
  ]);
  assert.equal(stats.loopWraps, 1);
  assert.equal(stats.loopCandidates, 1);
  assert.equal(stats.refusedLoopProof, 0);
  assert.equal(output.pseudocode, render(output.lines).join('\n'));
  assertJumpsResolveAndBracesBalance(output);
});

test('an inner loop is adopted before the outer region that contains it', () => {
  const { ir } = loopFacts({
    header: 1, latch: 2, headerName: 'loc_10',
    loops: [
      { header: 1, latches: new Set([2]), nodes: new Set([1, 2]), exits: new Set() },
      { header: 3, latches: new Set([4]), nodes: new Set([3, 4]), exits: new Set() },
    ],
  });
  const outer = labelAtAddress(1, 'loc_10', 0x10n);
  const inner = labelAtAddress(2, 'loc_20', 0x20n);
  const innerJump = stmt(3, 'goto loc_20;');
  const outerJump = stmt(2, 'goto loc_10;');
  registerBranchLine(outer, ir, { target: 1, block: null });
  registerBranchLine(inner, ir, { target: 3, block: null });
  registerBranchLine(innerJump, ir, { target: null, block: 4 });
  registerBranchLine(outerJump, ir, { target: null, block: 2 });
  const { output, stats } = closeWithStats([outer, stmt(2, 'a1 = 1;'), inner, stmt(3, 'a2 = 2;'), innerJump, outerJump], { ir });
  assert.deepEqual(render(output.lines), [
    '    while (1) {',
    '        a1 = 1;',
    '        while (1) {',
    '            a2 = 2;',
    '        }',
    '    }',
  ]);
  assert.equal(stats.loopWraps, 2);
  assertJumpsResolveAndBracesBalance(output);
});

test('a backward jump without the exact IR loop facts keeps its explicit goto', () => {
  const cases = [];
  // No loop record at all, and a loop whose header is a different block.
  const shape = () => {
    const { ir, header, latch } = loopFacts({ header: 1, latch: 2, headerName: 'loc_10' });
    const headerLine = labelAtAddress(1, 'loc_10', 0x10n);
    const jumpLine = stmt(2, 'goto loc_10;');
    registerBranchLine(headerLine, ir, { target: header, block: null });
    registerBranchLine(jumpLine, ir, { target: null, block: latch });
    return { ir, lines: [headerLine, stmt(2, 'a1 = 1;'), jumpLine] };
  };
  const empty = shape();
  empty.ir.loops = [];
  cases.push(['the IR publishes no loop', empty]);
  const otherHeader = shape();
  otherHeader.ir.loops = [{ header: 5, latches: new Set([2]), nodes: new Set([5, 2]), exits: new Set() }];
  cases.push(['the loop header is another block', otherHeader]);
  const otherLatch = shape();
  otherLatch.ir.loops = [{ header: 1, latches: new Set([7]), nodes: new Set([1, 7]), exits: new Set() }];
  cases.push(['the jumping block is not the latch', otherLatch]);
  const noHistory = shape();
  const bare = labelAtAddress(1, 'loc_30', 0x30n);
  const bareJump = stmt(2, 'goto loc_30;');
  cases.push(['the lines carry no render provenance', { ir: noHistory.ir, lines: [bare, stmt(2, 'a1 = 1;'), bareJump] }]);
  const wrongAddress = shape();
  const mismatched = labelAtAddress(1, 'loc_10', 0x40n);
  registerBranchLine(mismatched, wrongAddress.ir, { target: 1, block: null });
  const mismatchedJump = stmt(2, 'goto loc_10;');
  registerBranchLine(mismatchedJump, wrongAddress.ir, { target: null, block: 2 });
  cases.push(['the label address disagrees with its own name', { ir: wrongAddress.ir, lines: [mismatched, stmt(2, 'a1 = 1;'), mismatchedJump] }]);
  for (const [name, { ir, lines }] of cases) {
    const { output, stats } = closeWithStats(lines, { ir });
    assert.equal(stats.loopWraps ?? 0, 0, `${name}: no wrap is allowed`);
    assert.ok(render(output.lines).some((text) => text.includes('goto')), `${name}: the jump must stay explicit`);
  }
});

test('the loop wrap is refused when the region is not a plain scope of the jump', () => {
  const build = (body) => {
    const { ir, header, latch } = loopFacts({ header: 1, latch: 2, headerName: 'loc_10' });
    const headerLine = labelAtAddress(1, 'loc_10', 0x10n);
    const jumpLine = stmt(2, 'goto loc_10;');
    registerBranchLine(headerLine, ir, { target: header, block: null });
    registerBranchLine(jumpLine, ir, { target: null, block: latch });
    return { ir, lines: [headerLine, ...body, jumpLine] };
  };
  const cases = {
    'a bare break would change which loop it belongs to': [ctrl(2, 'break;')],
    'a bare continue would change which loop it belongs to': [ctrl(2, 'continue;')],
    'a switch entry inside the region': [stmt(2, 'a1 = 1;'), ctrl(2, 'case 3:')],
    'the region leaves the block': [stmt(2, 'a1 = 1;'), stmt(1, 'a2 = 2;')],
    'the region tail is a label': [stmt(2, 'a1 = 1;'), label(2, 'loc_20')],
  };
  for (const [name, body] of Object.entries(cases)) {
    const { ir, lines } = name === 'the region tail is a label'
      // loc_20 must stay addressable, otherwise the orphan sweep would remove it
      // before the loop stage ever sees the shape.
      ? (() => { const built = build(body); built.lines.push(stmt(1, 'goto loc_20;')); return built; })()
      : build(body);
    const { output, stats } = closeWithStats(lines, { ir });
    assert.equal(stats.loopWraps ?? 0, 0, `${name}: no wrap is allowed`);
    assert.ok(render(output.lines).some((text) => text.includes('goto loc_10;')), `${name}: the jump must stay explicit`);
    assertJumpsResolveAndBracesBalance(output);
  }

  // A jump that leaves the block instead of ending it is not a latch shape, and
  // neither is a region that opens a scope it does not close.
  const leaves = (() => {
    const { ir, header, latch } = loopFacts({ header: 1, latch: 2, headerName: 'loc_10' });
    const headerLine = labelAtAddress(2, 'loc_10', 0x10n);
    const jumpLine = stmt(1, 'goto loc_10;');
    registerBranchLine(headerLine, ir, { target: header, block: null });
    registerBranchLine(jumpLine, ir, { target: null, block: latch });
    return { ir, lines: [ctrl(1, 'if (a1 != 0) {'), headerLine, stmt(2, 'a1 = 1;'), jumpLine] };
  })();
  assert.equal(closeWithStats(leaves.lines, { ir: leaves.ir }).stats.loopWraps ?? 0, 0);
});

test('a flat labelled block whose backward jump is the proven latch wraps at the label level', () => {
  // The faithful CFG emitter lists a block's statements at the label's own
  // indentation, so the latch shape it emits is `L:` / statements / `goto L;`
  // all on one level.  The region is still one plain scope of that block, so
  // the loop back edge replaces the jump exactly: the body top is the
  // statement right after the label, which is where the jump went.
  const single = (() => {
    const { ir, header, latch } = loopFacts({ header: 1, latch: 2, headerName: 'loc_10' });
    const headerLine = labelAtAddress(1, 'loc_10', 0x10n);
    const jumpLine = stmt(1, 'goto loc_10;');
    registerBranchLine(headerLine, ir, { target: header, block: null });
    registerBranchLine(jumpLine, ir, { target: null, block: latch });
    return closeWithStats([headerLine, stmt(1, 'a1 = a1 + 1;'), jumpLine], { ir });
  })();
  assert.deepEqual(render(single.output.lines), [
    '    while (1) {',
    '        a1 = a1 + 1;',
    '    }',
  ]);
  assert.equal(single.stats.loopWraps, 1);
  assert.equal(single.stats.refusedLoopProof, 0);
  assertJumpsResolveAndBracesBalance(single.output);

  // A jump from above still addresses the label, so the label has to stay in
  // front of the loop: entering at the label means entering the loop.
  const shared = (() => {
    const { ir, header, latch } = loopFacts({ header: 1, latch: 2, headerName: 'loc_10' });
    const headerLine = labelAtAddress(1, 'loc_10', 0x10n);
    const jumpLine = stmt(1, 'goto loc_10;');
    registerBranchLine(headerLine, ir, { target: header, block: null });
    registerBranchLine(jumpLine, ir, { target: null, block: latch });
    return closeWithStats([stmt(1, 'goto loc_10;'), stmt(1, 'a2 = 5;'), headerLine, stmt(1, 'a1 = a1 + 1;'), jumpLine], { ir });
  })();
  assert.deepEqual(render(shared.output.lines), [
    '    goto loc_10;',
    '    a2 = 5;',
    '    loc_10:',
    '    while (1) {',
    '        a1 = a1 + 1;',
    '    }',
  ]);
  assert.equal(shared.stats.loopWraps, 1);
  assertJumpsResolveAndBracesBalance(shared.output);

  const source = [
    'long sample(long a1, long a2)',
    '{',
    ...render(single.output.lines),
    '    return a1;',
    '}',
    '',
    'long sample2(long a1, long a2)',
    '{',
    ...render(shared.output.lines),
    '    return a1;',
    '}',
    '',
  ].join('\n');
  const compiled = clangSyntaxOk(source);
  assert.ok(compiled.ok, `flat labelled block is not valid C:\n${source}\n${compiled.stderr}`);
});

test('a backward jump two other jumps also address keeps its goto and its label', () => {
  const { ir, header, latch } = loopFacts({ header: 1, latch: 2, headerName: 'loc_10' });
  const headerLine = labelAtAddress(1, 'loc_10', 0x10n);
  const firstJump = stmt(2, 'goto loc_10;');
  const secondJump = stmt(2, 'goto loc_10;');
  registerBranchLine(headerLine, ir, { target: header, block: null });
  registerBranchLine(firstJump, ir, { target: null, block: latch });
  registerBranchLine(secondJump, ir, { target: null, block: latch });
  const { output, stats } = closeWithStats([headerLine, stmt(2, 'a1 = 1;'), firstJump, secondJump], { ir });
  assert.equal(stats.loopWraps ?? 0, 0, 'two addresses mean the region is not this jump\'s own scope');
  const texts = render(output.lines);
  assert.ok(texts.some((text) => text.includes('loc_10:')), 'the label must survive for the other jump');
});

test('the x86-64 / RISC-V64 shared presentation boundary runs the closure and refreshes its map', async () => {
  // `js/analysis/semantic-function-base.js` publishes through its own boundary,
  // so it owns the same contract as the ARM64 one: the provably redundant jump
  // goes, and the index-keyed map describes the lines that are published.
  const { closeSharedPresentationOutputForTesting } = await import('../../js/analysis/semantic-function-base.js');
  const previous = { version: 1, snapshotId: 'shared-boundary', entities: { 'L0:stmt': { entityKey: 'L0:stmt', lineIndex: 0 } } };
  const build = () => ({
    semantic: true,
    ir: { instructions: [], values: [], blocks: [] },
    lines: [stmt(1, 'goto loc_10;'), label(1, 'loc_10'), stmt(1, 'a1 = 1;')],
    warnings: [],
    renderProvenance: previous,
  });
  const closed = closeSharedPresentationOutputForTesting(build(), {});
  assert.deepEqual(render(closed.lines), ['    a1 = 1;'], 'the shared boundary must remove the redundant jump and its label');
  assert.notEqual(closed.renderProvenance, previous, 'the map must be rebuilt over the published lines, not left stale');
  assert.equal(closed.renderProvenance.snapshotId, 'shared-boundary', 'the snapshot identity is preserved');

  // Nothing to remove: the same result and the same map come back untouched.
  const untouched = build();
  untouched.lines = [stmt(1, 'a1 = 1;')];
  const same = closeSharedPresentationOutputForTesting(untouched, {});
  assert.equal(same, untouched);
  assert.equal(same.renderProvenance, previous);
});

test('the wrapped loop still compiles as C', () => {
  const { ir, header, latch } = loopFacts({ header: 1, latch: 2, headerName: 'loc_10' });
  const headerLine = labelAtAddress(1, 'loc_10', 0x10n);
  const jumpLine = stmt(2, 'goto loc_10;');
  registerBranchLine(headerLine, ir, { target: header, block: null });
  registerBranchLine(jumpLine, ir, { target: null, block: latch });
  const { output } = closeWithStats([headerLine, stmt(2, 'a1 = a1 + 1;'), jumpLine, stmt(1, 'return a1;')], { ir });
  const source = [
    'long sample(long a1, long a2)',
    '{',
    ...render(output.lines),
    '}',
    '',
  ].join('\n');
  const result = clangSyntaxOk(source);
  assert.ok(result.ok, `wrapped loop is not valid C:\n${source}\n${result.stderr}`);
});

test('the rewritten control flow still compiles as C', () => {
  const guarded = closeGotos([
    ctrl(1, 'if (a1 != 0) goto loc_20;'), stmt(1, 'a2 = 1;'), label(1, 'loc_20'), stmt(1, 'a3 = 2;'),
  ]);
  const twoSided = closeGotos([
    ctrl(1, 'if (a1 != 0) goto loc_30;'), stmt(1, 'a2 = 1;'), stmt(1, 'goto loc_40;'),
    label(1, 'loc_30'), stmt(1, 'a3 = 2;'), label(1, 'loc_40'), stmt(1, 'a4 = 3;'),
  ]);
  const source = [
    'long sample(long a1, long a2, long a3, long a4)',
    '{',
    ...render(guarded.output.lines),
    ...render(twoSided.output.lines),
    '    return a1 + a2 + a3 + a4;',
    '}',
    '',
  ].join('\n');
  const result = clangSyntaxOk(source);
  assert.ok(result.ok, `rewritten control flow is not valid C:\n${source}\n${result.stderr}`);
});

