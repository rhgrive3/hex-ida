import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { printExpression } from '../../js/decompiler/pretty/c.js';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';

function makeResult(lines) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
  };
}

function compileObjectO0(cSource, label = 'aarch64-compile') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-pass6-t2-'));
  const srcPath = path.join(tmpDir, 'test.c');
  const objPath = path.join(tmpDir, 'test.o');
  try {
    fs.writeFileSync(srcPath, cSource, 'utf8');
    execFileSync('aarch64-linux-gnu-gcc', ['-O0', '-c', '-o', objPath, srcPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    assert.fail(`${label} failed:\n--- C source ---\n${cSource}\n--- stderr ---\n${stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function compileAndRunAarch64(cSource, label = 'aarch64-run') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-pass6-t2-run-'));
  const srcPath = path.join(tmpDir, 'test.c');
  const binPath = path.join(tmpDir, 'test.bin');
  try {
    fs.writeFileSync(srcPath, cSource, 'utf8');
    execFileSync('aarch64-linux-gnu-gcc', ['-O0', '-o', binPath, srcPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const qemuArgs = fs.existsSync('/usr/aarch64-linux-gnu/lib')
      ? ['-L', '/usr/aarch64-linux-gnu', binPath]
      : [binPath];
    const stdout = execFileSync('qemu-aarch64', qemuArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return stdout.trim();
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    const stdout = String(err.stdout || '');
    assert.fail(`${label} failed:\n--- C source ---\n${cSource}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('pretty/c.js: lowers FP conversion unary ops (fcvtzs/fcvtzu/scvtf/ucvtf/fcvt + aliases) for 32/64-bit and compiles with aarch64-linux-gnu-gcc -O0 -c', () => {
  const vX = expr.variable('x', 64);
  const vSum = expr.binary('add', expr.variable('a', 64), expr.variable('b', 64), 64);

  const cases = [
    ['fcvtzs', 32, vX, '((int32_t)(double)(x))'],
    ['fcvtzs', 64, vX, '((int64_t)(double)(x))'],
    ['f2i', 32, vX, '((int32_t)(double)(x))'],
    ['f2i', 64, vX, '((int64_t)(double)(x))'],
    ['fcvtzu', 32, vX, '((uint32_t)(double)(x))'],
    ['fcvtzu', 64, vX, '((uint64_t)(double)(x))'],
    ['f2u', 32, vX, '((uint32_t)(double)(x))'],
    ['f2u', 64, vX, '((uint64_t)(double)(x))'],
    ['scvtf', 32, vX, '((float)(int64_t)(x))'],
    ['scvtf', 64, vX, '((double)(int64_t)(x))'],
    ['i2f', 32, vX, '((float)(int64_t)(x))'],
    ['i2f', 64, vX, '((double)(int64_t)(x))'],
    ['ucvtf', 32, vX, '((float)(uint64_t)(x))'],
    ['ucvtf', 64, vX, '((double)(uint64_t)(x))'],
    ['u2f', 32, vX, '((float)(uint64_t)(x))'],
    ['u2f', 64, vX, '((double)(uint64_t)(x))'],
    ['fcvt', 32, vX, '((float)(x))'],
    ['fcvt', 64, vX, '((double)(x))'],
    ['fcvtzs', 32, vSum, '((int32_t)(double)(a + b))'],
  ];

  for (const [op, bits, arg, expected] of cases) {
    const node = expr.unary(op, arg, bits);
    const printed = printExpression(node);
    assert.equal(printed, expected, `${op} (${bits}-bit)`);
    assert.doesNotMatch(printed, new RegExp(`\\b${op}\\s*\\(`));
  }

  const cSource = `
#include <stdint.h>
int64_t fp_casts_test(double x, int64_t a, int64_t b) {
  int32_t s32 = ${printExpression(expr.unary('fcvtzs', vX, 32))};
  int64_t s64 = ${printExpression(expr.unary('fcvtzs', vX, 64))};
  uint32_t u32 = ${printExpression(expr.unary('fcvtzu', vX, 32))};
  uint64_t u64 = ${printExpression(expr.unary('fcvtzu', vX, 64))};
  float sf32 = ${printExpression(expr.unary('scvtf', expr.variable('a', 64), 32))};
  double sf64 = ${printExpression(expr.unary('scvtf', expr.variable('a', 64), 64))};
  float uf32 = ${printExpression(expr.unary('ucvtf', expr.variable('b', 64), 32))};
  double uf64 = ${printExpression(expr.unary('ucvtf', expr.variable('b', 64), 64))};
  float narrowed = ${printExpression(expr.unary('fcvt', expr.variable('sf64', 64), 32))};
  double widened = ${printExpression(expr.unary('fcvt', expr.variable('sf32', 32), 64))};
  return (int64_t)s32 + s64 + (int64_t)u32 + (int64_t)u64
    + (int64_t)narrowed + (int64_t)widened + (int64_t)uf32 + (int64_t)uf64;
}
`;
  compileObjectO0(cSource, 'pretty/c.js FP unary casts compile');
});

test('c-output-closure: indirect-copy GOT globals (1-hop, cast copy, 2-hop, subscript) get static backing word while non-dereferenced globals stay = 0', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 indirect_got_reads(uint64 x)', row: 0, addr: 0x3000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    // 1-hop direct copy -> cast deref
    { kind: 'stmt', indent: 1, text: 'load_172 = global_1FFD0;' },
    { kind: 'stmt', indent: 1, text: 'v1 = *(uint64_t *)(uintptr_t)(load_172);' },
    // 1-hop cast copy -> cast deref
    { kind: 'stmt', indent: 1, text: 'load_173 = (uint64)global_1FFD8;' },
    { kind: 'stmt', indent: 1, text: 'v2 = *(uint64_t *)(uintptr_t)(load_173);' },
    // 2-hop copy chain -> cast deref
    { kind: 'stmt', indent: 1, text: 'hop1 = global_1FFE0;' },
    { kind: 'stmt', indent: 1, text: 'hop2 = (uintptr_t)(hop1);' },
    { kind: 'stmt', indent: 1, text: 'v3 = *(uint64_t *)(uintptr_t)(hop2);' },
    // 1-hop copy -> subscript deref
    { kind: 'stmt', indent: 1, text: 'uint64_t * arr_ptr = (uint64_t *)(uintptr_t)global_1FFE8;' },
    { kind: 'stmt', indent: 1, text: 'v4 = arr_ptr[0];' },
    // Non-dereferenced: copied to local but only used arithmetically
    { kind: 'stmt', indent: 1, text: 'copy_only = global_20000;' },
    { kind: 'stmt', indent: 1, text: 'v5 = copy_only + x;' },
    // Non-dereferenced: used directly in arithmetic
    { kind: 'stmt', indent: 1, text: 'v6 = x * global_20008;' },
    { kind: 'ctrl', indent: 1, text: 'return v1 + v2 + v3 + v4 + v5 + v6;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  for (const name of ['global_1FFD0', 'global_1FFD8', 'global_1FFE0', 'global_1FFE8']) {
    assert.match(result.pseudocode, new RegExp(`static uint64 __hex_${name}_backing = 0;`));
    assert.match(
      result.pseudocode,
      new RegExp(`static uint64 ${name} = \\(uint64\\)\\(uintptr_t\\)&__hex_${name}_backing;`),
    );
  }
  for (const name of ['global_20000', 'global_20008']) {
    assert.match(result.pseudocode, new RegExp(`static uint64 ${name} = 0;`));
    assert.doesNotMatch(result.pseudocode, new RegExp(`__hex_${name}_backing`));
  }

  // Strictly idempotent on second pass.
  const once = result.pseudocode;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);

  // Compiles cleanly with aarch64-linux-gnu-gcc -O0 -c.
  compileObjectO0(result.pseudocode, 'indirect-copy GOT backing compile');

  // Links and executes under qemu-aarch64 without NULL-deref SIGSEGV.
  const harness = `
#include <stdio.h>
${result.pseudocode}
int main(void) {
  uint64 r = indirect_got_reads(7ULL);
  printf("%llu\\n", (unsigned long long)r);
  return r == 7ULL ? 0 : 1;
}
`;
  const out = compileAndRunAarch64(harness, 'indirect-copy GOT backing runtime');
  assert.equal(out, '7');
});
