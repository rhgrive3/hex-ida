import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildValues, render as renderExpr, bin, regNode } from '../../js/expr.js';
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
    rows,
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

function checkGccSyntax(cCode, label, extraFlags = [], preamble = '') {
  const wrapped = `#include <stdint.h>\n#include <stddef.h>\n#define __asm(x) ((void)0)\ntypedef unsigned long long uint64;\ntypedef long long int64;\ntypedef unsigned int uint32;\ntypedef int int32;\ntypedef unsigned short uint16;\ntypedef short int16;\ntypedef unsigned char uint8;\ntypedef signed char int8;\ntypedef unsigned __int128 uint128;\n${preamble}\n${cCode}\n`;
  try {
    execFileSync('gcc', ['-fsyntax-only', ...extraFlags, '-x', 'c', '-'], {
      input: wrapped,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    assert.fail(`GCC syntax check failed for ${label}:\n${err.stderr?.toString() || err.message}\n--- C ---\n${wrapped}`);
  }
}

test('Fix 1 (idx=982): gates string-literal substitution on non-FP/non-SIMD destinations', () => {
  const { model, opts } = makeLegacyModel([
    'ldr d0, [x0, #0x10]',
    'ldr s1, [x0, #0x18]',
    'ldr x2, [x0, #0x20]',
    'fcmp d0, d1',
    'fadd d0, d0, d1',
    'ret',
  ]);
  model.addressRefs = [
    { row: 0, addr: 0x300010n, text: 'FAKE_DOUBLE_STR', load: true },
    { row: 1, addr: 0x300018n, text: 'FAKE_FLOAT_STR', load: true },
    { row: 2, addr: 0x300020n, text: 'REAL_GP_STR', load: true },
  ];

  const vg = buildValues(model);
  assert.equal(vg.defAt(0, 'v0')?.k, 'mem', 'FP double load must stay mem node, not str');
  assert.equal(vg.defAt(1, 'v1')?.k, 'mem', 'FP float load must stay mem node, not str');
  assert.equal(vg.defAt(2, 'x2')?.k, 'str', 'GP load must keep string-literal substitution');

  const res = decompileLegacy(model, opts);
  const code = decompiledText(res);
  assert.doesNotMatch(code, /FAKE_DOUBLE_STR/, `must not substitute string literal into double reg:\n${code}`);
  assert.doesNotMatch(code, /FAKE_FLOAT_STR/, `must not substitute string literal into float reg:\n${code}`);
  assert.match(code, /\*\(double \*\)/, `expected double pointer dereference:\n${code}`);
});

test('Fix 2a (idx=1270): lowers sbc/sbcs and adc/adcs cleanly without raw invalid C infix', () => {
  // subs + sbc
  {
    const { model, opts } = makeLegacyModel([
      'subs x4, x0, x1',
      'sbc x0, x2, x3',
      'ret',
    ]);
    const vg = buildValues(model);
    const sbcNode = vg.defAt(1, 'x0');
    const rendered = renderExpr(sbcNode);
    assert.doesNotMatch(rendered, /\bsbc\b/, `must not emit raw sbc infix: ${rendered}`);
    assert.match(rendered, /\? 1 : 0/, `expected borrow conditional from subs flags: ${rendered}`);

    const code = decompiledText(decompileLegacy(model, opts));
    assert.doesNotMatch(code, /\bsbc\b/, `decompiled C must not contain raw sbc:\n${code}`);
    checkGccSyntax(code, 'subs+sbc');
  }

  // adds + adc
  {
    const { model, opts } = makeLegacyModel([
      'adds x4, x0, x1',
      'adc x0, x2, x3',
      'ret',
    ]);
    const vg = buildValues(model);
    const adcNode = vg.defAt(1, 'x0');
    const rendered = renderExpr(adcNode);
    assert.doesNotMatch(rendered, /\badc\b/, `must not emit raw adc infix: ${rendered}`);
    assert.match(rendered, /\? 1 : 0/, `expected carry conditional from adds flags: ${rendered}`);

    const code = decompiledText(decompileLegacy(model, opts));
    assert.doesNotMatch(code, /\badc\b/, `decompiled C must not contain raw adc:\n${code}`);
    checkGccSyntax(code, 'adds+adc');
  }

  // Direct render fallback for bin('sbc', ...) and bin('adc', ...)
  const rawSbc = renderExpr(bin('sbc', regNode('x2', 0), regNode('x3', 0), 64));
  const rawAdc = renderExpr(bin('adc', regNode('x2', 0), regNode('x3', 0), 64));
  assert.equal(rawSbc, 'x2 - x3');
  assert.equal(rawAdc, 'x2 + x3');
});

test('Fix 2b (idx=1270): normalizes variadic calls (sprintf_chk) using min arity and format specifiers', () => {
  // Tail-call to __sprintf_chk with empty call.args and format string "%d %% %s" (2 conversion specs -> 6 total args)
  {
    const { model, opts } = makeLegacyModel([
      'mov w1, #1',
      'mov x2, #64',
      'adr x3, #0x300000',
      'b #0x200000',
    ], { symbols: new Map([[0x200000n, '__sprintf_chk']]) });
    model.addressRefs = [
      { row: 2, addr: 0x300000n, text: '%d %% %s', load: false },
    ];
    // Mark x3 as string literal in addressRefs via ldr/mov or call args
    model.calls = [{
      row: 3,
      name: '__sprintf_chk',
      target: 0x200000n,
      args: [
        { index: 3, value: { kind: 'string', text: '%d %% %s' } },
      ],
      api: { id: 'sprintf_chk', formatArg: 3, variadic: true },
    }];
    const code = decompiledText(decompileLegacy(model, opts));
    const m = /sprintf_chk\(([^)]*)\)/.exec(code);
    assert.ok(m, `expected sprintf_chk call:\n${code}`);
    const argList = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    assert.equal(argList.length, 6, `expected 6 args (4 fixed + 2 format specs excluding %%), got ${argList.length}:\n${code}`);
  }

  // Variadic __sprintf_chk with completely empty call.args and no format literal -> falls back to min arity 4
  {
    const { model, opts } = makeLegacyModel([
      'b #0x200000',
    ], { symbols: new Map([[0x200000n, '__sprintf_chk']]) });
    model.calls = [{
      row: 0,
      name: '__sprintf_chk',
      target: 0x200000n,
      args: [],
      api: { id: 'sprintf_chk', formatArg: 3, variadic: true },
    }];
    const code = decompiledText(decompileLegacy(model, opts));
    const m = /sprintf_chk\(([^)]*)\)/.exec(code);
    assert.ok(m, `expected sprintf_chk call:\n${code}`);
    const argList = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    assert.equal(argList.length, 4, `expected min arity 4 args for sprintf_chk, got ${argList.length}:\n${code}`);
  }
});

