import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closeFunctionOutput, fixedWidthPreludeLines } from '../../js/decompiler/c-output-closure.js';
import { buildCTranslationUnit } from '../../js/analysis/query/translation-unit.js';

function linesOf(text, declared = []) {
  return String(text).split('\n').map((textLine, index) => {
    const trimmed = textLine.trim();
    const kind = index === 0 ? 'sig'
      : (trimmed === '{' || trimmed === '}' ? 'ctrl' : (declared.includes(trimmed) ? 'decl' : 'stmt'));
    return { kind, indent: index === 0 ? 0 : 1, text: trimmed };
  });
}

function resultOf(pseudocode, declared = []) {
  return { lines: linesOf(pseudocode, declared), pseudocode };
}

function clangSyntax(source, extraArgs) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hex-output-closure-')), 'case.c');
  fs.writeFileSync(file, `${source}\n`);
  try {
    const out = spawnSync('/usr/bin/clang', [...extraArgs, '-fsyntax-only', '-w', '-x', 'c', file], { encoding: 'utf8', timeout: 30000 });
    return { ok: out.status === 0, stderr: String(out.stderr ?? '') };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

/* Single-function text is checked with the campaign's target flags. */
function clangSyntaxOk(source) {
  return clangSyntax(source, ['-target', 'aarch64-linux-gnu']);
}

/* Packaged units include <stdint.h>, so they are checked with the same host
 * flags the measurement harness (recompile-replay/tu-replay) uses. */
function clangSyntaxOkHost(source) {
  return clangSyntax(source, []);
}

function errorTail(stderr) {
  return String(stderr).split('\n').filter((line) => line.includes('error')).slice(0, 5).join('\n');
}


test('closure declares emitted locals and defines the fixed-width spelling it uses', () => {
  const result = resultOf('uint64 sample(void)\n{\nlocal_pFFFFFFFFFFFFFFF0 = local_x29;\nreturn local_pFFFFFFFFFFFFFFF0;\n}');
  closeFunctionOutput(result);
  assert.match(result.pseudocode, /typedef __UINT64_TYPE__ uint64;/);
  assert.match(result.pseudocode, /uint64 local_pFFFFFFFFFFFFFFF0;/);
  assert.match(result.pseudocode, /uint64 local_x29;/);
  assert.ok(result.lines.some((line) => line.kind === 'decl' && line.text === 'uint64 local_x29;'));
});

test('closure keeps unknown helpers visible instead of dropping them', () => {
  const result = resultOf('uint64 sample(void)\n{\nreturn unknown_call(phi(1));\n}');
  closeFunctionOutput(result);
  assert.match(result.pseudocode, /unknown_call\(phi\(1\)\)/);
});

test('closure is idempotent over already-closed output', () => {
  const result = resultOf('uint64 sample(void)\n{\nlocal_x = 1;\nreturn local_x;\n}');
  closeFunctionOutput(result);
  const once = result.pseudocode;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);
  assert.equal(result.pseudocode.split('typedef __UINT64_TYPE__ uint64;').length - 1, 1);
});

test('fixed-width prelude covers exactly the spellings the text uses', () => {
  assert.deepEqual(fixedWidthPreludeLines('uint64 f(void) { return 1; }').map((line) => line.text), [
    '/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */',
    'typedef __UINT64_TYPE__ uint64;',
  ]);
  assert.deepEqual(fixedWidthPreludeLines('int f(void) { return 1; }'), []);
});

test('closed function text parses with clang syntax-only', () => {
  const result = resultOf('uint64 sample(void)\n{\nlocal_pFFFFFFFFFFFFFFF0 = local_x29;\nreturn local_pFFFFFFFFFFFFFFF0;\n}');
  closeFunctionOutput(result);
  const checked = clangSyntaxOk(result.pseudocode);
  assert.equal(checked.ok, true, errorTail(checked.stderr));
});

test('closure declares a local whose only colon is a ternary colon, not a label', () => {
  const result = resultOf(
    'uint32 loop_while(int64 a1)\n{\n  uint64 x3;\n  x2 = 0;\n  x3 = 0x66666667;\n  x2 = (uint32)((uint32)x2 + 1);\n  return (uint32)((uint32)x2 > 0 ? (uint32)x2 : 1);\n}',
    ['uint64 x3;'],
  );
  closeFunctionOutput(result);
  assert.match(result.pseudocode, /uint64 x2;/);
  assert.equal(result.pseudocode.match(/\bx3;/g).length, 1);
  const checked = clangSyntaxOk(result.pseudocode);
  assert.equal(checked.ok, true, errorTail(checked.stderr));
});

