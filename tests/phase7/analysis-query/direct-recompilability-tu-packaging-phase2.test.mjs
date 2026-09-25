import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCTranslationUnit } from '../../../js/analysis/query/translation-unit.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/app-adapter.js';

function fn(pseudocode, extra = {}) {
  return { address:0x100n, name:'sample', signature:pseudocode.split(/\r?\n/, 1)[0], pseudocode, ...extra };
}

function call(target, name, prototype = null) {
  return { op:'call', target, name, callPrototype:prototype };
}

test('non-standard fixed-width aliases get a TU type contract without rewriting the function body', () => {
  const source = 'uint64 sample(void)\n{\n  return (uint64)1;\n}';
  const unit = buildCTranslationUnit([fn(source)]);
  assert.deepEqual(unit.includes, ['<stdint.h>']);
  assert.ok(unit.typeDeclarations.includes('typedef uint64_t uint64;'));
  assert.equal(unit.functions[0].pseudocode, source);
  assert.equal(unit.functions[0].originalPseudocode, source);
  assert.match(unit.source, /typedef uint64_t uint64;/);
});

test('standard fixed-width aliases carry the standard header contract', () => {
  const unit = buildCTranslationUnit([fn('uint32_t sample(void)\n{\n  return UINT32_C(1);\n}')]);
  assert.ok(unit.includes.includes('<stdint.h>'));
});

test('known direct callee gets declaration-before-use from selected definition evidence', () => {
  const caller = fn('uint64 caller(void)\n{\n  return callee();\n}', {
    address:0x100n, name:'caller', ir:{ instructions:[call(0x200n, 'callee')] },
  });
  const callee = fn('uint64 callee(void)\n{\n  return 7;\n}', { address:0x200n, name:'callee' });
  const unit = buildCTranslationUnit([callee, caller]);
  const proto = unit.prototypes.find((row) => row.name === 'callee');
  assert.equal(proto?.declaration, 'uint64 callee(void);');
  assert.ok(unit.source.indexOf('uint64 callee(void);') < unit.source.indexOf('uint64 caller(void)'));
});

test('known direct callee can use explicit prototype evidence and marks exactness honestly', () => {
  const unit = buildCTranslationUnit([fn('uint64_t sample(void)\n{\n  return known(1);\n}', {
    ir:{ instructions:[call(0x300n, 'known', { returnType:'uint64_t', parameters:[{ type:'uint32_t', name:'value' }], exact:true })] },
  })]);
  assert.equal(unit.prototypes[0].declaration, 'uint64_t known(uint32_t value);');
  assert.equal(unit.prototypes[0].exact, true);
});

test('unknown/unresolved call keeps an explicit unresolved entry and a syntax-only fallback prototype', () => {
  const unit = buildCTranslationUnit([fn('uint64 sample(void)\n{\n  return mystery();\n}', {
    ir:{ instructions:[call(0x444n, 'mystery')] },
  })]);
  assert.equal(unit.prototypes.length, 0);
  assert.ok(unit.unresolved.some((row) => row.kind === 'unresolved-prototype' && row.subject === 'mystery'));
  assert.ok(unit.fallbackDeclarations.some((line) => line.startsWith('uint64_t mystery();')));
  assert.match(unit.source, /uint64_t mystery\(\);/);
  assert.doesNotMatch(unit.source, /mystery\s*\(\.\.\.\)/);
});

test('known global data reference gets an evidence-backed declaration using the rendered identifier', () => {
  const unit = buildCTranslationUnit([fn('uint64_t sample(void)\n{\n  return global_4000;\n}', {
    globalEvidence:{ '16384':{ type:'uint64_t', size:8, provenance:'elf-symbol+section' } },
  })]);
  assert.equal(unit.globals[0].declaration, 'extern uint64_t global_4000;');
  assert.deepEqual(unit.globals[0].provenance, ['elf-symbol+section']);
  assert.ok(unit.source.indexOf('extern uint64_t global_4000;') < unit.source.indexOf('uint64_t sample(void)'));
});

