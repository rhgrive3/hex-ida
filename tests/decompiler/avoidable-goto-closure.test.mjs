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

