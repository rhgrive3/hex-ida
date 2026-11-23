import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  closeFunctionOutput,
  createGlobalDataResolver,
  localDeclarationTypeFor,
} from '../../js/decompiler/c-output-closure.js';

const STANDALONE_GLOBALS_COMMENT = '/* hex: standalone external globals (stripped by translation unit packager). */';
const STANDALONE_BINARY_GLOBALS_COMMENT = '/* hex: binary-backed global declarations (self-contained C output). */';

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

function c11SyntaxOk(code) {
  if (!CC) return { skipped: true, ok: true, stderr: '' };
  try {
    execFileSync(CC, ['-x', 'c', '-std=c11', '-fsyntax-only', '-'], {
      input: code,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { skipped: false, ok: true, stderr: '' };
  } catch (err) {
    return { skipped: false, ok: false, stderr: String(err.stderr || err.message || '') };
  }
}

function makeResult(lines, extra = {}) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
    ...extra,
  };
}

test('createGlobalDataResolver.hasSectionAt handles valid addresses and safely falls back on null/invalid values', () => {
  const resolver = createGlobalDataResolver({}, {
    sections: [
      { name: '.data', addr: 0x5000n, size: 0x100n, bytes: new Uint8Array(0x100) },
    ],
  });
  assert.equal(resolver.hasData, true);
  assert.equal(resolver.hasSectionAt(0x5000n), true);
  assert.equal(resolver.hasSectionAt(0x50ffn), true);
  assert.equal(resolver.hasSectionAt('0x5010'), true);
  assert.equal(resolver.hasSectionAt(0x5000), true);
  assert.equal(resolver.hasSectionAt(0x4fffn), false);
  assert.equal(resolver.hasSectionAt(0x5100n), false);
  // Safe fallbacks on null / non-integer / malformed inputs (no exceptions)
  assert.equal(resolver.hasSectionAt(null), false);
  assert.equal(resolver.hasSectionAt(undefined), false);
  assert.equal(resolver.hasSectionAt(''), false);
  assert.equal(resolver.hasSectionAt('   '), false);
  assert.equal(resolver.hasSectionAt('not-an-address'), false);
  assert.equal(resolver.hasSectionAt(1.5), false);
  assert.equal(resolver.hasSectionAt(Number.NaN), false);
  assert.equal(resolver.hasSectionAt(true), false);
  assert.equal(resolver.hasSectionAt(false), false);
  assert.equal(resolver.hasSectionAt({}), false);
});

