import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildAppleRuntimeIndex, resolveAppleCall } from '../../js/apple/runtime.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompile as legacyDecompile } from '../../js/decompile-legacy.js';
import { lowerArm64RawAssembly } from '../../js/decompiler/arm64-extra-semantics.js';
import { decompileSemantic } from '../../js/decompiler/semantic.js';

function modelOf(rows, { name = 'fixture', base = 0x10000n } = {}) {
  const raw = rows.map((entry, row) => ({
    row,
    address: BigInt(entry.address ?? (base + BigInt(row * 4))),
    mn: entry.mn,
    ops: entry.ops || '',
  }));
  const rowByAddress = new Map(raw.map((entry) => [entry.address.toString(), entry.row]));
  const opts = {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress: (addr) => rowByAddress.get(BigInt(addr).toString()) ?? null,
    addrOfRow: (row) => raw[row]?.address ?? null,
    symbolFor: () => null,
    name,
    addr: raw[0]?.address ?? base,
  };
  return { raw, opts, model: buildSemanticModel(raw, opts) };
}

function lowerOne(payload, opts = {}) {
  const res = lowerArm64RawAssembly({
    lines: [
      { kind: 'sig', indent: 0, text: 'void test_fn(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: `__asm("${payload}");` },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  }, opts);
  const lowered = res.lines.find((l) => l.note === 'Exact ARM64 instruction semantics lowered from the raw fallback.');
  return { result: res, stmt: lowered?.text ?? null, text: res.pseudocode ?? res.lines.map((l) => l.text).join('\n') };
}

function gccAvailable() {
  const probe = spawnSync('gcc', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function assertGccSyntaxOnly(source, label) {
  const run = spawnSync('gcc', [
    '-x', 'c', '-std=gnu11', '-fsyntax-only', '-Werror',
    '-Wno-unused-variable', '-Wno-unused-but-set-variable', '-Wno-unused-parameter', '-',
  ], {
    input: source,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `${label}: gcc -fsyntax-only failed:\n${run.stderr}\n--- SOURCE ---\n${source}`);
}

test('1a. arm64-extra-semantics lowers scalar movi dN, #imm in standard-C and non-standard-C modes', () => {
  const cMask = lowerOne('movi d0, #0xff00ff00ff00ff00');
  assert.equal(cMask.stmt, 'v0 = (unsigned __int128)0xff00ff00ff00ff00ULL;');

  const cZero = lowerOne('movi d31, #0x0');
  assert.equal(cZero.stmt, 'v31 = (unsigned __int128)0x0ULL;');

  const nonStd = lowerOne('movi d5, #0x00ff00ff00ff00ff', { standardC: false });
  assert.equal(nonStd.stmt, 'v5 = __a64_movi_d(0xff00ff00ff00ff);');

  // Invalid byte-mask immediate and non-64-bit scalar register must fail closed.
  const badImm = lowerOne('movi d0, #0x1234');
  assert.equal(badImm.stmt, null);
  assert.match(badImm.text, /__asm\("movi d0, #0x1234"\)/);

  const badWidth = lowerOne('movi s0, #0x0');
  assert.equal(badWidth.stmt, null);
  assert.match(badWidth.text, /__asm\("movi s0, #0x0"\)/);
});

test('1b. arm64-extra-semantics lowers NEON uzp1/uzp2/zip1/zip2 in standard-C and non-standard-C modes', (t) => {
  const arrangements = ['8b', '16b', '4h', '8h', '2s', '4s', '2d'];
  const mnemonics = ['uzp1', 'uzp2', 'zip1', 'zip2'];
  const stmts = [];

  for (const mn of mnemonics) {
    for (const arr of arrangements) {
      const payload = `${mn} v0.${arr}, v1.${arr}, v2.${arr}`;
      const cOut = lowerOne(payload);
      assert.ok(cOut.stmt, `expected standard-C lowering for ${payload}`);
      assert.doesNotMatch(cOut.stmt, /__a64_/, `no intrinsic in standard-C mode for ${payload}`);
      assert.match(cOut.stmt, /^v0 = \(/);
      stmts.push(cOut.stmt);

      const nonStd = lowerOne(payload, { standardC: false });
      assert.equal(nonStd.stmt, `v0 = __a64_${mn}_${arr}(v1, v2);`);
    }
  }

  // Mismatched arrangements or invalid operand counts stay fail-closed.
  const mismatch = lowerOne('uzp1 v0.4s, v1.2s, v2.4s');
  assert.equal(mismatch.stmt, null);
  assert.match(mismatch.text, /__asm\("uzp1 v0\.4s, v1\.2s, v2\.4s"\)/);

  const badArity = lowerOne('zip1 v0.4s, v1.4s');
  assert.equal(badArity.stmt, null);

  if (!gccAvailable()) {
    t.diagnostic('gcc unavailable; skipping C syntax/runtime check');
    return;
  }

  const moviStmt = lowerOne('movi d0, #0xff00ff0000ff00ff').stmt;
  const syntaxSrc = [
    '#include <stdint.h>',
    'void test_all(unsigned __int128 v1, unsigned __int128 v2) {',
    '  unsigned __int128 v0 = 0;',
    `  ${moviStmt}`,
    ...stmts.map((s) => `  ${s}`),
    '  (void)v0;',
    '}',
  ].join('\n');
  assertGccSyntaxOnly(syntaxSrc, 'scalar movi + NEON permute');

  // Verify bit-level semantics with GCC execution when temp dir is executable.
  const uzp1_8b = lowerOne('uzp1 v0.8b, v1.8b, v2.8b').stmt;
  const uzp2_4s = lowerOne('uzp2 v0.4s, v1.4s, v2.4s').stmt;
  const zip1_4s = lowerOne('zip1 v0.4s, v1.4s, v2.4s').stmt;
  const zip2_2d = lowerOne('zip2 v0.2d, v1.2d, v2.2d').stmt;

  const harness = `
#include <stdint.h>
#include <stdio.h>
static unsigned __int128 mk128(uint64_t hi, uint64_t lo) {
  return (((unsigned __int128)hi) << 64) | lo;
}
int main(void) {
  unsigned __int128 v0 = mk128(0xdeadbeefdeadbeefULL, 0x1111111111111111ULL);
  unsigned __int128 v1 = mk128(0x3333333322222222ULL, 0x1111111100000000ULL);
  unsigned __int128 v2 = mk128(0x7777777766666666ULL, 0x5555555544444444ULL);

  ${moviStmt}
  if (v0 != mk128(0ULL, 0xff00ff0000ff00ffULL)) return 1;

  // uzp1.8b: low 64 bits from even bytes of v1[0..7] then v2[0..7], upper 64 bits cleared.
  v1 = mk128(0xaaaaaaaaaaaaaaaaULL, 0x0706050403020100ULL);
  v2 = mk128(0xbbbbbbbbbbbbbbbbULL, 0x1716151413121110ULL);
  ${uzp1_8b}
  if (v0 != mk128(0ULL, 0x1614121006040200ULL)) return 2;

  v1 = mk128(0x3333333322222222ULL, 0x1111111100000000ULL);
  v2 = mk128(0x7777777766666666ULL, 0x5555555544444444ULL);
  ${uzp2_4s}
  if (v0 != mk128(0x7777777755555555ULL, 0x3333333311111111ULL)) return 3;

  ${zip1_4s}
  if (v0 != mk128(0x5555555511111111ULL, 0x4444444400000000ULL)) return 4;

  ${zip2_2d}
  if (v0 != mk128(0x7777777766666666ULL, 0x3333333322222222ULL)) return 5;

  return 0;
}
`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-practical-neon-'));
  try {
    const cPath = path.join(tmpDir, 'check.c');
    const binPath = path.join(tmpDir, 'check');
    fs.writeFileSync(cPath, harness, 'utf8');
    execFileSync('gcc', ['-std=gnu11', '-O2', cPath, '-o', binPath], { stdio: 'pipe' });
    const run = spawnSync(binPath, [], { stdio: 'pipe' });
    if (run.error?.code === 'EACCES') {
      t.diagnostic('tmpdir is noexec; skipping native execution check');
      return;
    }
    assert.equal(run.status, 0, `NEON permute runtime check failed with code ${run.status}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('2a. semantic-core falls back to inst.callPrototype and recovers self-recursive arguments', () => {
  // inst.callPrototype fallback on an unknown callee when callPrototypeFor is absent.
  {
    const { model, opts } = modelOf([
      { address: 0x2000n, mn: 'mov', ops: 'x0, #11' },
      { address: 0x2004n, mn: 'mov', ops: 'x1, #22' },
      { address: 0x2008n, mn: 'bl', ops: '0x9000' },
      { address: 0x200cn, mn: 'ret', ops: '' },
    ], { name: 'caller_with_inst_proto', base: 0x2000n });

    // Build IR once via decompileSemantic, then attach inst.callPrototype on the CALL node.
    const baseline = decompileSemantic(model, {
      ...opts,
      symbolFor: (addr) => (BigInt(addr) === 0x9000n ? 'custom_helper' : null),
    });
    assert.match(baseline.pseudocode, /custom_helper\(\/\* arguments unknown \*\/\)/);

    const callInst = baseline.ir.instructions.find((i) => i.op === 'call');
    assert.ok(callInst);
    callInst.callPrototype = { arity: 2 };
    const withProto = decompileSemantic(model, {
      ...opts,
      ir: baseline.ir,
      symbolFor: (addr) => (BigInt(addr) === 0x9000n ? 'custom_helper' : null),
    });
    assert.match(withProto.pseudocode, /custom_helper\(/);
    assert.doesNotMatch(withProto.pseudocode, /arguments unknown/);
    assert.match(withProto.pseudocode, /custom_helper\(11,\s*22\)/);
  }

  // Self-recursive 0-arg function: recovers empty argument list.
  {
    const { model, opts } = modelOf([
      { address: 0x3000n, mn: 'bl', ops: '0x3000' },
      { address: 0x3004n, mn: 'ret', ops: '' },
    ], { name: 'recurse_zero', base: 0x3000n });

    const sem = decompileSemantic(model, {
      ...opts,
      symbolFor: (addr) => (BigInt(addr) === 0x3000n ? 'recurse_zero' : null),
    });
    assert.match(sem.pseudocode, /recurse_zero\(\)/);
    assert.doesNotMatch(sem.pseudocode, /arguments unknown/);
  }

  // Self-recursive function with GP + FP arguments.
  {
    const { model, opts } = modelOf([
      { address: 0x4000n, mn: 'cbz', ops: 'x0, #0x4014' },
      { address: 0x4004n, mn: 'sub', ops: 'x0, x0, #1' },
      { address: 0x4008n, mn: 'fadd', ops: 'd0, d0, d0' },
      { address: 0x400cn, mn: 'bl', ops: '0x4000' },
      { address: 0x4010n, mn: 'ret', ops: '' },
      { address: 0x4014n, mn: 'ret', ops: '' },
    ], { name: 'recurse_gp_fp', base: 0x4000n });

    const sem = decompileSemantic(model, {
      ...opts,
      symbolFor: (addr) => (BigInt(addr) === 0x4000n ? 'recurse_gp_fp' : null),
    });
    assert.match(sem.pseudocode, /recurse_gp_fp\(/);
    assert.doesNotMatch(sem.pseudocode, /arguments unknown/);
  }
});

test('2b. semantic-core sanitizes Swift $ identifiers after try/await and in args without touching string literals', () => {
  const { model, opts } = modelOf([
    { address: 0x5000n, mn: 'adrp', ops: 'x0, #0x20000' },
    { address: 0x5004n, mn: 'add', ops: 'x0, x0, #0x10' },
    { address: 0x5008n, mn: 'bl', ops: '0x6000' },
    { address: 0x500cn, mn: 'ret', ops: '' },
  ], { name: 'swift_try_await_caller', base: 0x5000n });

  const sem = decompileSemantic(model, {
    ...opts,
    symbolFor: (addr) => (BigInt(addr) === 0x6000n ? '_$s4Game6loaderyyU0_Tg5' : null),
    stringFor: (addr) => (BigInt(addr) === 0x20010n ? '$keep_me' : null),
    swiftCallingConventionFor: () => ({ async: true, throws: true }),
    callPrototypeFor: () => ({ arity: 1 }),
  });

  // `try await ` prefix is preserved while `$s4Game6loaderyyYaKF` is sanitized,
  // and `"$keep_me"` inside the string literal remains intact.
  assert.match(sem.pseudocode, /try await __s4Game6loaderyyU0_Tg5\("\$keep_me"\)/);
  assert.doesNotMatch(sem.pseudocode, /\$s4Game6loaderyyU0_Tg5/);
});

test('3. decompile-legacy sanitizes $-containing field names and respects c.selector fallback', () => {
  // Field name with '$' is sanitized, while normal field name is untouched.
  const { model, opts } = modelOf([
    { address: 0x7000n, mn: 'ldr', ops: 'x1, [x0, #0x10]' },
    { address: 0x7004n, mn: 'ldr', ops: 'x2, [x0, #0x18]' },
    { address: 0x7008n, mn: 'add', ops: 'x0, x1, x2' },
    { address: 0x700cn, mn: 'ret', ops: '' },
  ], { name: 'legacy_dollar_field', base: 0x7000n });

  const fieldOut = legacyDecompile(model, {
    ...opts,
    fieldFor: (_base, off) => {
      if (off === 0x10) return { name: 'swift$storage$slot' };
      if (off === 0x18) return { name: 'normal_field' };
      return null;
    },
  });
  const fieldText = fieldOut.lines.map((l) => l.text).join('\n');
  assert.match(fieldText, /->swift_storage_slot/);
  assert.doesNotMatch(fieldText, /->swift\$storage/);
  assert.match(fieldText, /->normal_field/);

  // c.selector fallback when c.sel is absent (inline call expression inside return).
  const { model: selModel, opts: selOpts } = modelOf([
    { address: 0x7100n, mn: 'bl', ops: '0x8000' },
    { address: 0x7104n, mn: 'ret', ops: '' },
  ], { name: 'legacy_selector_fallback', base: 0x7100n });
  selModel.calls = [
    { row: 0, target: 0x8000n, name: '_objc_msgSend', selector: 'count', args: [] },
  ];

  const objcDefault = legacyDecompile(selModel, selOpts);
  const objcDefaultText = objcDefault.lines.map((l) => l.text).join('\n');
  assert.match(objcDefaultText, /count/);

  const objcC = legacyDecompile(selModel, { ...selOpts, objcSyntax: 'c' });
  const objcCText = objcC.lines.map((l) => l.text).join('\n');
  assert.match(objcCText, /objc_msgSend\(/);
  assert.doesNotMatch(objcCText, /\[.*count\]/);
});

test('4. blocks-base classifies all newly registered ARM64 load mnemonics with accurate memory metadata', () => {
  const cases = [
    { mn: 'ldursw', ops: 'x0, [x1, #-4]', size: 4, writes: ['x0'] },
    { mn: 'ldxrb', ops: 'w0, [x1]', size: 1, writes: ['x0'] },
    { mn: 'ldaxrb', ops: 'w0, [x1]', size: 1, writes: ['x0'] },
    { mn: 'ldxrh', ops: 'w0, [x1]', size: 2, writes: ['x0'] },
    { mn: 'ldaxrh', ops: 'w0, [x1]', size: 2, writes: ['x0'] },
    { mn: 'ldxp', ops: 'x0, x1, [x2]', size: 16, writes: ['x0', 'x1'] },
    { mn: 'ldaxp', ops: 'w0, w1, [x2]', size: 8, writes: ['x0', 'x1'] },
    { mn: 'ldapr', ops: 'x0, [x1]', size: 8, writes: ['x0'] },
    { mn: 'ldaprb', ops: 'w0, [x1]', size: 1, writes: ['x0'] },
    { mn: 'ldaprh', ops: 'w0, [x1]', size: 2, writes: ['x0'] },
  ];

  const rows = cases.map((c, idx) => ({ address: 0x9000n + BigInt(idx * 4), mn: c.mn, ops: c.ops }));
  rows.push({ address: 0x9000n + BigInt(cases.length * 4), mn: 'ret', ops: '' });

  const { model } = modelOf(rows, { name: 'load_mn_coverage', base: 0x9000n });
  for (let i = 0; i < cases.length; i++) {
    const insn = model.instructions[i];
    assert.ok(insn.memory, `${cases[i].mn} should produce memory metadata`);
    assert.equal(insn.memory.kind, 'load', `${cases[i].mn} should have memory.kind === 'load'`);
    assert.equal(insn.memory.size, cases[i].size, `${cases[i].mn} should have memory.size === ${cases[i].size}`);
    for (const w of cases[i].writes) {
      assert.ok(insn.writes.includes(w), `${cases[i].mn} should write ${w}`);
    }
  }
});

test('5. apple/runtime formats resolved ObjC IMP calls as C identifiers when style="c" while preserving default syntax', () => {
  const index = buildAppleRuntimeIndex({
    objc: {
      runtimeCompleteness: { complete: true },
      classes: [
        {
          name: 'SettingsVC',
          methods: [
            { selector: 'applyTheme:forKey:', imp: 0x1000n },
          ],
          classMethods: [
            { selector: 'sharedInstance', imp: 0x2000n },
          ],
        },
      ],
    },
  });

  // Default style keeps ObjC bracket syntax.
  const instDefault = resolveAppleCall(index, { kind: 'imp', target: 0x1000n, receiverType: 'SettingsVC', selector: 'applyTheme:forKey:' });
  assert.equal(instDefault.kind, 'imp');
  assert.equal(instDefault.text, '-[SettingsVC applyTheme:forKey:]');

  const clsDefault = resolveAppleCall(index, { kind: 'imp', target: 0x2000n, receiverType: 'SettingsVC', selector: 'sharedInstance' });
  assert.equal(clsDefault.kind, 'imp');
  assert.equal(clsDefault.text, '+[SettingsVC sharedInstance]');

  // style: 'c' emits valid C identifiers, never +[...] / -[...].
  const instC = resolveAppleCall(index, { kind: 'imp', target: 0x1000n, receiverType: 'SettingsVC', selector: 'applyTheme:forKey:', style: 'c' });
  assert.equal(instC.kind, 'imp');
  assert.equal(instC.text, 'objc_inst_SettingsVC_applyTheme_forKey');
  assert.doesNotMatch(instC.text, /^[+-]\[/);

  const clsC = resolveAppleCall(index, { kind: 'imp', target: 0x2000n, receiverType: 'SettingsVC', selector: 'sharedInstance', style: 'c' });
  assert.equal(clsC.kind, 'imp');
  assert.equal(clsC.text, 'objc_cls_SettingsVC_sharedInstance');
  assert.doesNotMatch(clsC.text, /^[+-]\[/);
});

test('6. decompile-legacy upgrades stack slots used in pointer dereferences from float/double to uint64', () => {
  const { model, opts } = modelOf([
    { address: 0xa000n, mn: 'stp', ops: 'd13, d12, [sp, #-0x20]!' },
    { address: 0xa004n, mn: 'bl', ops: '0xb000' },
    { address: 0xa008n, mn: 'str', ops: 'x0, [sp, #0x0]' },
    { address: 0xa00cn, mn: 'ldr', ops: 'x8, [sp, #0x0]' },
    { address: 0xa010n, mn: 'strb', ops: 'wzr, [x8, #0x10]' },
    { address: 0xa014n, mn: 'ldp', ops: 'd13, d12, [sp], #0x20' },
    { address: 0xa018n, mn: 'ret', ops: '' },
  ], { name: 'legacy_fp_slot_reused_as_ptr', base: 0xa000n });

  const out = legacyDecompile(model, opts);
  const text = out.lines.map((l) => l.text).join('\n');
  assert.doesNotMatch(text, /^\s*double\s+.*var_0\b/m);
  assert.match(text, /\buint64\b.*var_0\b/);
});