test('closure still leaves statement labels out of the declaration block', () => {
  const result = resultOf('void sample(void)\n{\n  goto loc_EA4;\n  loc_EA4:\n  return;\n}');
  closeFunctionOutput(result);
  assert.ok(!result.lines.some((line) => line.kind === 'decl' && line.text.includes('loc_EA4')));
  assert.match(result.pseudocode, /\n\s*loc_EA4:/);
});

test('translation unit declares alias spellings used by evidence prototypes before the prototypes', () => {
  const caller = resultOf('uint64 caller(void)\n{\n  return callee();\n}');
  const callee = resultOf('uint64 callee(void)\n{\n  return 1;\n}');
  closeFunctionOutput(caller);
  closeFunctionOutput(callee);
  const unit = buildCTranslationUnit([
    { address: 0x100n, name: 'caller', signature: 'uint64 caller(void)', pseudocode: caller.pseudocode, ir: { instructions: [{ op: 'call', target: 0x200n, name: 'callee' }] } },
    { address: 0x200n, name: 'callee', signature: 'uint64 callee(void)', pseudocode: callee.pseudocode },
  ]);
  assert.ok(unit.prototypes.some((row) => row.declaration === 'uint64 callee(void);'));
  assert.match(unit.source, /typedef [^;]*\buint64;/);
  assert.ok(unit.source.indexOf('typedef uint64_t uint64;') < unit.source.indexOf('uint64 callee(void);'));
  const checked = clangSyntaxOkHost(unit.source);
  assert.equal(checked.ok, true, errorTail(checked.stderr));
});

test('translation unit never fabricates a prototype for the asm keyword', () => {
  const unit = buildCTranslationUnit([resultOf('void sample(void)\n{\n  __asm("nop");\n}')].map((result, index) => ({
    address: 0x100n + BigInt(index), name: 'sample', signature: 'void sample(void)',
    pseudocode: result.lines.map((line) => `${'    '.repeat(line.indent)}${line.text}`).join('\n'),
  })));
  assert.deepEqual(unit.fallbackDeclarations.filter((line) => /\basm\b/.test(line)), []);
  assert.deepEqual(unit.unresolved.filter((row) => row.subject === '__asm' || row.subject === 'asm'), []);
});

test('translation unit treats a text-defined name as the selected definition, not an unresolved callee', () => {
  const result = resultOf('void init(void)\n{\n  return;\n}');
  closeFunctionOutput(result);
  const unit = buildCTranslationUnit([{
    address: 0x200n, name: '_init', signature: 'void init(void)', pseudocode: result.pseudocode,
  }]);
  assert.deepEqual(unit.fallbackDeclarations.filter((line) => /\binit\s*\(/.test(line)), []);
  assert.deepEqual(unit.unresolved.filter((row) => row.subject === 'init'), []);
  const checked = clangSyntaxOkHost(unit.source);
  assert.equal(checked.ok, true, errorTail(checked.stderr));
});

test('translation unit keeps unresolved entries and adds syntax-only fallbacks', () => {
  const unit = buildCTranslationUnit([{
    address: 0x100n, name: 'sample', signature: 'uint64 sample(void)',
    pseudocode: 'uint64 sample(void)\n{\n  return global_5000 + mystery(1);\n}',
    ir: { instructions: [{ op: 'call', target: 0x444n, name: 'mystery' }] },
  }]);
  assert.ok(unit.unresolved.some((row) => row.kind === 'unresolved-global' && row.subject === 'global_5000'));
  assert.ok(unit.unresolved.some((row) => row.kind === 'unresolved-prototype' && row.subject === 'mystery'));
  assert.ok(unit.fallbackDeclarations.some((line) => line.startsWith('extern uint8_t global_5000[];')));
  assert.ok(unit.fallbackDeclarations.some((line) => line.startsWith('uint64_t mystery();')));
  assert.equal(unit.completeness, 'partial');
});
