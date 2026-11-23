import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompile as decompileLegacy, decompiledText } from '../../js/decompile-legacy.js';

function makeLegacyModel(lines, opts = {}) {
  const base = opts.addr ?? 0x100000n;
  const rows = lines.map((text, row) => {
    const trimmed = text.trim();
    const split = trimmed.indexOf(' ');
    return {
      row,
      address: base + BigInt(row * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => rows.find((r) => r.address === BigInt(address))?.row ?? null;
  const symbols = opts.symbols || new Map();
  const symbolFor = (address) => symbols.get(BigInt(address)) ?? null;
  const model = buildSemanticModel(rows, {
    rowOfAddress,
    symbolFor,
    startRow: 0,
    endRow: rows.length - 1,
  });
  return {
    model,
    opts: {
      addr: base,
      name: opts.name || 'func0',
      symbolFor,
      rowOfAddress,
      beginner: false,
      ...opts,
    },
  };
}

function checkGccSyntax(cCode, label, headers = []) {
  const inc = headers.map((h) => `#include <${h}>`).join('\n');
  const wrapped = `${inc}\n#include <stdint.h>\n#define __asm(x) ((void)0)\ntypedef unsigned long long uint64;\ntypedef long long int64;\ntypedef unsigned int uint32;\ntypedef int int32;\ntypedef unsigned short uint16;\ntypedef short int16;\ntypedef unsigned char uint8;\ntypedef signed char int8;\ntypedef unsigned __int128 uint128;\n${cCode}\n`;
  try {
    execFileSync('gcc', ['-fsyntax-only', '-x', 'c', '-'], {
      input: wrapped,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    assert.fail(`GCC syntax check failed for ${label}:\n${err.stderr?.toString() || err.message}\n--- C ---\n${wrapped}`);
  }
}

test('1. caps over-collected arguments on fixed-arity stdlib calls (strlen, malloc, rand)', () => {
  // strlen(a1, a2) -> strlen(a1), both direct and inlined in expression
  {
    const { model, opts } = makeLegacyModel([
      'mov x19, x0',
      'mov x20, x1',
      'bl #0x200000',
      'mov w21, w0',
      'mov x0, x21',
      'ret',
    ], { symbols: new Map([[0x200000n, '_strlen']]) });
    // Simulate stale live x0, x1 in model.calls
    for (const c of model.calls) {
      c.name = '_strlen';
      c.args = [
        { index: 0, value: { kind: 'reg', reg: 'x0' } },
        { index: 1, value: { kind: 'reg', reg: 'x1' } },
      ];
    }
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bstrlen\([^,)]+\)/, `expected 1-arg strlen:\n${code}`);
    assert.doesNotMatch(code, /\bstrlen\([^)]*,/, `strlen must not have >1 arg:\n${code}`);
  }

  // malloc(x21, a2, a3) -> malloc(x21)
  {
    const { model, opts } = makeLegacyModel([
      'mov x0, x1',
      'bl #0x200010',
      'ret',
    ], { symbols: new Map([[0x200010n, '_malloc']]) });
    for (const c of model.calls) {
      c.name = '_malloc';
      c.args = [
        { index: 0, value: { kind: 'reg', reg: 'x0' } },
        { index: 1, value: { kind: 'reg', reg: 'x1' } },
        { index: 2, value: { kind: 'reg', reg: 'x2' } },
      ];
    }
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bmalloc\([^,)]+\)/, `expected 1-arg malloc:\n${code}`);
    assert.doesNotMatch(code, /\bmalloc\([^)]*,/, `malloc must not have >1 arg:\n${code}`);
  }

  // 0-arg rand() with stale live x0, x1 -> rand()
  {
    const { model, opts } = makeLegacyModel([
      'mov x0, #1',
      'mov x1, #2',
      'bl #0x200020',
      'ret',
    ], { symbols: new Map([[0x200020n, '_rand']]) });
    for (const c of model.calls) {
      c.name = '_rand';
      c.args = [
        { index: 0, value: { kind: 'imm', value: 1n } },
        { index: 1, value: { kind: 'imm', value: 2n } },
      ];
    }
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\brand\(\)/, `expected 0-arg rand():\n${code}`);
  }
});

test('2. pads under-collected FP and GP arguments on fixed-arity calls (sqrtf, sqrt, fabs, pow, strtod)', () => {
  // sqrtf() -> sqrtf((float)v0)
  {
    const { model, opts } = makeLegacyModel([
      'fmul s0, s0, s0',
      'bl #0x200030',
      'ret',
    ], { symbols: new Map([[0x200030n, '_sqrtf']]) });
    for (const c of model.calls) {
      c.name = '_sqrtf';
      c.args = [];
    }
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bsqrtf\(\(float\)v0\)/, `expected sqrtf((float)v0):\n${code}`);
  }

  // sqrt() -> sqrt((double)v0) and fabs() -> fabs((double)v0)
  for (const fnName of ['sqrt', 'fabs']) {
    const { model, opts } = makeLegacyModel([
      'fadd d0, d0, d0',
      'bl #0x200040',
      'ret',
    ], { symbols: new Map([[0x200040n, '_' + fnName]]) });
    for (const c of model.calls) {
      c.name = '_' + fnName;
      c.args = [];
    }
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, new RegExp(`\\b${fnName}\\(\\(double\\)v0\\)`), `expected ${fnName}((double)v0):\n${code}`);
  }

  // pow() -> pow((double)v0, (double)v1)
  {
    const { model, opts } = makeLegacyModel([
      'fadd d0, d0, d1',
      'bl #0x200050',
      'ret',
    ], { symbols: new Map([[0x200050n, '_pow']]) });
    for (const c of model.calls) {
      c.name = '_pow';
      c.args = [];
    }
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bpow\(\(double\)v0, \(double\)v1\)/, `expected pow((double)v0, (double)v1):\n${code}`);
  }

  // strtod() with missing x0 and present x1 = 0 -> strtod(..., 0)
  {
    const { model, opts } = makeLegacyModel([
      'mov x1, #0',
      'bl #0x200060',
      'ret',
    ], { symbols: new Map([[0x200060n, '_strtod']]) });
    for (const c of model.calls) {
      c.name = '_strtod';
      c.args = [{ index: 1, value: { kind: 'imm', value: 0n } }];
    }
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bstrtod\([^,)]+,\s*[^,)]+\)/, `expected 2-arg strtod:\n${code}`);
    assert.doesNotMatch(code, /\bstrtod\(\)/, `strtod must not have 0 args:\n${code}`);
  }

  // variadic printf is NOT capped to minArity 1
  {
    const { model, opts } = makeLegacyModel([
      'mov x1, #42',
      'mov x2, #7',
      'bl #0x200070',
      'ret',
    ], { symbols: new Map([[0x200070n, '_printf']]) });
    for (const c of model.calls) {
      c.name = '_printf';
      c.args = [
        { index: 0, value: { kind: 'string', text: '%d %d\\n' } },
        { index: 1, value: { kind: 'imm', value: 42n } },
        { index: 2, value: { kind: 'imm', value: 7n } },
      ];
    }
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bprintf\([^,)]+,\s*[^,)]+,\s*[^,)]+\)/, `variadic printf must preserve all 3 args:\n${code}`);
  }
});

