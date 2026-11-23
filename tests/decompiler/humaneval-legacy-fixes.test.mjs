import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompile as decompileLegacy, decompiledText } from '../../js/decompile-legacy.js';
import { inferTypes } from '../../js/types-legacy.js';

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
    rowOfAddress: opts.omitModelRowOfAddress ? undefined : rowOfAddress,
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
      rowOfAddress: opts.omitDecompileRowOfAddress ? undefined : rowOfAddress,
      beginner: false,
      ...opts,
    },
  };
}

function checkGccSyntax(cCode, label, headers = [], extraPreamble = '') {
  const inc = headers.map((h) => `#include <${h}>`).join('\n');
  const wrapped = `${inc}\n#include <stdint.h>\n#define __asm(x) ((void)0)\ntypedef unsigned long long uint64;\ntypedef long long int64;\ntypedef unsigned int uint32;\ntypedef int int32;\ntypedef unsigned short uint16;\ntypedef short int16;\ntypedef unsigned char uint8;\ntypedef signed char int8;\ntypedef unsigned __int128 uint128;\n${extraPreamble}\n${cCode}\n`;
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

test('Fix 1: callStatement emits bare statement / tail return for void calls (free, free@plt)', () => {
  // Regular void call (_free): emits free(a1); — never x0 = free(a1);
  {
    const { model, opts } = makeModel([
      'stp x29, x30, [sp, #-0x10]!',
      'mov x29, sp',
      'bl #0x200000',
      'mov w0, #0',
      'ldp x29, x30, [sp], #0x10',
      'ret',
    ], { symbols: new Map([[0x200000n, '_free']]) });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bfree\([^)]+\);/, `expected bare free(...) call:\n${code}`);
    assert.doesNotMatch(code, /=\s*free\(/, `void call free() must not be assigned:\n${code}`);
    checkGccSyntax(code, 'void_call_free', ['stdlib.h']);
  }

  // PLT-decorated void call (free@plt): still recognized as void, never assigned
  {
    const { model, opts } = makeModel([
      'stp x29, x30, [sp, #-0x10]!',
      'mov x29, sp',
      'bl #0x200000',
      'mov w0, #0',
      'ldp x29, x30, [sp], #0x10',
      'ret',
    ], { symbols: new Map([[0x200000n, 'free@plt']]) });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bfree_plt\([^)]+\);/, `expected bare free_plt(...) call:\n${code}`);
    assert.doesNotMatch(code, /=\s*free_plt\(/, `void call free@plt must not be assigned:\n${code}`);
  }

  // Tail void call: b _free -> free(a1); return; (never return free(a1);)
  {
    const { model, opts } = makeModel([
      'b #0x200000',
    ], { symbols: new Map([[0x200000n, '_free']]) });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bfree\([^)]+\);\s*return;/, `expected tail void call "free(...); return;":\n${code}`);
    assert.doesNotMatch(code, /return\s+free\(/, `tail void call must not emit "return free(...)":\n${code}`);
  }

  // Non-void call still assigns return value (e.g. malloc)
  {
    const { model, opts } = makeModel([
      'stp x29, x30, [sp, #-0x10]!',
      'mov x29, sp',
      'bl #0x200010',
      'ldp x29, x30, [sp], #0x10',
      'ret',
    ], { symbols: new Map([[0x200010n, '_malloc']]) });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /=\s*malloc\(/, `non-void malloc() should still assign x0:\n${code}`);
  }
});

