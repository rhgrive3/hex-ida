import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildSemanticModel } from '../../js/blocks.js';
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

test('Fix 1: decideMaterial preserves prevDef of call arguments instead of DCE-dropping add x2, x0, #1 before bl memcpy (1106)', () => {
  const symbols = new Map([
    [0x200000n, '_strlen'],
    [0x200004n, '_memcpy'],
  ]);
  const { model, opts } = makeModel([
    'mov x19, x0',
    'mov x20, x1',
    'bl #0x200000',       // x0 = strlen(a1)
    'add x2, x0, #1',     // x2 = x0 + 1 (depends on x0)
    'mov x0, x20',        // overwrites x0 -> evicts x2 with prevDef = add(x0, 1)
    'mov x1, x19',
    'bl #0x200004',       // memcpy(a2, a1, x2)
    'ret',
  ], { name: 'call_arg_prevdef_memcpy', symbols });

  const res = decompileLegacy(model, opts);
  const code = decompiledText(res);
  assert.ok(
    code.includes('+ 1'),
    `expected add x2, x0, #1 (+ 1) to be preserved and not DCE-dropped before memcpy:\n${code}`
  );
  assert.ok(
    code.includes('memcpy('),
    `expected memcpy call in output:\n${code}`
  );
  const closed = { ...res, pseudocode: code };
  closeFunctionOutput(closed);
  checkGccSyntax(closed.pseudocode, 'Fix 1 call_arg_prevdef_memcpy');
});

test('Fix 2A: post-index writeback on copied register mutates baseReg (x4) instead of aliased source (x0) and preserves copy (678)', () => {
  const symbols = new Map([[0x200000n, '_malloc']]);
  const { model, opts } = makeModel([
    'mov x19, x0',
    'mov x0, #0x20',
    'bl #0x200000',       // x0 = malloc(0x20)
    'mov x4, x0',         // copy x0 -> x4
    'str w19, [x4], #8',  // post-index writeback MUST mutate x4, never x0
    'str w19, [x4], #8',
    'ret',                // returns original x0 (unmutated)
  ], { name: 'writeback_copied_reg', symbols });

  const res = decompileLegacy(model, opts);
  const code = decompiledText(res);
  assert.ok(
    /x4\s*=\s*x0/.test(code),
    `expected initial copy x4 = x0 before writeback:\n${code}`
  );
  assert.ok(
    /x4\s*=\s*x4\s*\+\s*8;/.test(code),
    `expected post-index writeback to mutate x4 (x4 = x4 + 8;):\n${code}`
  );
  assert.ok(
    !/x0\s*=\s*x0\s*\+\s*8/.test(code),
    `post-index writeback on [x4] must NEVER mutate aliased x0:\n${code}`
  );
  const closed = { ...res, pseudocode: code };
  closeFunctionOutput(closed);
  checkGccSyntax(closed.pseudocode, 'Fix 2A writeback_copied_reg');
});