test('insufficient global type evidence stays unresolved with an explicit byte-array syntax fallback', () => {
  const unit = buildCTranslationUnit([fn('uint64_t sample(void)\n{\n  return global_5000;\n}')]);
  assert.equal(unit.globals[0].declaration, null);
  assert.equal(unit.globals[0].certainty, 'unresolved');
  assert.ok(unit.unresolved.some((row) => row.kind === 'unresolved-global' && row.subject === 'global_5000'));
  assert.doesNotMatch(unit.source, /extern\s+uint64_t\s+global_5000/);
  assert.ok(unit.fallbackDeclarations.some((line) => line.startsWith('extern uint8_t global_5000[];')));
});

test('unknown_call and pseudo intrinsics keep their unresolved entries plus syntax-only fallback prototypes', () => {
  const unit = buildCTranslationUnit([fn('uint64 sample(void)\n{\n  return phi(unknown_call(1), bit_extract(2, 0, 1));\n}')]);
  assert.deepEqual(unit.helpers.map((row) => [row.name, row.kind]), [
    ['bit_extract', 'pseudo-intrinsic'], ['phi', 'pseudo-intrinsic'], ['unknown_call', 'unresolved-call-sentinel'],
  ]);
  assert.ok(unit.helpers.every((row) => row.declaration === null && row.external === false));
  assert.ok(unit.unresolved.some((row) => row.kind === 'pseudo-intrinsic' && row.subject === 'phi'));
  assert.ok(unit.fallbackDeclarations.some((line) => line.startsWith('uint64_t phi();')));
  assert.ok(unit.fallbackDeclarations.some((line) => line.startsWith('uint64_t unknown_call();')));
  assert.match(unit.source, /uint64_t phi\(\);/);
});

test('duplicate declarations are emitted once and order is deterministic', () => {
  const a = fn('uint64 a(void)\n{\n  return known(global_4000);\n}', {
    address:0x200n, name:'a', ir:{ instructions:[call(0x900n, 'known', { returnType:'uint64', parameters:[{ type:'uint64' }] })] },
    globalEvidence:{ '16384':{ type:'uint64', provenance:'fixture' } },
  });
  const b = fn('uint64 b(void)\n{\n  return known(global_4000);\n}', {
    address:0x100n, name:'b', ir:{ instructions:[call(0x900n, 'known', { returnType:'uint64', parameters:[{ type:'uint64' }] })] },
    globalEvidence:{ '16384':{ type:'uint64', provenance:'fixture' } },
  });
  const first = buildCTranslationUnit([a, b]);
  const second = buildCTranslationUnit([b, a]);
  assert.equal(first.prototypes.filter((row) => row.name === 'known').length, 1);
  assert.equal(first.globals.filter((row) => row.name === 'global_4000').length, 1);
  assert.equal(first.typeDeclarations.filter((row) => row === 'typedef uint64_t uint64;').length, 1);
  assert.equal(first.source, second.source);
});

test('conflicting prototype evidence fails closed', () => {
  const unit = buildCTranslationUnit([
    fn('uint64 a(void)\n{ return known(1); }', { address:0x100n, name:'a', ir:{ instructions:[call(0x900n, 'known', { returnType:'uint64', parameters:[{ type:'uint64' }] })] } }),
    fn('uint64 b(void)\n{ return known(1); }', { address:0x200n, name:'b', ir:{ instructions:[call(0x900n, 'known', { returnType:'uint64', parameters:[{ type:'uint32' }] })] } }),
  ]);
  assert.equal(unit.prototypes[0].declaration, null);
  assert.ok(unit.unresolved.some((row) => row.reason === 'conflicting-prototype-evidence'));
});

test('a provably-syntax-safe recovered body keeps its real statements in the emitted source', () => {
  const source = 'uint64 sample(void)\n{\n  uint64 x;\n  x = 7;\n  return x;\n}';
  const unit = buildCTranslationUnit([fn(source)]);
  const row = unit.functions[0];
  assert.equal(row.syntaxOnly, false, 'eligible body must not be replaced by a placeholder');
  assert.equal(row.emittedPseudocode, 'uint64 sample(void) {\n  uint64 x;\n  x = 7;\n  return x;\n}');
  assert.equal(row.originalPseudocode, source);
  assert.ok(unit.source.includes('return x;'), 'emitted source must carry the recovered statements');
  assert.doesNotMatch(unit.source, /__builtin_trap/);
  // No unresolved evidence was hidden: a fully provable body stays non-partial here.
  assert.ok(!unit.unresolved.some((entry) => entry.kind === 'syntax-only-function-body'));
});

