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

test('Group 1A: invalidateDependents preserves evicted def via prevDef instead of silently deleting it (658/1106 regression)', () => {
  // Loop join makes x0 a regNode; x8 = x0 + 1; then x0 is clobbered before x8 is consumed.
  const { model, opts } = makeModel([
    'cbz x0, #0x100020',     // 0: 0x100000
    'add x8, x0, #1',        // 1: 0x100004 (loop body / join target)
    'add x0, x0, #2',        // 2: 0x100008 (clobbers x0 -> evicts x8 with prevDef)
    'add x1, x8, #3',        // 3: 0x10000c (consumes evicted x8)
    'subs x2, x2, #1',       // 4: 0x100010
    'b.ne #0x100004',        // 5: 0x100014 (back-edge makes row 1 a join!)
    'mov x0, x1',            // 6: 0x100018
    'ret',                   // 7: 0x10001c
    'mov x0, #0',            // 8: 0x100020
    'ret',                   // 9: 0x100024
  ], { name: 'evict_prevdef_fn' });

  const vg = buildValues(model, {});
  const x8AtRow3 = vg.at(3, 'x8');
  assert.equal(x8AtRow3.k, 'reg', 'x8 should be evicted to a regNode after x0 clobber');
  assert.ok(x8AtRow3.prevDef, 'evicted regNode must carry prevDef pointing to the pre-clobber def');

  const res = decompileLegacy(model, opts);
  const code = decompiledText(res);
  // The pre-clobber definition `x8 = x0 + 1;` MUST be materialized before `x0 = x0 + 2;`
  const defIdx = code.indexOf('x0 + 1');
  const clobberIdx = code.indexOf('x0 + 2');
  assert.ok(defIdx >= 0, `expected x8 = x0 + 1 to be materialized (not silently deleted):\n${code}`);
  assert.ok(clobberIdx >= 0, `expected x0 = x0 + 2 to be present:\n${code}`);
  assert.ok(defIdx < clobberIdx, `expected x8 def before x0 clobber:\n${code}`);
  const closed = { ...res, pseudocode: code };
  closeFunctionOutput(closed);
  checkGccSyntax(closed.pseudocode, 'Group 1A evict_prevdef_fn');
});

test('Group 1B: store-load aliasing materializes non-rodata load before intervening store (778/790/994)', () => {
  const { model, opts } = makeModel([
    'ldr w8, [x0]',          // 0: load before store
    'str w1, [x0]',          // 1: intervening store -> must invalidate x8 with prevDef
    'add w0, w8, #5',        // 2: uses pre-store value of w8
    'ret',                   // 3
  ], { name: 'store_load_alias_fn' });

  const vg = buildValues(model, {});
  const x8AtRow2 = vg.at(2, 'x8');
  assert.equal(x8AtRow2.k, 'reg', 'load in x8 must be evicted after intervening store');
  assert.ok(x8AtRow2.prevDef, 'evicted load must retain prevDef');

  const res = decompileLegacy(model, opts);
  const code = decompiledText(res);
  const loadLine = code.indexOf('*(uint32 *)');
  const storeLine = code.indexOf('= (uint32)a2');
  const altStoreLine = code.indexOf('= a2');
  const actualStoreLine = storeLine >= 0 ? storeLine : altStoreLine;
  assert.ok(loadLine >= 0, `expected load to be materialized:\n${code}`);
  assert.ok(actualStoreLine >= 0, `expected store to be present:\n${code}`);
  assert.ok(loadLine < actualStoreLine, `load MUST be materialized before store (not inlined after store):\n${code}`);
  const closed = { ...res, pseudocode: code };
  closeFunctionOutput(closed);
  checkGccSyntax(closed.pseudocode, 'Group 1B store_load_alias_fn');
});