test('Fix 2: linear mode lowers in-function PC-relative branches to goto/labels without raw __asm', () => {
  // Case A: linear mode (triggered by disconnected block after br x8) with b.le, cbz, tbz, tbnz, b
  // and rowOfAddress omitted from decompile opts (exercises byAddr fallback)
  {
    const base = 0x790n;
    const { model, opts } = makeModel([
      'cmp w0, #0',             // 0x790 (row 0)
      'b.le #0x7a8',            // 0x794 (row 1) -> row 6
      'cbz w1, #0x7ac',         // 0x798 (row 2) -> row 7
      'tbz w0, #0, #0x7b0',     // 0x79c (row 3) -> row 8
      'br x8',                  // 0x7a0 (row 4) -> indirect branch forces linear mode
      'b #0x7b8',               // 0x7a4 (row 5) -> row 10
      'mov w0, #1',             // 0x7a8 (row 6)
      'mov w0, #2',             // 0x7ac (row 7)
      'tbnz w1, #1, #0x7b8',    // 0x7b0 (row 8) -> row 10 (non-fallthrough)
      'mov w0, #3',             // 0x7b4 (row 9)
      'ret',                    // 0x7b8 (row 10)
    ], {
      addr: base,
      omitDecompileRowOfAddress: true,
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.equal(res.coverage.mode, 'linear', `expected linear mode:\n${code}`);
    assert.doesNotMatch(code, /__asm\("b\.le/, `b.le must not remain raw __asm:\n${code}`);
    assert.doesNotMatch(code, /__asm\("cbz/, `cbz must not remain raw __asm:\n${code}`);
    assert.doesNotMatch(code, /__asm\("tbz/, `tbz must not remain raw __asm:\n${code}`);
    assert.doesNotMatch(code, /__asm\("tbnz/, `tbnz must not remain raw __asm:\n${code}`);
    assert.doesNotMatch(code, /__asm\("b #/, `b must not remain raw __asm:\n${code}`);
    assert.match(code, /__asm\("br x8"\)/, `indirect br x8 must remain __asm:\n${code}`);
    assert.match(code, /goto loc_7A8;/, `expected goto loc_7A8:\n${code}`);
    assert.match(code, /loc_7A8:/, `expected label loc_7A8:\n${code}`);
    assert.match(code, /goto loc_7AC;/, `expected goto loc_7AC:\n${code}`);
    assert.match(code, /loc_7AC:/, `expected label loc_7AC:\n${code}`);
    assert.match(code, /goto loc_7B0;/, `expected goto loc_7B0:\n${code}`);
    assert.match(code, /loc_7B0:/, `expected label loc_7B0:\n${code}`);
    assert.match(code, /goto loc_7B8;/, `expected goto loc_7B8:\n${code}`);
    assert.match(code, /loc_7B8:/, `expected label loc_7B8:\n${code}`);
    checkGccSyntax(code, 'linear_pcrel_branches_block_leaders', [], 'uint64 x0 = 0;');
  }

  // Case B: mid-block branch targets (when buildBasicBlocks ran without rowOfAddress)
  {
    const base = 0x880n;
    const { model, opts } = makeModel([
      'cmp w0, #5',             // 0x880 (row 0)
      'b.le #0x890',            // 0x884 (row 1) -> row 4 (mid-block!)
      'mov w0, #10',            // 0x888 (row 2)
      'add w0, w0, #1',         // 0x88c (row 3)
      'cbz w0, #0x898',         // 0x890 (row 4) -> row 6 (mid-block!)
      'mov w0, #20',            // 0x894 (row 5)
      'ret',                    // 0x898 (row 6)
    ], {
      addr: base,
      omitModelRowOfAddress: true,
      omitDecompileRowOfAddress: true,
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.doesNotMatch(code, /__asm\("b\.le/, `mid-block b.le must not remain raw __asm:\n${code}`);
    assert.doesNotMatch(code, /__asm\("cbz/, `mid-block cbz must not remain raw __asm:\n${code}`);
    assert.match(code, /goto loc_890;/, `expected goto loc_890:\n${code}`);
    assert.match(code, /loc_890:/, `expected mid-block label loc_890:\n${code}`);
    assert.match(code, /goto loc_898;/, `expected goto loc_898:\n${code}`);
    assert.match(code, /loc_898:/, `expected mid-block label loc_898:\n${code}`);
    checkGccSyntax(code, 'linear_pcrel_branches_mid_block', [], 'uint64 x0 = 0;');
  }
});

test('Fix 3: blocks-base preserves pass-through x0..x(arity-1) for fixed-arity calls before prior call clobber', () => {
  // Pass-through x0 into bl strtod@plt (x1 is written, x0 is untouched)
  {
    const { model } = makeModel([
      'stp x29, x30, [sp, #-0x10]!',
      'mov x29, sp',
      'mov x1, #0',
      'bl #0x200020',
      'fcvtms w0, d0',
      'ldp x29, x30, [sp], #0x10',
      'ret',
    ], { symbols: new Map([[0x200020n, 'strtod@plt']]) });
    assert.ok(model.argRegs.includes(0), `expected pass-through x0 in argRegs, got ${JSON.stringify(model.argRegs)}`);
    assert.ok(!model.argRegs.includes(1), `x1 was written before strtod, must not be in argRegs, got ${JSON.stringify(model.argRegs)}`);
  }

  // Prior call clobbers x0..x7: second call must NOT mark unwritten x0 as incoming arg
  {
    const { model } = makeModel([
      'stp x29, x30, [sp, #-0x10]!',
      'mov x29, sp',
      'bl #0x200030',
      'bl #0x200040',
      'ldp x29, x30, [sp], #0x10',
      'ret',
    ], {
      symbols: new Map([
        [0x200030n, 'rand@plt'],
        [0x200040n, 'strlen@plt'],
      ]),
    });
    assert.ok(!model.argRegs.includes(0), `post-call x0 must not be marked as incoming arg, got ${JSON.stringify(model.argRegs)}`);
  }

  // FP-only fixed-arity call (sin(double)) must NOT mark x0 as incoming GP arg
  {
    const { model } = makeModel([
      'stp x29, x30, [sp, #-0x10]!',
      'mov x29, sp',
      'bl #0x200050',
      'ldp x29, x30, [sp], #0x10',
      'ret',
    ], { symbols: new Map([[0x200050n, 'sin@plt']]) });
    assert.ok(!model.argRegs.includes(0), `FP-only sin() must not mark x0 in argRegs, got ${JSON.stringify(model.argRegs)}`);
  }
});

test('Fix 4: types-legacy classifies float-to-int conversions (fcvtms/fcvtps/fcvtzs/fcvtzu) as integer returns, not double', () => {
  for (const [mn, dstReg, expectedType] of [
    ['fcvtms', 'w0', 'int32'],
    ['fcvtps', 'w0', 'int32'],
    ['fcvtzs', 'w0', 'int32'],
    ['fcvtas', 'w0', 'int32'],
    ['fcvtns', 'w0', 'int32'],
    ['fcvtzu', 'w0', 'uint32'],
    ['fcvtzs', 'x0', 'int64'],
    ['fcvtms', 'x0', 'int64'],
    ['fcvtzu', 'x0', 'uint64'],
  ]) {
    const { model } = makeModel([
      `${mn} ${dstReg}, d0`,
      'ret',
    ]);
    const types = inferTypes(model);
    assert.equal(types.ret.type, expectedType, `${mn} ${dstReg}, d0 should infer ${expectedType}, got ${types.ret.type}`);
  }

  // End-to-end idx=1054 pattern: mov x1, #0; bl strtod@plt; fcvtms w0, d0; ret
  {
    const { model, opts } = makeModel([
      'stp x29, x30, [sp, #-0x10]!',
      'mov x29, sp',
      'mov x1, #0',
      'bl #0x200020',
      'fcvtms w0, d0',
      'ldp x29, x30, [sp], #0x10',
      'ret',
    ], { symbols: new Map([[0x200020n, 'strtod@plt']]) });
    const res = decompileLegacy(model, opts);
    assert.equal(res.types.ret.type, 'int32', `expected int32 return type, got ${res.types.ret.type}`);
    assert.ok(res.types.args.some((a) => a.index === 0), `expected arg 0 in signature, got ${JSON.stringify(res.types.args)}`);
    assert.match(res.signature, /^int32 func0\(/, `expected int32 signature, got ${res.signature}`);
  }
});