test('a body the gates cannot prove keeps the explicit placeholder and records the withheld reason', () => {
  const source = 'uint64 sample(void)\n{\n  goto somewhere;\n  return 0;\n}';
  const unit = buildCTranslationUnit([fn(source)]);
  const row = unit.functions[0];
  assert.equal(row.syntaxOnly, true);
  assert.equal(row.emittedPseudocode.includes('__builtin_trap'), true);
  assert.equal(row.pseudocode, source, 'the recovered body stays available as evidence');
  assert.ok(unit.unresolved.some((entry) => entry.kind === 'syntax-only-function-body'
    && entry.subject === 'sample' && entry.reason === 'goto-syntax-unavailable'),
    JSON.stringify(unit.unresolved));
});

test('a producer $x placeholder name is never counted as a recovered faithful function', () => {
  const source = 'void $x(void)\n{\n  return;\n}';
  const unit = buildCTranslationUnit([fn(source)]);
  const row = unit.functions[0];
  assert.equal(row.name, 'hex_tu_fn_0', 'the emitted name is the safe alias, not the producer name');
  assert.equal(row.syntaxOnly, true, 'the $x signature cannot be proven, so the body stays a placeholder');
  assert.ok(unit.unresolved.some((entry) => entry.kind === 'syntax-only-function-body'),
    JSON.stringify(unit.unresolved));
  assert.ok(!unit.source.includes('$'), 'no producer placeholder name reaches the emitted source');
});

test('an arity-unknown call is faithful only against an unprototyped callee declaration', () => {
  // Callee recovered with parameters: its published signature has a known
  // arity, so the caller body must stay a placeholder.
  const caller = fn('void caller(void)\n{\n  callee(/* arguments unknown */);\n}', { address:0x100n, name:'caller' });
  const callee = fn('uint32 callee(int64 a1)\n{\n  return 1;\n}', { address:0x200n, name:'callee' });
  const unit = buildCTranslationUnit([caller, callee]);
  const callerRow = unit.functions.find((row) => row.name === 'caller');
  assert.equal(callerRow.syntaxOnly, true);
  assert.ok(unit.unresolved.some((entry) => entry.kind === 'syntax-only-function-body'
    && entry.reason?.startsWith('arity-unknown-call-contradicts-selected-signature')),
    JSON.stringify(unit.unresolved));
  // Without recovered parameters, the caller body is emitted faithfully.
  const callee2 = fn('uint32 callee(void)\n{\n  return 1;\n}', { address:0x200n, name:'callee' });
  const caller2 = fn('void caller(void)\n{\n  callee(1);\n}', { address:0x100n, name:'caller' });
  const unit2 = buildCTranslationUnit([caller2, callee2]);
  const callerRow2 = unit2.functions.find((row) => row.name === 'caller');
  assert.equal(callerRow2.syntaxOnly, false);
});

test('a missing-type global used as a scalar keeps its body on the placeholder', () => {
  // No globalEvidence: the packager can only offer a byte-array fallback.
  const unit = buildCTranslationUnit([fn('void sample(void)\n{\n  global_5000 = 1;\n}')]);
  const row = unit.functions[0];
  assert.equal(row.syntaxOnly, true);
  assert.ok(unit.unresolved.some((entry) => entry.kind === 'syntax-only-function-body'
    && entry.reason?.startsWith('global-byte-array-fallback-usage-unsupported:global_5000')));
  // The byte-array fallback itself stays explicit in the source.
  assert.ok(unit.fallbackDeclarations.some((line) => line.startsWith('extern uint8_t global_5000[];')));
});

test('type-like words inside comments and strings do not create declarations', () => {
  const unit = buildCTranslationUnit([fn('int sample(void)\n{\n  /* uint64 */\n  const char *s = "uint32";\n  return 0;\n}')]);
  assert.deepEqual(unit.typeDeclarations, []);
  assert.ok(!unit.includes.includes('<stdint.h>'));
});

test('a body with unaccounted code before the signature stays a placeholder', () => {
  const source = 'goto error;\nvoid foo(void)\n{\n  return;\n}';
  const unit = buildCTranslationUnit([fn(source, { name:'foo', signature:'void foo(void)' })]);
  const row = unit.functions[0];
  assert.equal(row.syntaxOnly, true);
  assert.equal(row.emittedPseudocode.includes('__builtin_trap'), true);
  assert.equal(row.pseudocode, source, 'the recovered body stays available as evidence');
  assert.ok(unit.unresolved.some((entry) => entry.kind === 'syntax-only-function-body'
    && entry.subject === 'foo' && entry.reason === 'body-prefix-unaccounted'),
    JSON.stringify(unit.unresolved));
});