test('Fix 3a (idx=798): loop induction x0 advances instead of resetting to a1 + 4 and initializes x0 = a1 at entry', () => {
  // Entry checks w1 <= 0 -> exit; loop reads [x0], adds x0 += 4, decrements w1, loops back
  const { model, opts } = makeLegacyModel([
    'mov w2, #0',           // 0x100000
    'cmp w1, #0',           // 0x100004
    'b.le #0x100020',       // 0x100008
    'ldr w3, [x0]',         // 0x10000c (loop header)
    'add w2, w2, w3',       // 0x100010
    'add x0, x0, #4',       // 0x100014
    'subs w1, w1, #1',      // 0x100018
    'b.ne #0x10000c',       // 0x10001c (back-edge)
    'mov w0, w2',           // 0x100020 (exit)
    'ret',                  // 0x100024
  ]);

  const vg = buildValues(model);
  const loopX0 = vg.at(3, 'x0');
  assert.equal(loopX0?.k, 'reg', `x0 at loop header must be regNode, not arg(0): ${JSON.stringify(loopX0)}`);
  assert.equal(loopX0?.reg, 'x0');

  const code = decompiledText(decompileLegacy(model, opts));
  assert.match(code, /\bx0 = a1;/, `must initialize x0 = a1 at function entry:\n${code}`);
  assert.match(code, /\bx0 = x0 \+ 4;/, `loop must advance x0 = x0 + 4, not a1 + 4:\n${code}`);
  assert.doesNotMatch(code, /\bx0 = a1 \+ 4;/, `loop must NOT reset x0 = a1 + 4:\n${code}`);
  assert.match(code, /\bx1 = a2;/, `must initialize loop counter x1 = a2 at function entry:\n${code}`);
});

