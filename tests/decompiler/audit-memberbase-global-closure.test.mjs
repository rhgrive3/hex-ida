import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import { buildCTranslationUnit } from '../../js/analysis/query/translation-unit.js';
import { openProduct } from '../../tools/validation/public-benchmark/product-host.mjs';

function findCCompiler() {
  for (const cc of ['gcc', 'clang']) {
    try {
      execFileSync(cc, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return cc;
    } catch { /* try next */ }
  }
  return null;
}

const CC = findCCompiler();

function cSyntaxOk(code) {
  if (!CC) return { skipped: true, ok: true, stderr: '' };
  try {
    execFileSync(CC, ['-x', 'c', '-fsyntax-only', '-'], { input: code, stdio: ['pipe', 'pipe', 'pipe'] });
    return { skipped: false, ok: true, stderr: '' };
  } catch (err) {
    return { skipped: false, ok: false, stderr: String(err.stderr || err.message || '') };
  }
}

function makeResult(lines) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
  };
}

test('member-base pointer closure synthesizes struct typedef, declares pointer local, preserves provenance, and passes GCC', () => {
  const sigSource = { addresses: [0x1000n], rows: [0] };
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 fn(void)', row: 0, addr: 0x1000n, source: sigSource },
    { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x1000n, source: sigSource },
    { kind: 'stmt', indent: 1, text: 'if (a1) return a1->field_8 + a1->field_0;', row: 1, addr: 0x1004n },
    { kind: 'stmt', indent: 1, text: 'return var_8->next;', row: 2, addr: 0x1008n },
    { kind: 'ctrl', indent: 0, text: '}', row: 3, addr: 0x100cn },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /typedef struct \{ uint64 field_0; uint64 field_8; \} hex_struct_a1;/);
  assert.match(result.pseudocode, /typedef struct \{ uint64 next; \} hex_struct_var_8;/);
  assert.match(result.pseudocode, /hex_struct_a1 \*a1;/);
  assert.match(result.pseudocode, /hex_struct_var_8 \*var_8;/);
  assert.doesNotMatch(result.pseudocode, /\buint64 a1;/);
  assert.doesNotMatch(result.pseudocode, /\buint64 var_8;/);

  // Every injected decl line must carry signature provenance.
  const injectedDecls = result.lines.filter((l) => l.kind === 'decl');
  assert.ok(injectedDecls.length >= 4);
  for (const decl of injectedDecls) {
    assert.ok(decl.source?.addresses?.includes(0x1000n), `missing provenance on: ${decl.text}`);
  }

  const chk = cSyntaxOk(result.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('member-base dot-only closure declares struct value local and emits fixed-width prelude before typedef', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'void update_point(void)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 's.field_0 = 42;' },
    { kind: 'stmt', indent: 1, text: 's.field_8 = s.field_0 + 1;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /typedef __UINT64_TYPE__ uint64;/);
  assert.match(result.pseudocode, /typedef struct \{ uint64 field_0; uint64 field_8; \} hex_struct_s;/);
  assert.match(result.pseudocode, /hex_struct_s s;/);
  assert.doesNotMatch(result.pseudocode, /hex_struct_s \*s;/);
  assert.ok(
    result.pseudocode.indexOf('typedef __UINT64_TYPE__ uint64;')
      < result.pseudocode.indexOf('typedef struct { uint64 field_0; uint64 field_8; } hex_struct_s;'),
  );

  const chk = cSyntaxOk(result.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('member-base closure skips already-declared parameters, keywords, call targets, and global_*', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 check(MyObj *p)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return p->x + get_obj()->y;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.doesNotMatch(result.pseudocode, /hex_struct_p/);
  assert.doesNotMatch(result.pseudocode, /hex_struct_get_obj/);
  assert.doesNotMatch(result.pseudocode, /hex_struct_MyObj/);
});

test('closeFunctionOutput is strictly idempotent with member-base structs, standalone globals, and locals', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 combined(void)', row: 0, addr: 0x3000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'tmp = a1->field_0 + s.val + global_13FD0;' },
    { kind: 'stmt', indent: 1, text: 'return tmp;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);
  const once = result.pseudocode;
  const onceLineCount = result.lines.length;

  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);
  assert.equal(result.lines.length, onceLineCount);
  assert.equal(result.pseudocode.split('hex_struct_a1;').length - 1, 1);
  assert.equal(result.pseudocode.split('hex_struct_s;').length - 1, 1);
  assert.equal(result.pseudocode.split('extern uint64 global_13FD0;').length - 1, 1);
  assert.doesNotMatch(result.pseudocode, /\buint64 hex_struct_a1;/);
  assert.doesNotMatch(result.pseudocode, /\buint64 hex_struct_s;/);

  const chk = cSyntaxOk(result.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('standalone global_* closure emits marked extern prelude, ignores comments/strings/calls, and passes GCC', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'void use_globals(void)', row: 0, addr: 0x4000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: '/* global_9999 in comment */' },
    { kind: 'stmt', indent: 1, text: 'x = global_2000 + global_1000;' },
    { kind: 'stmt', indent: 1, text: 'global_3000();' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /\/\* hex: standalone external globals \(stripped by translation unit packager\)\. \*\//);
  assert.match(result.pseudocode, /extern uint64 global_1000;/);
  assert.match(result.pseudocode, /extern uint64 global_2000;/);
  assert.doesNotMatch(result.pseudocode, /extern uint64 global_3000;/);
  assert.doesNotMatch(result.pseudocode, /extern uint64 global_9999;/);
  assert.ok(
    result.pseudocode.indexOf('typedef __UINT64_TYPE__ uint64;')
      < result.pseudocode.indexOf('extern uint64 global_1000;'),
  );

  const standaloneOnly = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 read_g(void)', row: 0, addr: 0x4100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return global_13FD0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(standaloneOnly);
  const chk = cSyntaxOk(standaloneOnly.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('buildCTranslationUnit deduplicates and merges hex_struct_* typedefs across multiple functions and passes GCC', () => {
  const fn1 = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 f1(void)', row: 0, addr: 0x100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return a1->field_0 + 1;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  const fn2 = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 f2(void)', row: 0, addr: 0x200n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return a1->field_0 + a1->field_8;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(fn1);
  closeFunctionOutput(fn2);

  const unit = buildCTranslationUnit([
    { address: 0x100n, name: 'f1', signature: 'uint64 f1(void)', pseudocode: fn1.pseudocode },
    { address: 0x200n, name: 'f2', signature: 'uint64 f2(void)', pseudocode: fn2.pseudocode },
  ]);

  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.equal(unit.functions[1].syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.equal(unit.source.split('hex_struct_a1;').length - 1, 1);
  assert.match(unit.source, /typedef struct \{ uint64 field_0; uint64 field_8; \} hex_struct_a1;/);
  assert.ok(
    unit.source.indexOf('typedef uint64_t uint64;')
      < unit.source.indexOf('typedef struct { uint64 field_0; uint64 field_8; } hex_struct_a1;'),
  );

  const chk = cSyntaxOk(unit.source);
  assert.equal(chk.ok, true, `Multi-function TU failed GCC:\n${unit.source}\n${chk.stderr}`);
});

test('buildCTranslationUnit strips standalone external globals prelude and preserves unresolved-global and evidence contracts', () => {
  const closed = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64_t read_global(void)', row: 0, addr: 0x500n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return global_5000;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(closed);
  assert.match(closed.pseudocode, /extern uint64 global_5000;/);

  // Without globalEvidence: keeps unresolved-global + byte-array fallback, strips standalone extern uint64.
  const unresolvedUnit = buildCTranslationUnit([
    { address: 0x500n, name: 'read_global', signature: 'uint64_t read_global(void)', pseudocode: closed.pseudocode },
  ]);
  assert.doesNotMatch(unresolvedUnit.source, /extern uint64 global_5000;/);
  assert.ok(unresolvedUnit.unresolved.some((row) => row.kind === 'unresolved-global' && row.subject === 'global_5000'));
  assert.ok(unresolvedUnit.fallbackDeclarations.some((line) => line.startsWith('extern uint8_t global_5000[];')));
  assert.equal(unresolvedUnit.completeness, 'partial');

  // With globalEvidence: uses evidence type cleanly with zero conflict and faithful body.
  const resolvedUnit = buildCTranslationUnit([
    {
      address: 0x500n,
      name: 'read_global',
      signature: 'uint64_t read_global(void)',
      pseudocode: closed.pseudocode,
      globalEvidence: { '20480': { type: 'uint32_t', size: 4, provenance: 'elf-symbol' } },
    },
  ]);
  assert.doesNotMatch(resolvedUnit.source, /extern uint64 global_5000;/);
  assert.match(resolvedUnit.source, /extern uint32_t global_5000;/);
  assert.equal(resolvedUnit.functions[0].syntaxOnly, false, JSON.stringify(resolvedUnit.unresolved));
  assert.equal(resolvedUnit.completeness, 'complete');

  const chk = cSyntaxOk(resolvedUnit.source);
  assert.equal(chk.ok, true, `Resolved global TU failed GCC:\n${resolvedUnit.source}\n${chk.stderr}`);
});

test('real ARM64 binaries const_param and call_weak_fn compile standalone with GCC and zero manual externs', async () => {
  const manifestPath = path.resolve('benchmarks/public/codefuse-arm64/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const targets = [
    ['2/2_clang_O2_g', 'const_param', /hex_struct_a1/],
    ['1/1_clang_O0_g', 'call_weak_fn', /extern uint64 global_13FD0;/],
  ];

  for (const [caseId, fnName, expectedPattern] of targets) {
    const entry = manifest.cases.find((c) => c.id === caseId);
    const product = await openProduct(path.resolve('benchmarks/public/codefuse-arm64', entry.binary));
    try {
      const snap = await product.query.snapshot();
      const page = await product.query.functions(snap, {}, { offset: 0, limit: 1000 });
      const fn = page.value.find((f) => f.name === fnName);
      assert.ok(fn, `Missing ${caseId}::${fnName}`);
      const resp = await product.query.decompile(await product.query.snapshot(), fn.address);
      const code = resp?.value?.pseudocode ?? '';
      assert.match(code, expectedPattern, `${caseId}::${fnName} missing expected closure declaration`);
      const chk = cSyntaxOk(code);
      assert.equal(chk.ok, true, `${caseId}::${fnName} failed standalone GCC:\n${code}\n${chk.stderr}`);
    } finally {
      await product.close();
    }
  }
});

test('parenthesized multiplication (a1 * a1) is not misclassified as pointer cast, x0_1 = a2 does not mask x0, and (a1 + off)->field is collected', () => {
  const res = {
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 edge_cases(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'x0_1 = (a1 * a1);' },
      { kind: 'stmt', indent: 1, text: 'x0 = (p + 0xEC)->field_20;' },
      { kind: 'ctrl', indent: 1, text: 'return x0 + x0_1;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  };
  closeFunctionOutput(res);
  assert.match(res.pseudocode, /\buint64 a1;/);
  assert.match(res.pseudocode, /\buint64 x0;/);
  assert.match(res.pseudocode, /\buint64 x0_1;/);
  assert.match(res.pseudocode, /typedef struct \{ uint64 field_20; \} hex_struct_p;/);
  assert.match(res.pseudocode, /\bhex_struct_p \*p;/);
});

test('signature pointer class types (Thing * this) get forward/struct typedefs and __atomic_load/__atomic_store get compat macros', () => {
  const res1 = {
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 ZNK5Thing6updateEi(Thing * this)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'ctrl', indent: 1, text: 'return this->field_0x8 + this->field_0xC;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  };
  closeFunctionOutput(res1);
  assert.match(res1.pseudocode, /typedef struct Thing \{ uint64 field_0x8; uint64 field_0xC; \} Thing;/);
  const once1 = res1.pseudocode;
  closeFunctionOutput(res1);
  assert.equal(res1.pseudocode, once1);

  const res2 = {
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 exclusive_pair(void * a2)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'x0 = __atomic_load((uint64 *)(a2));' },
      { kind: 'stmt', indent: 1, text: 'x2 = __atomic_store((uint64 *)(a2), x0);' },
      { kind: 'ctrl', indent: 1, text: 'return x0;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  };
  closeFunctionOutput(res2);
  assert.match(res2.pseudocode, /#define __atomic_load\(ptr\) __atomic_load_n\(\(ptr\), __ATOMIC_SEQ_CST\)/);
  assert.match(res2.pseudocode, /#define __atomic_store\(ptr, val\) \(__atomic_store_n\(\(ptr\), \(val\), __ATOMIC_SEQ_CST\), 0\)/);
  const once2 = res2.pseudocode;
  closeFunctionOutput(res2);
  assert.equal(res2.pseudocode, once2);
});