test('3. legacy FP-only function signatures recover incoming FP params and non-void FP return (idx 666 pattern)', () => {
  // idx 666: float func0(float number) { return number - (int)number; }
  {
    const { model, opts } = makeLegacyModel([
      'fcvtzs s1, s0',
      'scvtf s1, s1',
      'fsub s0, s0, s1',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.equal(res.signature, 'float func0(float a1)', `unexpected signature:\n${code}`);
    assert.match(code, /return \(float\)/, `expected non-void float return:\n${code}`);
    assert.doesNotMatch(code, /\breturn;/, `must not emit bare void return:\n${code}`);
    checkGccSyntax(`uint128 v0, v1;\n${code}\nfloat caller(void) { return func0(3.5f); }`, 'idx 666 FP-only');
  }

  // double 2-arg FP-only function: double func0(double a1, double a2)
  {
    const { model, opts } = makeLegacyModel([
      'fadd d0, d0, d1',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.equal(res.signature, 'double func0(double a1, double a2)', `unexpected double signature:\n${code}`);
    assert.match(code, /return \(double\)/, `expected non-void double return:\n${code}`);
    checkGccSyntax(`uint128 v0, v1;\n${code}\ndouble caller(void) { return func0(1.0, 2.0); }`, 'double 2-arg FP-only');
  }

  // Writing s0 before reading it must NOT add an incoming FP parameter
  {
    const { model, opts } = makeLegacyModel([
      'fmov s0, #1.0',
      'fadd s0, s0, s0',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    assert.equal(res.signature, 'float func0(void)');
  }
});