test('hasData: true + hasSectionAt separates binary-backed vs unresolved globals, emits globalEvidence, and omits empty section headers', () => {
  const secBytes = new Uint8Array(0x100);
  secBytes[0] = 0x2a; // 0x5000 -> 0x2a
  secBytes[0x10] = 0x11; // 0x5010 -> uint128
  const options = {
    sections: [{ name: '.data', addr: 0x5000n, size: 0x100n, bytes: secBytes }],
  };

  // Case A: binary-backed only -> emits ONLY STANDALONE_BINARY_GLOBALS_COMMENT (no empty unresolved header)
  const binOnly = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 read_bin(void)', row: 0, addr: 0x1000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'q0 = global_5010;' },
    { kind: 'stmt', indent: 1, text: 'return global_5000 + (uint64)q0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(binOnly, options);

  assert.ok(binOnly.pseudocode.includes(STANDALONE_BINARY_GLOBALS_COMMENT));
  assert.ok(!binOnly.pseudocode.includes(STANDALONE_GLOBALS_COMMENT), 'must not emit empty unresolved section header');
  assert.ok(Array.isArray(binOnly.globalEvidence));
  assert.deepEqual(binOnly.globalEvidence, [
    { name: 'global_5000', address: 0x5000n, type: 'uint64_t', provenance: 'closure-binary-data' },
    { name: 'global_5010', address: 0x5010n, type: 'unsigned __int128', provenance: 'closure-binary-data' },
  ]);
  const chkBin = c11SyntaxOk(binOnly.pseudocode);
  assert.equal(chkBin.ok, true, chkBin.stderr);

  // Strictly idempotent on second call
  const onceCode = binOnly.pseudocode;
  const onceEvidence = structuredClone(binOnly.globalEvidence);
  closeFunctionOutput(binOnly, options);
  assert.equal(binOnly.pseudocode, onceCode);
  assert.deepEqual(binOnly.globalEvidence, onceEvidence);

  // Case B: mixed binary-backed + out-of-section unresolved + arrayGlobalNames (&global->field_0)
  const mixed = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 read_mixed(void)', row: 0, addr: 0x1100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return global_5000 + global_9000 + (&global_5020)->field_0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(mixed, options);

  assert.ok(mixed.pseudocode.includes(STANDALONE_BINARY_GLOBALS_COMMENT));
  assert.ok(mixed.pseudocode.includes(STANDALONE_GLOBALS_COMMENT));
  const binIdx = mixed.pseudocode.indexOf(STANDALONE_BINARY_GLOBALS_COMMENT);
  const unresIdx = mixed.pseudocode.indexOf(STANDALONE_GLOBALS_COMMENT);
  const g5000Idx = mixed.pseudocode.indexOf('static uint64 global_5000 =');
  const g5020Idx = mixed.pseudocode.indexOf('static uint8_t global_5020[');
  const g9000Idx = mixed.pseudocode.indexOf('static uint64 global_9000 = 0;');
  assert.ok(binIdx < g5000Idx && g5000Idx < unresIdx, 'global_5000 must be under binary-backed section');
  assert.ok(unresIdx < g5020Idx && unresIdx < g9000Idx, 'arrayGlobalNames and out-of-section globals must be under unresolved section');
  assert.deepEqual(mixed.globalEvidence, [
    { name: 'global_5000', address: 0x5000n, type: 'uint64_t', provenance: 'closure-binary-data' },
  ]);
  const chkMixed = c11SyntaxOk(mixed.pseudocode);
  assert.equal(chkMixed.ok, true, chkMixed.stderr);
});

test('hasData: false preserves legacy standalone globals contract and leaves result.globalEvidence untouched', () => {
  const existingObj = { '20480': { type: 'uint32_t', provenance: 'elf-symbol' } };
  const resNoEvidence = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 read_unres(void)', row: 0, addr: 0x1200n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return global_5000;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(resNoEvidence);
  assert.ok(resNoEvidence.pseudocode.includes(STANDALONE_GLOBALS_COMMENT));
  assert.ok(!resNoEvidence.pseudocode.includes(STANDALONE_BINARY_GLOBALS_COMMENT), 'must not emit empty binary section header');
  assert.equal(resNoEvidence.globalEvidence, undefined);

  const resWithExisting = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 read_unres2(void)', row: 0, addr: 0x1210n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return global_5000;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ], { globalEvidence: existingObj });
  closeFunctionOutput(resWithExisting);
  assert.equal(resWithExisting.globalEvidence, existingObj, 'must not touch globalEvidence when binaryEvidenceEntries is empty');
});

test('result.globalEvidence safely normalizes existing Map, plain Object, and Array with key restoration and BigInt/name deduplication', () => {
  const options = {
    sections: [{ name: '.data', addr: 0x5000n, size: 0x100n, bytes: new Uint8Array(0x100) }],
  };
  const bodyLines = () => [
    { kind: 'sig', indent: 0, text: 'uint64 read_all(void)', row: 0, addr: 0x1300n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return global_5000 + global_5008 + global_5010;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ];

  // 1. Plain Object with numeric decimal address key ('20480' === 0x5000) and identifier key ('global_5008')
  const resObj = makeResult(bodyLines(), {
    globalEvidence: {
      '20480': { type: 'uint32_t', size: 4, provenance: 'elf-symbol' },
      global_5008: { type: 'int64_t', provenance: 'explicit-global-evidence' },
    },
  });
  closeFunctionOutput(resObj, options);
  assert.ok(Array.isArray(resObj.globalEvidence));
  assert.equal(resObj.globalEvidence.length, 3);
  assert.deepEqual(resObj.globalEvidence[0], { address: '20480', type: 'uint32_t', size: 4, provenance: 'elf-symbol' });
  assert.deepEqual(resObj.globalEvidence[1], { name: 'global_5008', type: 'int64_t', provenance: 'explicit-global-evidence' });
  assert.deepEqual(resObj.globalEvidence[2], { name: 'global_5010', address: 0x5010n, type: 'uint64_t', provenance: 'closure-binary-data' });

  // 2. Map with BigInt address key (0x5000n) and C identifier key ('global_5008')
  const resMap = makeResult(bodyLines(), {
    globalEvidence: new Map([
      [0x5000n, { type: 'uint32_t', provenance: 'elf-symbol' }],
      ['global_5008', { type: 'int32_t', provenance: 'recovered-location-type' }],
    ]),
  });
  closeFunctionOutput(resMap, options);
  assert.ok(Array.isArray(resMap.globalEvidence));
  assert.equal(resMap.globalEvidence.length, 3);
  assert.deepEqual(resMap.globalEvidence[0], { address: 0x5000n, type: 'uint32_t', provenance: 'elf-symbol' });
  assert.deepEqual(resMap.globalEvidence[1], { name: 'global_5008', type: 'int32_t', provenance: 'recovered-location-type' });
  assert.deepEqual(resMap.globalEvidence[2], { name: 'global_5010', address: 0x5010n, type: 'uint64_t', provenance: 'closure-binary-data' });

  // 3. Array preserving existing items and deduplicating by BigInt address ('0x5000') and name ('global_5008')
  const resArr = makeResult(bodyLines(), {
    globalEvidence: [
      { name: 'sym_at_5000', address: '0x5000', type: 'uint32_t', provenance: 'elf-symbol' },
      { name: 'global_5008', type: 'uint16_t', provenance: 'recovered-location-type' },
    ],
  });
  closeFunctionOutput(resArr, options);
  assert.ok(Array.isArray(resArr.globalEvidence));
  assert.equal(resArr.globalEvidence.length, 3);
  assert.equal(resArr.globalEvidence[0].name, 'sym_at_5000');
  assert.equal(resArr.globalEvidence[1].name, 'global_5008');
  assert.deepEqual(resArr.globalEvidence[2], { name: 'global_5010', address: 0x5010n, type: 'uint64_t', provenance: 'closure-binary-data' });
});

test('C11 label hygiene inserts empty statement after trailing labels, case/default, and labels before declarations without early return', () => {
  // Pure function with zero prelude and zero body declarations (would hit early return if bodyChanged is not set)
  const trailingOnly = makeResult([
    { kind: 'sig', indent: 0, text: 'void trailing_label_only(void)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'label', indent: 1, text: 'loc_end:' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(trailingOnly);
  assert.match(trailingOnly.pseudocode, /loc_end:\n\s*;\n\}/);
  assert.equal(c11SyntaxOk(trailingOnly.pseudocode).ok, true);

  // Idempotent on second run
  const onceTrailing = trailingOnly.pseudocode;
  closeFunctionOutput(trailingOnly);
  assert.equal(trailingOnly.pseudocode, onceTrailing);

  // Labels, case, default before declarations of uint64, const, hex_struct_*, id, existingTypes, kind: 'decl', and trailing '}'
  const declLabels = makeResult([
    { kind: 'decl', indent: 0, text: 'typedef unsigned long long CustomAlias;' },
    { kind: 'decl', indent: 0, text: 'typedef struct { unsigned long long f0; } hex_struct_box;' },
    { kind: 'sig', indent: 0, text: 'void label_cases(int x)', row: 0, addr: 0x2100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'switch (x) {' },
    { kind: 'ctrl', indent: 2, text: 'case 0:' },
    { kind: 'stmt', indent: 3, text: 'uint64 a = 1;' },
    { kind: 'stmt', indent: 3, text: 'break;' },
    { kind: 'ctrl', indent: 2, text: 'case 1:' },
    { kind: 'stmt', indent: 3, text: 'const uint64 *p = 0;' },
    { kind: 'stmt', indent: 3, text: 'break;' },
    { kind: 'ctrl', indent: 2, text: 'case 2:' },
    { kind: 'stmt', indent: 3, text: 'hex_struct_box *b = 0;' },
    { kind: 'stmt', indent: 3, text: 'break;' },
    { kind: 'ctrl', indent: 2, text: 'case 3:' },
    { kind: 'stmt', indent: 3, text: 'id obj = 0;' },
    { kind: 'stmt', indent: 3, text: 'break;' },
    { kind: 'ctrl', indent: 2, text: 'case 4:' },
    { kind: 'stmt', indent: 3, text: 'CustomAlias ca = 0;' },
    { kind: 'stmt', indent: 3, text: 'break;' },
    { kind: 'ctrl', indent: 2, text: 'case 5:' },
    { kind: 'decl', indent: 3, text: 'int d = 0;' },
    { kind: 'stmt', indent: 3, text: 'break;' },
    { kind: 'ctrl', indent: 2, text: 'default:' },
    { kind: 'ctrl', indent: 1, text: '}' },
    { kind: 'label', indent: 1, text: 'loc_after:' },
    { kind: 'comment', indent: 1, text: '/* trailing comment */' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(declLabels);

  assert.match(declLabels.pseudocode, /case 0:\n\s*;\n\s*uint64 a = 1;/);
  assert.match(declLabels.pseudocode, /case 1:\n\s*;\n\s*const uint64 \*p = 0;/);
  assert.match(declLabels.pseudocode, /case 2:\n\s*;\n\s*hex_struct_box \*b = 0;/);
  assert.match(declLabels.pseudocode, /case 3:\n\s*;\n\s*id obj = 0;/);
  assert.match(declLabels.pseudocode, /case 4:\n\s*;\n\s*CustomAlias ca = 0;/);
  assert.match(declLabels.pseudocode, /case 5:\n\s*;\n\s*int d = 0;/);
  assert.match(declLabels.pseudocode, /default:\n\s*;\n\s*\}/);
  assert.match(declLabels.pseudocode, /loc_after:\n\s*;\n\s*\/\* trailing comment \*\/\n\}/);
  const chkDeclLabels = c11SyntaxOk(declLabels.pseudocode);
  assert.equal(chkDeclLabels.ok, true, chkDeclLabels.stderr);
});

test('declaredNamesFromLines braceDepth <= 1 guard does not treat nested-block decl lines as function-scoped declarations', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 nested_decl_guard(uint64 a1)', row: 0, addr: 0x3000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'decl', indent: 1, text: 'uint64 top_v = 0;' },
    { kind: 'ctrl', indent: 1, text: 'if (a1) {' },
    { kind: 'decl', indent: 2, text: 'uint64 nested_v = a1 + 1;' },
    { kind: 'stmt', indent: 2, text: 'top_v = nested_v;' },
    { kind: 'ctrl', indent: 1, text: '}' },
    { kind: 'stmt', indent: 1, text: 'return top_v + nested_v;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(res);

  // nested_v was only declared at braceDepth == 2, so function-scoped closure must declare it at top of body.
  assert.match(res.pseudocode, /\{\n\s+uint64 nested_v;\n\s+uint64 top_v = 0;/);
  // top_v (braceDepth == 1) must NOT be redeclared.
  assert.equal(res.pseudocode.split('uint64 top_v').length - 1, 1);
  const chk = c11SyntaxOk(res.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('REGISTER_CLASSES maps h0..h31 to uint16, b0..b31 to uint8, and SSA sp/lr/fp/nzcv registers to uint64', () => {
  assert.equal(localDeclarationTypeFor('h0', {}), 'uint16');
  assert.equal(localDeclarationTypeFor('h31', {}), 'uint16');
  assert.equal(localDeclarationTypeFor('h15_2', {}), 'uint16');
  assert.equal(localDeclarationTypeFor('h32', {}), 'uint64'); // out-of-range falls back to uint64
  assert.equal(localDeclarationTypeFor('b0', {}), 'uint8');
  assert.equal(localDeclarationTypeFor('b31', {}), 'uint8');
  assert.equal(localDeclarationTypeFor('b7_1', {}), 'uint8');
  assert.equal(localDeclarationTypeFor('b32', {}), 'uint64'); // out-of-range falls back to uint64
  assert.equal(localDeclarationTypeFor('sp_1', {}), 'uint64');
  assert.equal(localDeclarationTypeFor('lr_0', {}), 'uint64');
  assert.equal(localDeclarationTypeFor('fp_2', {}), 'uint64');
  assert.equal(localDeclarationTypeFor('nzcv_3', {}), 'uint64');

  // End-to-end declaration emission through closeFunctionOutput
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 reg_classes(void)', row: 0, addr: 0x4000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'h0 = 1; b0 = 2; sp_1 = 3;' },
    { kind: 'stmt', indent: 1, text: 'return (uint64)h0 + (uint64)b0 + sp_1;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(res);
  assert.match(res.pseudocode, /\buint16 h0;/);
  assert.match(res.pseudocode, /\buint8 b0;/);
  assert.match(res.pseudocode, /\buint64 sp_1;/);
  const chk = c11SyntaxOk(res.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('result.globalEvidence does not misclassify hex-letter C identifier keys (dead/cafe) as numeric addresses', () => {
  const result = {
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 fn_hex_key(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'return global_DEAD;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
    pseudocode: 'uint64 fn_hex_key(void)\n{\n    return global_DEAD;\n}',
    globalEvidence: new Map([
      ['dead', { type: 'int32_t', provenance: 'elf-symbol' }],
      ['cafe', { type: 'uint32_t', provenance: 'elf-symbol' }],
    ]),
  };
  const bytes = new Uint8Array(64);
  bytes[0] = 0x42;
  const options = {
    sections: [{ name: '__data', addr: 0xdeadn, size: 64n, bytes }],
  };
  const closed = closeFunctionOutput(result, options);
  assert.ok(Array.isArray(closed.globalEvidence));
  const deadIdent = closed.globalEvidence.find((e) => e.name === 'dead');
  assert.ok(deadIdent, 'dead identifier entry preserved');
  assert.equal(deadIdent.address, undefined, 'hex-letter C identifier key must not be promoted to address');
  const cafeIdent = closed.globalEvidence.find((e) => e.name === 'cafe');
  assert.ok(cafeIdent, 'cafe identifier entry preserved');
  assert.equal(cafeIdent.address, undefined);
  const binDead = closed.globalEvidence.find((e) => e.name === 'global_DEAD');
  assert.ok(binDead, 'global_DEAD binary evidence must not be dropped by identifier key collision');
  assert.equal(binDead.address, 0xdeadn);
  assert.equal(binDead.provenance, 'closure-binary-data');
});