test('a truncated brace-on-signature-line body stays a placeholder', () => {
  const source = 'void foo(void) {\n  if (x)\n  {\n    return;\n  }';
  const unit = buildCTranslationUnit([fn(source, { name:'foo', signature:'void foo(void)' })]);
  const row = unit.functions[0];
  assert.equal(row.syntaxOnly, true);
  assert.equal(row.emittedPseudocode.includes('__builtin_trap'), true);
  assert.equal(row.pseudocode, source, 'the recovered body stays available as evidence');
  assert.ok(unit.unresolved.some((entry) => entry.kind === 'syntax-only-function-body'
    && entry.subject === 'foo' && entry.reason === 'body-extent-unaccounted'),
    JSON.stringify(unit.unresolved));
});

test('the exact fixed-width prelude before the signature is accounted for', () => {
  const source = '/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n'
    + 'typedef __INT32_TYPE__ int32;\nint32 foo(int32 a)\n{\n  return a;\n}';
  const unit = buildCTranslationUnit([fn(source, { name:'foo', signature:'int32 foo(int32 a)' })]);
  const row = unit.functions[0];
  assert.equal(row.syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.ok(unit.source.includes('return a;'));
  assert.doesNotMatch(unit.source, /__builtin_trap/);
});

for (const prefix of ['/* note */ goto error;', '#define return exit(1);', 'typedef __INT64_TYPE__ int32;']) {
  test(`prefix ${JSON.stringify(prefix)} before the signature stays unaccounted`, () => {
    const source = `${prefix}\nint32 foo(int32 a)\n{\n  return a;\n}`;
    const unit = buildCTranslationUnit([fn(source, { name:'foo', signature:'int32 foo(int32 a)' })]);
    const row = unit.functions[0];
    assert.equal(row.syntaxOnly, true);
    assert.ok(unit.unresolved.some((entry) => entry.kind === 'syntax-only-function-body'
      && entry.subject === 'foo' && entry.reason === 'body-prefix-unaccounted'),
      JSON.stringify(unit.unresolved));
  });
}

test('a complete brace-on-signature-line body stays eligible', () => {
  const source = 'void foo(void) {\n  return;\n}';
  const unit = buildCTranslationUnit([fn(source, { name:'foo', signature:'void foo(void)' })]);
  const row = unit.functions[0];
  assert.equal(row.syntaxOnly, false, 'complete brace-on-signature-line body must stay faithful');
  assert.equal(row.emittedPseudocode, 'void foo(void) {\n  return;\n}');
  assert.equal(row.originalPseudocode, source);
  assert.ok(unit.source.includes('return;'));
  assert.doesNotMatch(unit.source, /__builtin_trap/);
  assert.ok(!unit.unresolved.some((entry) => entry.kind === 'syntax-only-function-body'));
});

test('translationUnit is additive: existing decompile presentation remains byte-for-byte unchanged', async () => {
  const pseudocode = 'uint64 sample(void)\n{\n  return 1;\n}';
  const app = {
    backend:{ binaryId:'bin_sha256_' + 'a'.repeat(64), gen:1 },
    projectRevision:0,
    symbols:{ nameAt:() => 'sample', label:() => 'sample' },
    analyzeFunction:async () => ({
      functionId:'function:256', startAddress:0x100n, name:'sample',
      decompiler:{ pseudocode, signature:'uint64 sample(void)', ir:{ instructions:[] } },
    }),
  };
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
  const snapshot = await api.snapshot();
  const before = await api.decompile(snapshot, 'function:256');
  const packaged = await api.translationUnit(snapshot, ['function:256']);
  const after = await api.decompile(snapshot, 'function:256');
  assert.equal(before.value.pseudocode, pseudocode);
  assert.equal(after.value.pseudocode, pseudocode);
  assert.equal(packaged.value.functions[0].pseudocode, pseudocode);
  assert.ok(packaged.value.typeDeclarations.includes('typedef uint64_t uint64;'));
});
