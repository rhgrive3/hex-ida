import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import {
  createGCaseRunner,
  reconstructSource,
} from '../../tools/validation/direct-recompilability/measure-g.mjs';

function detectCCompiler() {
  for (const candidate of ['clang', 'gcc']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function checkCSyntax(source, compiler) {
  const result = spawnSync(compiler, ['-std=gnu11', '-x', 'c', '-fsyntax-only', '-'], {
    input: source,
    encoding: 'utf8',
  });
  return {
    ok: !result.error && result.status === 0,
    stderr: result.stderr || String(result.error?.message || ''),
  };
}

function makeClosedResult(lines) {
  const result = {
    lines,
    pseudocode: lines.map((line) => `${'  '.repeat(line.indent ?? 0)}${line.text}`).join('\n'),
  };
  closeFunctionOutput(result);
  return result;
}

const COMPILER = detectCCompiler();

test('reconstructSource returns null for empty, non-array, or blank-pseudocode inputs', () => {
  assert.equal(reconstructSource(null), null);
  assert.equal(reconstructSource(undefined), null);
  assert.equal(reconstructSource([]), null);
  assert.equal(reconstructSource([
    { address: '0x1000', name: 'empty_fn', pseudocode: null },
    { address: '0x1020', name: 'blank_fn', pseudocode: '   \n\t ' },
  ]), null);
});

test('reconstructSource deduplicates typedefs, merges hex_struct_* definitions, and resolves mutual sub_* calls', () => {
  const fnCaller = makeClosedResult([
    { kind: 'sig', indent: 0, text: 'uint64 sub_401000(uint64 x)', row: 0, addr: 0x401000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'uint64 v1 = sub_401040(x);' },
    { kind: 'stmt', indent: 1, text: 'return v1 + a1->field_0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  const fnCallee = makeClosedResult([
    { kind: 'sig', indent: 0, text: 'uint64 sub_401040(uint64 x)', row: 0, addr: 0x401040n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'if (x == 0) return sub_401000(x + 1);' },
    { kind: 'stmt', indent: 1, text: 'return a1->field_0 + a1->field_8 + ext_helper(x);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  const source = reconstructSource([
    { address: '4198400', name: 'sub_401000', state: 'PASS', pseudocode: fnCaller.pseudocode },
    { address: '4198464', name: 'sub_401040', state: 'PASS', pseudocode: fnCallee.pseudocode },
    { address: '4198528', name: 'sub_401080', state: 'CRASH', pseudocode: null },
  ]);

  assert.equal(typeof source, 'string');
  assert.ok(source.length > 0);
  // Fixed-width typedefs and synthesized struct typedefs must be hoisted and deduplicated.
  assert.equal(source.split('typedef uint64_t uint64;').length - 1, 1);
  assert.equal(source.split('hex_struct_a1;').length - 1, 1);
  assert.match(source, /typedef struct \{ uint64 field_0; uint64 field_8; \} hex_struct_a1;/);
  // Forward declarations for both selected sub_* functions must precede definitions.
  assert.match(source, /uint64 sub_401000\(uint64 x\);/);
  assert.match(source, /uint64 sub_401040\(uint64 x\);/);
  // Unresolved external callee gets a single syntax-only fallback declaration.
  assert.equal(source.split('uint64_t ext_helper();').length - 1, 1);
  // Both function bodies remain faithful (not replaced with __builtin_trap placeholders).
  assert.doesNotMatch(source, /__builtin_trap/);

  assert.ok(COMPILER, 'Expected clang or gcc to be available for C syntax verification');
  const check = checkCSyntax(source, COMPILER);
  assert.equal(check.ok, true, `Integrated TU failed ${COMPILER} -fsyntax-only:\n${source}\n${check.stderr}`);
});

test('reconstructSource adapts text, lines, and single-line pseudocode function objects cleanly', () => {
  const source = reconstructSource([
    {
      address: '0x1000',
      name: 'recovered_function',
      pseudocode: 'int recovered_function(int x) { return x + 7; }',
    },
    {
      address: '0x2000',
      name: 'from_text',
      text: 'int from_text(int x)\n{\n  return recovered_function(x) + 1;\n}',
    },
    {
      startAddress: '0x3000',
      name: 'from_lines',
      lines: [
        { text: 'int from_lines(int x)' },
        { text: '{' },
        { text: '  return from_text(x) + 2;' },
        { text: '}' },
      ],
    },
  ]);

  assert.equal(typeof source, 'string');
  assert.doesNotMatch(source, /__builtin_trap/);
  assert.match(source, /int recovered_function\(int x\)/);
  assert.match(source, /int from_text\(int x\)/);
  assert.match(source, /int from_lines\(int x\)/);

  assert.ok(COMPILER, 'Expected clang or gcc to be available for C syntax verification');
  const check = checkCSyntax(source, COMPILER);
  assert.equal(check.ok, true, `Adapted TU failed ${COMPILER} -fsyntax-only:\n${source}\n${check.stderr}`);
});

test('createGCaseRunner compiles multi-function TU with duplicate typedefs and mutual sub_* calls', async () => {
  assert.ok(COMPILER, 'Expected clang or gcc to be available for object compilation verification');
  const fn1 = makeClosedResult([
    { kind: 'sig', indent: 0, text: 'uint64 sub_1000(uint64 x)', row: 0, addr: 0x1000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return sub_2000(x) + a1->field_0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  const fn2 = makeClosedResult([
    { kind: 'sig', indent: 0, text: 'uint64 sub_2000(uint64 x)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return a1->field_0 + a1->field_8 + x;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  const spawnRunner = (cmd, args, opts) => {
    const adjustedArgs = cmd === 'gcc' ? args.filter((arg) => arg !== '-ferror-limit=0') : args;
    return spawnSync(cmd, adjustedArgs, opts);
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-measure-g-tu-'));
  try {
    const runCase = createGCaseRunner({
      clang: COMPILER,
      tmpRoot,
      clangTimeoutMs: 30000,
      spawnRunner,
      runSubject: async () => ({
        row: {
          state: 'PASS',
          reason: null,
          functions: [
            { address: '0x1000', name: 'sub_1000', state: 'PASS', pseudocode: fn1.pseudocode },
            { address: '0x2000', name: 'sub_2000', state: 'PASS', pseudocode: fn2.pseudocode },
          ],
        },
      }),
    });

    const result = await runCase({ id: 'multi-fn-tu', path: '/unused/input' });
    assert.equal(result.state, 'PASS');
    assert.equal(result.reason, null);
    assert.equal(result.functions.total, 2);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
