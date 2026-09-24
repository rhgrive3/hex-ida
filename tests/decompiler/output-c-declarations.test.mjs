import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closeFunctionOutput, fixedWidthPreludeLines } from '../../js/decompiler/c-output-closure.js';
import { buildCTranslationUnit } from '../../js/analysis/query/translation-unit.js';

function linesOf(text) {
  return String(text).split('\n').map((textLine, index) => ({
    kind: index === 0 ? 'sig' : textLine.trim() === '{' || textLine.trim() === '}' ? 'ctrl' : 'stmt',
    indent: index === 0 ? 0 : 1,
    text: textLine.trim(),
  }));
}

function resultOf(pseudocode) {
  return { lines: linesOf(pseudocode), pseudocode };
}

function clangSyntaxOk(source) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hex-output-closure-')), 'case.c');
  fs.writeFileSync(file, `${source}\n`);
  try {
    const out = spawnSync('/usr/bin/clang', ['-target', 'aarch64-linux-gnu', '-fsyntax-only', '-w', '-x', 'c', file], { encoding: 'utf8', timeout: 30000 });
    return { ok: out.status === 0, stderr: String(out.stderr ?? '') };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
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
  assert.equal(checked.ok, true, checked.stderr.split('\n').filter((line) => line.includes('error')).slice(0, 5).join('\n'));
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
