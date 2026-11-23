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

function f64Bytes(val) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, val, true);
  return new Uint8Array(buf);
}

function f32Bytes(val) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, val, true);
  return new Uint8Array(buf);
}

test('Group 1: ELF GOT __stack_chk_guard lowers to global_<HEX> and stack array declarations emit uint8_t var[N]', () => {
  // 1A. adrp + ldr GOT load + canary dereference lowers to global_1FFD0 (never raw *(uint64 *)0x1FFD0)
  {
    const { model, opts } = makeModel([
      'sub sp, sp, #0x30',
      'stp x29, x30, [sp, #0x20]',
      'add x29, sp, #0x20',
      'adrp x8, #0x1f000',
      'ldr x8, [x8, #0xfd0]',
      'ldr x9, [x8]',
      'str x9, [sp, #0x18]',
      'mov w0, #42',
      'ldr x9, [sp, #0x18]',
      'ldr x10, [x8]',
      'subs x9, x9, x10',
      'b.eq #0x100034',
      'bl #0x200000',
      'ldp x29, x30, [sp, #0x20]',
      'add sp, sp, #0x30',
      'ret',
    ], {
      symbols: new Map([[0x200000n, '__stack_chk_fail']]),
      name: 'guarded_fn',
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bglobal_1FFD0\b/, `expected GOT slot lowered to global_1FFD0:\n${code}`);
    assert.doesNotMatch(code, /\*\(\s*uint64\s*\*\)\s*0x1FFD0\b/, `must not dereference raw VA 0x1FFD0:\n${code}`);

    // Verify c-output-closure synthesizes static backing for global_1FFD0 and compiles cleanly
    const closed = { ...res, pseudocode: code };
    closeFunctionOutput(closed);
    assert.match(closed.pseudocode, /static uint64 global_1FFD0\b/, `expected closure to synthesize global_1FFD0:\n${closed.pseudocode}`);
    execFileSync('gcc', ['-fsyntax-only', '-x', 'c', '-'], {
      input: closed.pseudocode,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  // 1B. memset(&var_58, 0, 1024) emits uint8_t var_58[1024] (or routes via sp - off), never 8-byte scalar uint64 var_58
  {
    const { model, opts } = makeModel([
      'sub sp, sp, #0x460',
      'stp x29, x30, [sp, #0x450]',
      'add x29, sp, #0x450',
      'add x0, sp, #0x58',
      'mov w1, #0',
      'mov x2, #0x400',
      'bl #0x200010',
      'mov w0, #0',
      'ldp x29, x30, [sp, #0x450]',
      'add sp, sp, #0x460',
      'ret',
    ], {
      symbols: new Map([[0x200010n, '_memset']]),
      name: 'zero_buf_fn',
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.doesNotMatch(code, /\b(?:u?int64|u?int32)\s+[^;]*\bvar_58\b/, `must not declare var_58 as scalar:\n${code}`);
    assert.ok(
      /\buint8_t\s+var_58\[1024\]/.test(code) || /\bmemset\s*\(\s*\(sp\s*-\s*0x408\)/.test(code),
      `expected either uint8_t var_58[1024] or sp - 0x408 routing:\n${code}`
    );
  }
});

test('Group 2: address-taken stack buffer routes direct [sp, #disp]/[x29, #disp] via sp - offset instead of disjoint var_XX', () => {
  const { model, opts } = makeModel([
    'sub sp, sp, #0x40',
    'stp x29, x30, [sp, #0x30]',
    'add x29, sp, #0x30',
    'add x0, sp, #0x10',
    'bl #0x200020',
    'ldr w0, [sp, #0x10]',
    'ldr w1, [sp, #0x14]',
    'add w0, w0, w1',
    'ldp x29, x30, [sp, #0x30]',
    'add sp, sp, #0x40',
    'ret',
  ], {
    symbols: new Map([[0x200020n, '_fill_pair']]),
    name: 'read_escaped_buf',
  });
  const res = decompileLegacy(model, opts);
  const code = decompiledText(res);
  assert.doesNotMatch(code, /\bvar_10\b/, `escaped slot 0x10 must not be a disjoint scalar var_10:\n${code}`);
  assert.doesNotMatch(code, /\bvar_14\b/, `escaped slot 0x14 must not be a disjoint scalar var_14:\n${code}`);
  assert.match(code, /\*\(\s*uint32\s*\*\)\(uintptr_t\)\(sp\s*-\s*0x30\)/, `expected sp - 0x30 deref for [sp, #0x10]:\n${code}`);
  assert.match(code, /\*\(\s*uint32\s*\*\)\(uintptr_t\)\(sp\s*-\s*0x2C\)/, `expected sp - 0x2C deref for [sp, #0x14]:\n${code}`);
  assert.match(code, /fill_pair\(\(sp\s*-\s*0x30\)\)/, `expected fill_pair to receive matching (sp - 0x30):\n${code}`);
});

test('Group 3: PC-relative .rodata FP literal-pool loads decode IEEE-754 float/double including -0.0', () => {
  // Double literal (3.5) and -0.0
  {
    const { model, opts } = makeModel([
      'adrp x8, #0x2000',
      'ldr d1, [x8, #0x800]',
      'adrp x9, #0x2000',
      'ldr d2, [x9, #0x808]',
      'fadd d0, d0, d1',
      'fadd d0, d0, d2',
      'ret',
    ], { name: 'rodata_double_fn' });
    // Populate ref.bytes as Track 1 (analyze.js) does
    const ref1 = model.addressRefs.find((r) => r.row === 1);
    const ref3 = model.addressRefs.find((r) => r.row === 3);
    assert.ok(ref1 && ref3, 'expected addressRefs for both adrp+ldr FP loads');
    ref1.bytes = f64Bytes(3.5);
    ref3.bytes = f64Bytes(-0.0);

    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\b3\.5\b/, `expected decoded double 3.5:\n${code}`);
    assert.match(code, /-0\.0\b/, `expected decoded -0.0:\n${code}`);
    assert.doesNotMatch(code, /\*\(\s*double\s*\*\)\s*0x2800/, `must not emit raw *(double *)0x2800:\n${code}`);
    checkGccSyntax(code, 'rodata_double_fn');
  }

  // Float literal (0.25f)
  {
    const { model, opts } = makeModel([
      'adrp x8, #0x3000',
      'ldr s1, [x8, #0x40]',
      'fmul s0, s0, s1',
      'ret',
    ], { name: 'rodata_float_fn' });
    const ref1 = model.addressRefs.find((r) => r.row === 1);
    assert.ok(ref1, 'expected addressRef for adrp+ldr float load');
    ref1.bytes = f32Bytes(0.25);

    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\b0\.25f\b/, `expected decoded float 0.25f:\n${code}`);
    assert.doesNotMatch(code, /\*\(\s*float\s*\*\)\s*0x3040/, `must not emit raw *(float *)0x3040:\n${code}`);
    checkGccSyntax(code, 'rodata_float_fn');
  }
});

test('Group 4: argAliases on bare reg nodes, live-out mov x19/x4, tail-call args, inlineTemporaries liveOut, and x0_N versioning', () => {
  // 4A. argAliases: mov x23, x1 elided, later mov x1, x23 after a join renders as a2 (never uninitialized x23)
  {
    const { model, opts } = makeModel([
      'stp x29, x30, [sp, #-0x20]!',
      'mov x29, sp',
      'str x23, [sp, #0x10]',
      'mov x23, x1',
      'cbz w0, #0x10001c',
      'bl #0x200030',
      'mov x0, x23',
      'ldr x23, [sp, #0x10]',
      'ldp x29, x30, [sp], #0x20',
      'ret',
    ], {
      symbols: new Map([[0x200030n, '_side_effect']]),
      name: 'alias_after_join',
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.doesNotMatch(code, /\bx23\b/, `elided argAlias x23 must not appear uninitialized:\n${code}`);
    assert.match(code, /\ba2\b/, `expected x23 use to resolve to a2:\n${code}`);
  }

  // 4B. Never elide mov x4, x0 when x4 is live-out into a successor block (e.g. tail-call or branch join)
  {
    const { model, opts } = makeModel([
      'cbz w1, #0x100010',
      'mov x4, x0',
      'b #0x100014',
      'mov x4, #7',
      'mov x0, x4',
      'ret',
    ], { name: 'live_out_arg_copy' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bx4\s*=\s*a1;/, `mov x4, x0 must not be elided when x4 is live-out:\n${code}`);
    assert.match(code, /\bx4\s*=\s*7;/, `expected other branch x4 = 7:\n${code}`);
  }

  // 4C. x0_1/x0_2 versioning: definition live-out to a join/return must not be renamed to x0_1 while downstream reads x0
  {
    const { model, opts } = makeModel([
      'stp x29, x30, [sp, #-0x10]!',
      'mov x29, sp',
      'cbz w0, #0x100014',
      'bl #0x200040',
      'b #0x100018',
      'bl #0x200050',
      'add x0, x0, #1',
      'ldp x29, x30, [sp], #0x10',
      'ret',
    ], {
      symbols: new Map([
        [0x200040n, '_branch_a'],
        [0x200050n, '_branch_b'],
      ]),
      name: 'join_return_x0',
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bx0\s*=\s*branch_a\(/, `live-out branch_a call must assign x0 (not x0_1):\n${code}`);
    assert.match(code, /\bx0\s*=\s*branch_b\(/, `live-out branch_b call must assign x0 (not x0_2):\n${code}`);
    assert.match(code, /\breturn\s+x0\s*\+\s*1;/, `expected return x0 + 1 matching live-out defs:\n${code}`);
    assert.doesNotMatch(code, /\bx0_1\b|\bx0_2\b/, `must not mismatch x0_1/x0_2 against return x0:\n${code}`);
  }

  // 4D. Tail-call ABI argument registers are treated as live-read at tail-call site
  {
    const { model, opts } = makeModel([
      'mov x0, #11',
      'mov x1, #22',
      'b #0x200060',
    ], {
      symbols: new Map([[0x200060n, '_helper_tail']]),
      name: 'tail_call_args',
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /helper_tail\(/, `expected tail call to helper_tail:\n${code}`);
    assert.ok(
      /helper_tail\(\s*11\s*,\s*22\s*\)/.test(code) || (/\bx0\s*=\s*11;/.test(code) && /\bx1\s*=\s*22;/.test(code)),
      `tail-call ABI argument setup must be preserved:\n${code}`
    );
  }
});

test('Group 5: fmov IEEE-754 bit-cast, cmn polarity, FP-returning stdlib calls to v0, and clobber-safe inlining', () => {
  // 5A. fmov s0, w0 and fmov w0, s0 lower as IEEE-754 union bit-cast, not numeric cast
  {
    const { model, opts } = makeModel([
      'fmov s0, w0',
      'fadd s0, s0, s0',
      'fmov w0, s0',
      'ret',
    ], { name: 'fmov_bitcast_32' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /union\s*\{\s*uint32_t u;\s*float f;\s*\}/, `expected 32-bit int->float bit-cast:\n${code}`);
    assert.match(code, /union\s*\{\s*float f;\s*uint32_t u;\s*\}/, `expected 32-bit float->int bit-cast:\n${code}`);
    checkGccSyntax(code, 'fmov_bitcast_32');
  }

  {
    const { model, opts } = makeModel([
      'fmov d0, x0',
      'fmov x0, d0',
      'ret',
    ], { name: 'fmov_bitcast_64' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /union\s*\{\s*uint64_t u;\s*double f;\s*\}/, `expected 64-bit int->double bit-cast:\n${code}`);
    assert.match(code, /union\s*\{\s*double f;\s*uint64_t u;\s*\}/, `expected 64-bit double->int bit-cast:\n${code}`);
    checkGccSyntax(code, 'fmov_bitcast_64');
  }

  // 5B. cmn w3, #1; b.eq tests (w3 + 1) == 0, NOT w3 == 1
  {
    const { model, opts } = makeModel([
      'cmn w0, #1',
      'b.eq #0x100010',
      'mov w0, #0',
      'ret',
      'mov w0, #1',
      'ret',
    ], { name: 'cmn_polarity' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\+\s*1\)\s*[!=]=\s*0/, `expected cmn to test (a + 1) ==/!= 0:\n${code}`);
    assert.doesNotMatch(code, /a1\s*[!=]=\s*1\b/, `cmn must NOT test a1 == 1:\n${code}`);
    checkGccSyntax(code, 'cmn_polarity');
  }

  // 5C. FP-returning stdlib calls (strtod, sqrt, fabs, floor, pow, sin, fmod) assign to v0, not x0
  {
    const { model, opts } = makeModel([
      'stp x29, x30, [sp, #-0x10]!',
      'mov x29, sp',
      'mov x1, #0',
      'bl #0x200070',
      'bl #0x200080',
      'ldp x29, x30, [sp], #0x10',
      'ret',
    ], {
      symbols: new Map([
        [0x200070n, '_strtod'],
        [0x200080n, '_sqrt'],
      ]),
      name: 'fp_stdlib_ret',
    });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, /\bv0(?:_\d+)?\s*=\s*strtod\(/, `strtod must assign to v0, not x0:\n${code}`);
    assert.match(code, /\bv0(?:_\d+)?\s*=\s*sqrt\(/, `sqrt must assign to v0, not x0:\n${code}`);
    assert.doesNotMatch(code, /\bx0(?:_\d+)?\s*=\s*strtod\(/, `strtod must not assign to x0:\n${code}`);
    assert.doesNotMatch(code, /\bx0(?:_\d+)?\s*=\s*sqrt\(/, `sqrt must not assign to x0:\n${code}`);
  }

  // 5D. Clobber-safe inlining: v1 = v0; v0 = ...; if (v0 > v1) must NEVER collapse into if (v0 > v0)
  {
    const { model, opts } = makeModel([
      'stp x29, x30, [sp, #-0x10]!',
      'mov x29, sp',
      'cbz w0, #0x100010',
      'fadd d0, d0, d2',
      'fmov d1, d0',
      'fadd d0, d0, d3',
      'fcmp d0, d1',
      'b.gt #0x100028',
      'mov w0, #0',
      'b #0x10002c',
      'mov w0, #1',
      'ldp x29, x30, [sp], #0x10',
      'ret',
    ], { name: 'clobber_safe_fp_cmp' });
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.doesNotMatch(code, /\bv0\s*(?:>|<=|<|>=)\s*v0\b/, `must never collapse v0 > v1 into v0 > v0:\n${code}`);
    assert.match(code, /\bv1\b/, `expected v1 to be preserved across v0 clobber:\n${code}`);
  }
});