test('Fix 2B: clobbered-register alias substitution does not replace x20 with clobbered x0 and preserves x20 = x0 copy (974, 1306)', () => {
  // Case A: bl malloc -> mov x20, x0 -> bl sprintf (clobbers x0) -> read x20
  {
    const symbols = new Map([
      [0x200000n, '_malloc'],
      [0x200004n, '_sprintf'],
    ]);
    const { model, opts } = makeModel([
      'mov x0, #0x40',
      'bl #0x200000',       // x0 = malloc(0x40)
      'mov x20, x0',        // x20 = x0
      'mov x0, x20',
      'bl #0x200004',       // sprintf clobbers x0
      'mov x0, x20',        // returns original malloc pointer in x20, NOT sprintf return in x0
      'ret',
    ], { name: 'clobbered_alias_call_same_block', symbols });

    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(
      !/return x0;/.test(code) || /x0_1/.test(code),
      `must not return clobbered bare x0 after sprintf:\n${code}`
    );
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Fix 2B Case A clobbered_alias_call_same_block');
  }

  // Case B: bare x0 (liveOut of block 0) copied to x20, then x0 clobbered by sprintf, then x20 dereferenced & returned
  {
    const symbols = new Map([
      [0x200000n, '_malloc'],
      [0x200004n, '_sprintf'],
    ]);
    const { model, opts } = makeModel([
      'mov x0, #0x40',      // 0: 0x100000
      'bl #0x200000',       // 1: 0x100004 x0 = malloc(0x40) (bare x0 because liveOut to row 9 ret)
      'mov x20, x0',        // 2: 0x100008 must emit x20 = x0;
      'cbz x1, #0x100024',  // 3: 0x10000c
      'mov x0, x1',         // 4: 0x100010
      'bl #0x200004',       // 5: 0x100014 clobbers bare x0
      'ldr x8, [x20]',      // 6: 0x100018 must read *(uint64 *)(x20), NOT *(uint64 *)(x0)
      'add x0, x20, x8',    // 7: 0x10001c must use x20, NOT clobbered x0
      'ret',                // 8: 0x100020
      'ret',                // 9: 0x100024 returns x0 from malloc
    ], { name: 'clobbered_bare_x0_in_x20', symbols });

    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(
      /x20\s*=\s*x0;/.test(code),
      `expected x20 = x0; copy to be preserved before x0 clobber:\n${code}`
    );
    assert.ok(
      code.includes('*(uint64 *)(x20)'),
      `expected ldr [x20] to use x20 instead of clobbered x0:\n${code}`
    );
    assert.ok(
      !code.includes('*(uint64 *)(x0)'),
      `must not substitute clobbered x0 for x20:\n${code}`
    );
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Fix 2B Case B clobbered_bare_x0_in_x20');
  }
});

test('Fix 3: uint128-typed SIMD registers emit bit-preserving *(uint64 *)/$(uint32 *) loads/stores instead of *(double *)/$(float *) (1238)', () => {
  // 64-bit d0 with rev64 v0.2s, v0.2s
  {
    const { model, opts } = makeModel([
      'ldr d0, [x0]',
      'rev64 v0.2s, v0.2s',
      'str d0, [x0]',
      'ret',
    ], { name: 'simd_rev64_bit_preserving_d0' });

    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(
      !code.includes('*(double *)'),
      `uint128 SIMD register v0 must NOT emit lossy *(double *) load/store:\n${code}`
    );
    assert.ok(
      code.includes('*(uint64 *)'),
      `expected bit-preserving *(uint64 *) load/store for d0 in vecRegs:\n${code}`
    );
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Fix 3 simd_rev64_bit_preserving_d0');
  }

  // 32-bit s0 with vector op on v0
  {
    const { model, opts } = makeModel([
      'ldr s0, [x0]',
      'rev64 v0.2s, v0.2s',
      'str s0, [x0]',
      'ret',
    ], { name: 'simd_rev64_bit_preserving_s0' });

    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(
      !code.includes('*(float *)'),
      `uint128 SIMD register v0 must NOT emit lossy *(float *) load/store:\n${code}`
    );
    assert.ok(
      code.includes('*(uint32 *)'),
      `expected bit-preserving *(uint32 *) load/store for s0 in vecRegs:\n${code}`
    );
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Fix 3 simd_rev64_bit_preserving_s0');
  }

  // Pure scalar FP register (no vector op) must still emit *(double *) / *(float *)
  {
    const { model, opts } = makeModel([
      'ldr d0, [x0]',
      'fadd d0, d0, d1',
      'str d0, [x0]',
      'ret',
    ], { name: 'pure_scalar_fp_keeps_double' });

    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.ok(
      code.includes('*(double *)'),
      `pure scalar FP d0 must keep *(double *) load/store:\n${code}`
    );
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    checkGccSyntax(closed.pseudocode, 'Fix 3 pure_scalar_fp_keeps_double');
  }
});
