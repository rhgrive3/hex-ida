import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCTranslationUnit } from '../js/decompiler/translation-unit.js';
import { AnalysisQueryAPI } from '../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../js/analysis/query/app-adapter.js';

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

test('unknown/unresolved call gets no fake exact or variadic prototype and uncertainty is explicit', () => {
  const unit = buildCTranslationUnit([fn('uint64 sample(void)\n{\n  return mystery();\n}', {
    ir:{ instructions:[call(0x444n, 'mystery')] },
  })]);
  assert.equal(unit.prototypes.length, 0);
  assert.ok(unit.unresolved.some((row) => row.kind === 'unresolved-prototype' && row.subject === 'mystery'));
  assert.doesNotMatch(unit.source, /extern\s+.*mystery|mystery\s*\(\.\.\.\)/);
});

test('known global data reference gets an evidence-backed declaration using the rendered identifier', () => {
  const unit = buildCTranslationUnit([fn('uint64_t sample(void)\n{\n  return global_4000;\n}', {
    globalEvidence:{ '16384':{ type:'uint64_t', size:8, provenance:'elf-symbol+section' } },
  })]);
  assert.equal(unit.globals[0].declaration, 'extern uint64_t global_4000;');
  assert.deepEqual(unit.globals[0].provenance, ['elf-symbol+section']);
  assert.ok(unit.source.indexOf('extern uint64_t global_4000;') < unit.source.indexOf('uint64_t sample(void)'));
});

test('insufficient global type evidence stays unresolved instead of guessing uint64_t', () => {
  const unit = buildCTranslationUnit([fn('uint64_t sample(void)\n{\n  return global_5000;\n}')]);
  assert.equal(unit.globals[0].declaration, null);
  assert.equal(unit.globals[0].certainty, 'unresolved');
  assert.ok(unit.unresolved.some((row) => row.kind === 'unresolved-global' && row.subject === 'global_5000'));
  assert.doesNotMatch(unit.source, /extern\s+uint64_t\s+global_5000/);
});

test('unknown_call and pseudo intrinsics are not converted into fictional external helpers', () => {
  const unit = buildCTranslationUnit([fn('uint64 sample(void)\n{\n  return phi(unknown_call(1), bit_extract(2, 0, 1));\n}')]);
  assert.deepEqual(unit.helpers.map((row) => [row.name, row.kind]), [
    ['bit_extract', 'pseudo-intrinsic'], ['phi', 'pseudo-intrinsic'], ['unknown_call', 'unresolved-call-sentinel'],
  ]);
  assert.ok(unit.helpers.every((row) => row.declaration === null && row.external === false));
  assert.doesNotMatch(unit.source, /extern[^\n]*(?:unknown_call|phi|bit_extract)/);
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

test('type-like words inside comments and strings do not create declarations', () => {
  const unit = buildCTranslationUnit([fn('int sample(void)\n{\n  /* uint64 */\n  const char *s = "uint32";\n  return 0;\n}')]);
  assert.deepEqual(unit.typeDeclarations, []);
  assert.ok(!unit.includes.includes('<stdint.h>'));
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