test('Fix 3b (idx=798): inferFpReturnType treats fmov/scvtf/ucvtf reading x0 into v0 as consuming x0', () => {
  for (const [label, convInsn, expectedRet] of [
    ['scvtf double', 'scvtf d0, x0', 'double'],
    ['fmov double', 'fmov d0, x0', 'double'],
    ['ucvtf float', 'ucvtf s0, w0', 'float'],
  ]) {
    const { model, opts } = makeLegacyModel([
      'add x0, x0, #1',
      convInsn,
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    assert.equal(res.types.ret?.type, expectedRet, `${label}: expected return type ${expectedRet}, got ${res.types.ret?.type}`);
    const code = decompiledText(res);
    assert.match(code, new RegExp(`^${expectedRet}\\s+func0\\b`), `${label}: expected ${expectedRet} signature:\n${code}`);
  }
});

test('Fix 4a (idx=1086): preserves live-out non-canonical register copy (mov w3, w1) in loop block', () => {
  // In loop: w1 = w1 + 1, cmp w1, w2 (uses V before mov), mov w3, w1 (copies V into live-out x3), b.lt loop
  const { model, opts } = makeLegacyModel([
    'mov w1, #0',           // 0x100000
    'mov w3, #0',           // 0x100004
    'add w1, w1, #1',       // 0x100008 (loop header)
    'cmp w1, w0',           // 0x10000c (firstUse of V in w1 -> canonical is row 2, reg x1)
    'mov w3, w1',           // 0x100010 (non-canonical copy of V into x3, live-out to exit/loop)
    'b.lt #0x100008',       // 0x100014
    'mov w0, w3',           // 0x100018 (exit reads x3)
    'ret',                  // 0x10001c
  ]);

  const code = decompiledText(decompileLegacy(model, opts));
  assert.match(code, /\bx3\s*=\s*x1\b/, `must NOT drop live-out copy mov w3, w1:\n${code}`);
});

test('Fix 4b (idx=1086): widens smull/umull operands to 64-bit to avoid 32-bit shift-count-overflow UB', () => {
  {
    const { model, opts } = makeLegacyModel([
      'smull x8, w0, w1',
      'lsr x0, x8, #34',
      'ret',
    ]);
    const vg = buildValues(model);
    const rendered = renderExpr(vg.defAt(0, 'x8'));
    assert.match(rendered, /\(int64\)\(int32\)/, `expected 64-bit widened signed smull operands: ${rendered}`);

    const code = decompiledText(decompileLegacy(model, opts));
    assert.match(code, /\(int64\)\(int32\)/, `decompiled smull must widen to int64:\n${code}`);
    checkGccSyntax(code, 'smull>>34', ['-Werror=shift-count-overflow']);
  }

  {
    const { model, opts } = makeLegacyModel([
      'umull x8, w0, w1',
      'lsr x0, x8, #34',
      'ret',
    ]);
    const vg = buildValues(model);
    const rendered = renderExpr(vg.defAt(0, 'x8'));
    assert.match(rendered, /\(uint64\)\(uint32\)/, `expected 64-bit widened unsigned umull operands: ${rendered}`);

    const code = decompiledText(decompileLegacy(model, opts));
    assert.match(code, /\(uint64\)\(uint32\)/, `decompiled umull must widen to uint64:\n${code}`);
    checkGccSyntax(code, 'umull>>34', ['-Werror=shift-count-overflow']);
  }
});
