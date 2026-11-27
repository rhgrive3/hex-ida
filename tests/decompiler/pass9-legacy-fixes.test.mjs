import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildValues } from '../../js/expr.js';
import { decompile as decompileLegacy, decompiledText } from '../../js/decompile-legacy.js';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';

function makeModel(lines, opts = {}) {
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

function checkGccSyntax(cCode, label, headers = [], extraPreamble = '') {
  const inc = headers.map((h) => `#include <${h}>`).join('\n');
  const wrapped = `${inc}\n#define __asm(x) ((void)0)\n${extraPreamble}\n${cCode}\n`;
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

test('Fix 1: unsigned conditions lo/ls/hi/hs/cc/cs cast operands to uint32/uint64 in condText (790)', () => {
  const unsignedBranches = [
    ['b.lo', '<'],
    ['b.ls', '<='],
    ['b.hi', '>'],
    ['b.hs', '>='],
    ['b.cc', '<'],
    ['b.cs', '>='],
  ];

  for (const [mn, op] of unsignedBranches) {
    const { model, opts } = makeModel([
      'cmp w0, w1',
      `${mn} #0x100010`,
      'mov w0, #1',
      'ret',
      'mov w0, #0',
      'ret',
    ], { name: `u32_${mn.replace('.', '_')}` });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(
      code.includes(`(uint32)((int32)(a1)) ${op} (uint32)((int32)(a2))`),
      `expected (uint32) cast for 32-bit ${mn}:\n${code}`
    );
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, `Fix 1 u32 ${mn}`);
  }

  for (const [mn, op] of [['b.lo', '<'], ['b.hi', '>'], ['b.ls', '<='], ['b.hs', '>=']]) {
    const { model, opts } = makeModel([
      'cmp x0, x1',
      `${mn} #0x100010`,
      'mov x0, #1',
      'ret',
      'mov x0, #0',
      'ret',
    ], { name: `u64_${mn.replace('.', '_')}` });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(
      code.includes(`(uint64)(a1) ${op} (uint64)(a2)`),
      `expected (uint64) cast for 64-bit ${mn}:\n${code}`
    );
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, `Fix 1 u64 ${mn}`);
  }

  // fcmp + b.lo must NOT cast floats to uint64
  {
    const { model, opts } = makeModel([
      'fcmp d0, d1',
      'b.lo #0x100010',
      'mov x0, #1',
      'ret',
      'mov x0, #0',
      'ret',
    ], { name: 'fcmp_lo_no_uint_cast' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(!code.includes('(uint64)'), `fcmp b.lo must not cast to uint64:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Fix 1 fcmp b.lo');
  }
});

test('Fix 2: ldurb/ldr* same-register base+dst resolves active SSA/versioned name x2_1 instead of pre-rename x2 (834)', () => {
  // 64-bit ldr x2, [x2, #-1] after x2_1 = x8 + x0 and an intervening x0 clobber (evicts x2 to regNode with prevDef)
  {
    const { model, opts } = makeModel([
      'cbz x0, #0x100024',
      'add x2, x8, x0',
      'add x0, x0, #1',
      'ldr x2, [x2, #-1]',
      'str x2, [x8]',
      'subs x9, x9, #1',
      'b.ne #0x100004',
      'mov x0, x2',
      'ret',
      'mov x0, #0',
      'ret',
    ], { name: 'ldr_same_reg_ssa' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(code.includes('x2_1 = x8 + x0;'), `expected x2_1 def:\n${code}`);
    assert.ok(
      code.includes('*(uint64 *)(x2_1 + -1)'),
      `expected ldr base to resolve to x2_1 instead of x2:\n${code}`
    );
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Fix 2 ldr_same_reg_ssa');
  }

  // 32-bit ldurb w2, [x2, #-1] with x2_1 = x8 + x0
  {
    const { model, opts } = makeModel([
      'cbz x0, #0x100024',
      'add x2, x8, x0',
      'add x0, x0, #1',
      'ldurb w2, [x2, #-1]',
      'strb w2, [x8]',
      'subs x9, x9, #1',
      'b.ne #0x100004',
      'mov x0, x2',
      'ret',
      'mov x0, #0',
      'ret',
    ], { name: 'ldurb_same_reg_ssa' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(code.includes('x2_1 = x8 + x0;'), `expected x2_1 def:\n${code}`);
    assert.ok(
      code.includes('*(uint8 *)(x2_1 + -1)'),
      `expected ldurb base to resolve to x2_1 instead of x2:\n${code}`
    );
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Fix 2 ldurb_same_reg_ssa');
  }
});

test('Fix 3: CALL_CLOBBER and register overwrite invalidate dependent aliases referencing x0 (974, 1306)', () => {
  // Case A: x0 is overwritten by mov x0, #5 while x20 holds x0 + 1
  {
    const { model, opts } = makeModel([
      'cbz x0, #0x100020',
      'add x20, x0, #1',
      'mov x0, #5',
      'str x0, [x8]',
      'subs x9, x9, #1',
      'b.ne #0x100004',
      'mov x0, x20',
      'ret',
      'mov x0, #0',
      'ret',
    ], { name: 'overwrite_x0_invalidates_x20' });
    const vg = buildValues(model, {});
    const x20AtRow6 = vg.at(6, 'x20');
    assert.equal(x20AtRow6.k, 'reg', 'x20 must be evicted after mov x0, #5');
    assert.equal(x20AtRow6.reg, 'x20', 'x20 must not remain an alias to clobbered x0');

    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(!code.includes('return x0 + 1;'), `must not rewrite x20 to clobbered x0:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Fix 3A overwrite_x0_invalidates_x20');
  }

  // Case B: CALL_CLOBBER (bl sprintf) even when x0 was deleted by a join (not in regs) while x20 holds x0 + 1
  {
    const symbols = new Map([[0x200000n, '_sprintf']]);
    const { model, opts } = makeModel([
      'cbz x1, #0x100028',
      'add x20, x0, #1',
      'b #0x100010',
      'nop',
      'mov x0, x8',
      'bl #0x200000',
      'mov x0, x20',
      'ret',
      'mov x0, #0',
      'ret',
    ], { name: 'call_clobber_x0_invalidates_x20', symbols });
    // Even if x0 is deleted from regs at join, x20 holding a1 or x0 expression must not become post-sprintf x0
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(!code.includes('sprintf(x8) + 1'), `must not use post-sprintf x0 for x20:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Fix 3B call_clobber_x0_invalidates_x20');
  }

  // Case C: direct CALL_CLOBBER evicts x20 when x20 holds regNode('x0') + 2 (non-arg x0 written in loop)
  {
    const symbols = new Map([[0x200000n, '_sprintf']]);
    const { model, opts } = makeModel([
      'cbz x0, #0x10002c',
      'add x0, x0, #1',
      'subs x9, x9, #1',
      'b.ne #0x100004',
      // After loop, x0 was everWritten so x0 is regNode('x0')
      'add x20, x0, #2',
      'bl #0x200000',
      'add x0, x20, #3',
      'ret',
      'mov x0, #0',
      'ret',
    ], { name: 'call_clobber_evict_x20', symbols });
    const vg = buildValues(model, {});
    const x20AfterCall = vg.at(6, 'x20');
    assert.equal(x20AfterCall.k, 'reg');
    assert.equal(x20AfterCall.reg, 'x20');
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(!code.includes('sprintf() +'), `must not rewrite x20 to sprintf() return:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Fix 3C call_clobber_evict_x20');
  }
});

test('Fix 4: .rodata base+offset lookup (adrp+add+offset -> "db"[2]) decodes integer byte instead of *(uint8 *)0x98A (974)', () => {
  const { model, opts } = makeModel([
    'adrp x2, #0x0',
    'add x2, x2, #0x988',
    'ldrb w2, [x2, #2]',
    'mov w0, w2',
    'ret',
  ], {
    name: 'rodata_base_plus_offset',
    stringFor: (addr) => (BigInt(addr) === 0x988n ? 'db' : null),
  });
  // Ensure model.addressRefs has the base ref at 0x988 with text 'db' (and no bytes on ldrb row 2)
  model.addressRefs = [
    { row: 1, addr: 0x988n, value: 0x988n, text: 'db' },
    { row: 2, addr: 0x98An, value: 0x98An, load: true },
  ];
  const res = decompileLegacy(model, opts);
  const code = decompiledText(res);
  assert.ok(!code.includes('0x98A'), `must not emit raw *(uint8 *)0x98A:\n${code}`);
  assert.ok(/return (?:\(uint32\))?0;/.test(code), `expected "db"[2] to decode to 0:\n${code}`);
  const closed = { ...res, pseudocode: code };
  closeFunctionOutput(closed);
  checkGccSyntax(closed.pseudocode, 'Fix 4 rodata_base_plus_offset');

  // Also test offset 1 -> 'b' (0x62)
  const { model: m2, opts: o2 } = makeModel([
    'adrp x2, #0x0',
    'add x2, x2, #0x988',
    'ldrb w2, [x2, #1]',
    'mov w0, w2',
    'ret',
  ], { name: 'rodata_base_plus_offset_1' });
  m2.addressRefs = [
    { row: 1, addr: 0x988n, value: 0x988n, text: 'db' },
  ];
  const res2 = decompileLegacy(m2, o2);
  const code2 = decompiledText(res2);
  assert.ok(code2.includes('0x62'), `expected "db"[1] to decode to 0x62 ('b'):\n${code2}`);
  const closed2 = { ...res2, pseudocode: code2 };
  closeFunctionOutput(closed2);
  checkGccSyntax(closed2.pseudocode, 'Fix 4 rodata_base_plus_offset_1');
});

test('Fix 5: rev64 vD.2s, vN.2s lowers to C 32-bit half-swap using uint64_t/memcpy without __asm (1238)', () => {
  const { model, opts } = makeModel([
    'rev64 v0.2s, v1.2s',
    'ret',
  ], { name: 'rev64_2s_fn' });
  const res = decompileLegacy(model, opts);
  const code = decompiledText(res);
  assert.ok(!code.includes('__asm'), `must not emit raw __asm for rev64 v0.2s, v1.2s:\n${code}`);
  assert.ok(code.includes('uint64_t') && code.includes('memcpy'), `expected uint64_t/memcpy 32-bit half-swap:\n${code}`);
  assert.ok(code.includes('>> 32') && code.includes('<< 32'), `expected 32-bit half-swap shifts:\n${code}`);
  const closed = { ...res, pseudocode: code };
  closeFunctionOutput(closed);
  checkGccSyntax(closed.pseudocode, 'Fix 5 rev64_2s_fn');
});