test('Group 1C: nonCanonical copy feeding post-index memory op and raw-register fallback lost sync (678/718/806)', () => {
  // Post-index base copy: mov x4, x0; ldrb w8, [x4], #1
  {
    const { model, opts } = makeModel([
      'mov x4, x0',            // 0: non-canonical arg copy
      'ldrb w8, [x4], #1',     // 1: post-index load reading/writing x4
      'add w0, w8, #1',        // 2
      'ret',                   // 3
    ], { name: 'postindex_copy_fn' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bx4\s*=\s*a1;/, `expected mov x4, x0 copy to be materialized before post-index op:\n${code}`);
    const copyIdx = code.indexOf('x4 = a1;');
    const wbIdx = code.indexOf('x4 = x4 + 1;');
    assert.ok(wbIdx > copyIdx, `expected x4 = a1 before x4 = x4 + 1:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Group 1C postindex_copy_fn');
  }

  // Raw-register fallback (sbfiz -> __asm) forces read register into lost so x0 is not split to x0_1
  {
    const { model, opts } = makeModel([
      'add x0, x0, #1',        // 0: first def of x0, read by raw-register fallback sbfiz
      'sbfiz x1, x0, #2, #8',  // 1: unmodeled fallback -> __asm reading x0
      'add x0, x1, #3',        // 2: second def of x0
      'ret',                   // 3
    ], { name: 'raw_fallback_lost_fn' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bx0\s*=\s*a1 \+ 1;/, `expected producer feeding raw fallback to assign to x0 (not x0_1):\n${code}`);
    assert.doesNotMatch(code, /\bx0_1\s*=/, `must not split x0 into x0_1 when raw fallback reads x0:\n${code}`);
  }
});

test('Group 2A: condSymbol mi/pl emits valid C ternary (fixes 1286 recomp & 730) and condText includes rhs', () => {
  // Integer cmp + csel mi / pl
  {
    const { model, opts } = makeModel([
      'cmp w0, w1',            // 0
      'csel w8, w2, w3, mi',   // 1: ((int32)(a1) - (int32)(a2)) < 0 ? ...
      'cmp w0, w1',            // 2
      'csel w9, w2, w3, pl',   // 3: ((int32)(a1) - (int32)(a2)) >= 0 ? ...
      'add w0, w8, w9',        // 4
      'ret',                   // 5
    ], { name: 'int_mi_pl_csel' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.doesNotMatch(code, /<\s*0\s+(?:a2|\(uint32\)|\(int32\))/, `must not emit malformed '< 0 rhs':\n${code}`);
    assert.doesNotMatch(code, />=\s*0\s+(?:a2|\(uint32\)|\(int32\))/, `must not emit malformed '>= 0 rhs':\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Group 2A int_mi_pl_csel');
  }

  // FP fcmp + csel mi / pl
  {
    const { model, opts } = makeModel([
      'fcmp d0, d1',           // 0
      'csel w0, w1, w2, mi',   // 1: d0 < d1 ? ...
      'ret',                   // 2
    ], { name: 'fp_mi_csel' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /a4\s*<\s*a5|v0\s*<\s*v1/, `expected fcmp mi to lower to '<':\n${code}`);
    assert.doesNotMatch(code, /<\s*0\s+/, `must not emit '< 0' for fcmp mi:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Group 2A fp_mi_csel');
  }

  // Branch condText for cmp + b.mi includes rhs
  {
    const { model, opts } = makeModel([
      'cmp w0, w1',            // 0: 0x100000
      'b.mi #0x100010',        // 1: 0x100004
      'mov w0, #1',            // 2: 0x100008
      'ret',                   // 3: 0x10000c
      'mov w0, #0',            // 4: 0x100010
      'ret',                   // 5: 0x100014
    ], { name: 'branch_mi_rhs' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /-\s*\(int32\)\(\(int32\)\(a2\)\)\)\s*<\s*0/, `expected b.mi to subtract rhs:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Group 2A branch_mi_rhs');
  }
});

test('Group 2B & 2C: signed 32-bit max/csel (1094/1270) and cneg/cinv/cinc (1238/1262)', () => {
  // Signed 32-bit max
  {
    const { model, opts } = makeModel([
      'cmp w0, w1',            // 0
      'csel w0, w0, w1, gt',   // 1
      'ret',                   // 2
    ], { name: 'signed_max32' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /max\(\(int32\)a1,\s*\(int32\)a2\)/, `expected signed int32 casts in max():\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Group 2B signed_max32');
  }

  // cneg, cinv, cinc
  {
    const { model, opts } = makeModel([
      'cmp w0, #0',            // 0
      'cneg w8, w0, lt',       // 1: (int32)a1 < 0 ? -a1 : a1
      'cmp w1, #0',            // 2
      'cinv w9, w1, eq',       // 3: ~a2 : a2
      'cmp w2, #0',            // 4
      'cinc w10, w2, ne',      // 5: a3 + 1 : a3
      'add w0, w8, w9',        // 6
      'add w0, w0, w10',       // 7
      'ret',                   // 8
    ], { name: 'cneg_cinv_cinc_fn' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\?\s*-/, `expected cneg negation in ternary:\n${code}`);
    assert.match(code, /\?\s*~/, `expected cinv bitwise-not in ternary:\n${code}`);
    assert.match(code, /\+\s*1/, `expected cinc increment in ternary:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Group 2C cneg_cinv_cinc_fn');
  }
});

test('Group 2D: ands/tst lowers directly without Z_ands32 and subs in-place decrement compares against 0 (1306)', () => {
  // ands + cset eq
  {
    const { model, opts } = makeModel([
      'ands w8, w0, #1',       // 0
      'cset w0, eq',           // 1
      'ret',                   // 2
    ], { name: 'ands_cset_fn' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.doesNotMatch(code, /\bZ_ands\d*\b/, `must not emit undefined Z_ands32 helper:\n${code}`);
    assert.match(code, /&\s*1\)\s*==\s*0|&\s*\(1\)\)\s*==\s*0/, `expected direct bitwise-and == 0:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Group 2D ands_cset_fn');
  }

  // subs w2, w2, #1; b.ne loop -> compares x2 != 0 (not != 1)
  {
    const { model, opts } = makeModel([
      'mov w8, #0',            // 0: 0x100000
      'add w8, w8, #3',        // 1: 0x100004 (loop header)
      'subs w2, w2, #1',       // 2: 0x100008
      'b.ne #0x100004',        // 3: 0x10000c
      'mov w0, w8',            // 4: 0x100010
      'ret',                   // 5: 0x100014
    ], { name: 'subs_inplace_loop' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\(int32\)\(\w+\)\s*!=\s*0/, `expected in-place subs loop condition to compare != 0:\n${code}`);
    assert.doesNotMatch(code, /!=\s*1\b/, `must not emit off-by-one != 1 for in-place subs:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Group 2D subs_inplace_loop');
  }
});

test('Group 3: CFG-aware findCompare (742/974/1218), rodata integer decode (974), frameOf baseReg (994), and FP fsqrt/frint/fcvt + isFpFromX0 (942/1026/1054/1262)', () => {
  // 3A. CFG-aware findCompare: unrelated branch arm with cmp w1, #99 must NOT bleed into block 2
  {
    const { model, opts } = makeModel([
      'cmp w0, #0',            // 0: 0x100000 (block 0)
      'b.eq #0x100014',        // 1: 0x100004 -> jumps to block 2 (0x100014)
      'cmp w1, #99',           // 2: 0x100008 (block 1 - NOT a predecessor of block 2!)
      'mov w0, #7',            // 3: 0x10000c
      'ret',                   // 4: 0x100010
      'b.lt #0x100020',        // 5: 0x100014 (block 2 - unique predecessor is block 0!)
      'mov w0, #1',            // 6: 0x100018
      'ret',                   // 7: 0x10001c
      'mov w0, #2',            // 8: 0x100020
      'ret',                   // 9: 0x100024
    ], { name: 'cfg_findcompare_fn' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    const afterLoc = code.slice(code.indexOf('loc_100014:'));
    assert.match(afterLoc, /if\s*\(\(int32\)\(a1\)\s*<\s*0\)/, `expected block 2 to inherit block 0 cmp w0, #0:\n${code}`);
    assert.doesNotMatch(afterLoc, /0x63|99/, `unrelated block 1 cmp w1, #99 must NOT bleed into block 2:\n${code}`);
  }

  // 3B. .rodata integer decode (uint8 & int32)
  {
    const { model, opts } = makeModel([
      'adrp x8, #0x0',         // 0
      'ldrb w0, [x8, #0x98a]', // 1
      'ret',                   // 2
    ], { name: 'rodata_u8_fn' });
    const ref1 = model.addressRefs.find((r) => r.row === 1);
    assert.ok(ref1, 'expected addressRef on row 1');
    ref1.bytes = new Uint8Array([0x2a]);
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /return\s+(?:\(uint32\))?(?:0x2A|42);/, `expected rodata uint8 0x2A to be decoded:\n${code}`);
    assert.doesNotMatch(code, /\*\(\s*uint8\s*\*\)\s*0x98A/, `must not emit raw *(uint8 *)0x98A:\n${code}`);
  }

  // 3C. frameOf recognizes pre-index stp x29, x30, [sp, #-0x20]!
  {
    const { model, opts } = makeModel([
      'stp x29, x30, [sp, #-0x20]!', // 0
      'mov x29, sp',                 // 1
      'str w0, [sp, #0x1c]',         // 2
      'ldr w0, [sp, #0x1c]',         // 3
      'ldp x29, x30, [sp], #0x20',   // 4
      'ret',                         // 5
    ], { name: 'preindex_frame_fn' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /var_/, `expected stack slot to be named via frameOf:\n${code}`);
  }

  // 3D. FP fsqrt, frint*, fcvt*, and isFpFromX0 with non-v0 register (d1)
  {
    const { model, opts } = makeModel([
      'scvtf d1, w0',          // 0: converts x0 into d1 (non-v0!)
      'fsqrt d0, d1',          // 1: sqrt(d1)
      'frintm d0, d0',         // 2: floor(d0)
      'ret',                   // 3
    ], { name: 'fp_sqrt_floor_fn' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bdouble\s+fp_sqrt_floor_fn\b/, `expected double return type via isFpFromX0 (d1):\n${code}`);
    assert.match(code, /\bsqrt\(/, `expected fsqrt to lift to sqrt():\n${code}`);
    assert.match(code, /\bfloor\(/, `expected frintm to lift to floor():\n${code}`);
    assert.doesNotMatch(code, /__asm\(/, `must not emit __asm for fsqrt/frintm:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Group 3D fp_sqrt_floor_fn', ['math.h']);
  }

  {
    const { model, opts } = makeModel([
      'frintp s1, s0',         // 0: ceilf
      'frintz s1, s1',         // 1: truncf
      'frinta s1, s1',         // 2: roundf
      'fcvtms w8, d0',         // 3: (int32)floor(d0)
      'fcvtps w9, s1',         // 4: (int32)ceilf(s1)
      'add w0, w8, w9',        // 5
      'ret',                   // 6
    ], { name: 'fp_frint_fcvt_fn' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bceilf\(/, `expected frintp/fcvtps to lift to ceilf():\n${code}`);
    assert.match(code, /\btruncf\(/, `expected frintz to lift to truncf():\n${code}`);
    assert.match(code, /\broundf\(/, `expected frinta to lift to roundf():\n${code}`);
    assert.match(code, /\bfloor\(/, `expected fcvtms to lift to floor():\n${code}`);
    assert.doesNotMatch(code, /__asm\(/, `must not emit __asm for frint*/fcvt*:\n${code}`);
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Group 3D fp_frint_fcvt_fn', ['math.h']);
  }
});
