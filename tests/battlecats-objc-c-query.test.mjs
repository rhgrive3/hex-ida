import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSemanticModel } from '../js/blocks.js';
import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../js/analysis/query/index.js';
import {
  DECOMPILE_INTERNAL_FIELDS,
  DECOMPILE_PUBLIC_FIELDS,
  decompilerOptionsFromQuery,
} from '../js/analysis/query/app-adapter.js';

const BASE = 0x10000n;

function makeObjcModel(name = '-[SettingsVC applyTheme:forKey:]') {
  const rows = [
    { row: 0, address: BASE, mn: 'mov', ops: 'x2, #7' },
    { row: 1, address: BASE + 4n, mn: 'bl', ops: '#0x20000' },
    { row: 2, address: BASE + 8n, mn: 'ret', ops: '' },
  ];
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    if (d < 0n || d >= BigInt(rows.length * 4) || d % 4n !== 0n) return null;
    return Number(d / 4n);
  };
  const model = buildSemanticModel(rows, {
    startRow: 0,
    endRow: rows.length - 1,
    addr: BASE,
    rowOfAddress,
    addrOfRow: (r) => rows[r]?.address ?? null,
    name,
  });
  model.calls = [
    { row: 1, target: 0x20000n, name: '_objc_msgSend$setValue:', selector: 'setValue:', args: [] },
  ];
  return model;
}

function makeQueryApi({ analyzeFunction, getDecompile, symbolsMap = new Map() } = {}) {
  const app = {
    store: { get: () => null },
    backend: { binaryId: 'bin-track3-objc-c', gen: 1 },
    symbols: {
      nameAt: (addr) => symbolsMap.get(BigInt(addr)) ?? null,
      label: (addr) => symbolsMap.get(BigInt(addr)) ?? null,
    },
    ...(getDecompile ? { getDecompile } : {}),
    ...(analyzeFunction ? { analyzeFunction } : {}),
  };
  return new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app));
}

test('1. decompilerOptionsFromQuery forwards objcSyntax and DTO schema classifies objcSyntax & globalEvidence', async () => {
  assert.deepEqual(decompilerOptionsFromQuery({ objcSyntax: 'c', profile: 'fast', ignored: 1 }), {
    objcSyntax: 'c',
    profile: 'fast',
  });
  assert.equal(DECOMPILE_INTERNAL_FIELDS.includes('objcSyntax'), true);
  assert.equal(DECOMPILE_INTERNAL_FIELDS.includes('globalEvidence'), true);
  assert.equal(DECOMPILE_PUBLIC_FIELDS.includes('objcSyntax'), false);
  assert.equal(DECOMPILE_PUBLIC_FIELDS.includes('globalEvidence'), false);

  const api = makeQueryApi({
    async getDecompile() {
      return {
        pseudocode: 'uint64 sub_10000(void) { return 1; }',
        objcSyntax: 'c',
        globalEvidence: [{ name: 'global_5000', address: 0x5000n, type: 'uint64_t', provenance: 'closure-binary-data' }],
      };
    },
  });
  const snap = await api.snapshot();
  const res = await api.decompile(snap, '0x10000', { objcSyntax: 'c' });
  assert.equal(res.completeness, 'complete');
  assert.equal(res.status.projection ?? null, null);
  assert.equal(Object.hasOwn(res.value, 'objcSyntax'), false);
  assert.equal(Object.hasOwn(res.value, 'globalEvidence'), false);
});

test('2. query.decompile forwards objcSyntax="c" while default decompile() preserves ObjC bracket syntax', async () => {
  const model = makeObjcModel();
  const symbolsMap = new Map([[BASE, '-[SettingsVC applyTheme:forKey:]']]);
  const api = makeQueryApi({
    symbolsMap,
    async analyzeFunction() {
      return { startAddr: BASE, model };
    },
  });
  const snap = await api.snapshot();

  // Default decompile() preserves ObjC syntax
  const defaultRes = await api.decompile(snap, BASE);
  assert.equal(defaultRes.completeness, 'complete');
  assert.match(defaultRes.value.signature, /-\[SettingsVC applyTheme:forKey:\]/);

  // Explicit { objcSyntax: 'c' } emits C-compatible signature and no ObjC brackets
  const cRes = await api.decompile(snap, BASE, { objcSyntax: 'c' });
  assert.equal(cRes.completeness, 'complete');
  assert.match(cRes.value.signature, /objc_inst_SettingsVC_applyTheme_forKey/);
  assert.doesNotMatch(cRes.value.pseudocode, /-\[SettingsVC/);
});

test('3. query.decompile cache reuse, mismatch re-decompile, and invalid objcSyntax normalization', async () => {
  const model = makeObjcModel();
  const symbolsMap = new Map([[BASE, '-[SettingsVC applyTheme:forKey:]']]);

  // 3a. Cached decompiler with objcSyntax: undefined
  const undefinedCache = {
    pseudocode: '/* cached-undef */ int f(void) { return 1; }',
    signature: 'int -[CachedObjC run](void)',
  };
  const apiUndef = makeQueryApi({
    symbolsMap,
    async analyzeFunction() {
      return { startAddr: BASE, model, decompiler: undefinedCache };
    },
  });
  const snapUndef = await apiUndef.snapshot();

  // No option -> reuses cache
  const rNone = await apiUndef.decompile(snapUndef, BASE);
  assert.equal(rNone.value.pseudocode, undefinedCache.pseudocode);

  // Explicit 'objc' with undefined cache -> normalizes both to 'objc', reuses cache (no re-decompile)
  const rObjc = await apiUndef.decompile(snapUndef, BASE, { objcSyntax: 'objc' });
  assert.equal(rObjc.value.pseudocode, undefinedCache.pseudocode);

  // Invalid value -> normalized to 'objc', reuses undefined cache
  const rInvalid = await apiUndef.decompile(snapUndef, BASE, { objcSyntax: 'invalid-mode' });
  assert.equal(rInvalid.value.pseudocode, undefinedCache.pseudocode);

  // Explicit 'c' with undefined cache + model -> bypasses cache and re-decompiles in C mode
  const rC = await apiUndef.decompile(snapUndef, BASE, { objcSyntax: 'c' });
  assert.notEqual(rC.value.pseudocode, undefinedCache.pseudocode);
  assert.match(rC.value.signature, /objc_inst_SettingsVC_applyTheme_forKey/);

  // 3b. Cached decompiler with objcSyntax: 'c'
  const cCache = {
    pseudocode: '/* cached-c */ uint64 objc_inst_Cached_run(void) { return 2; }',
    signature: 'uint64 objc_inst_Cached_run(void)',
    objcSyntax: 'c',
  };
  const apiC = makeQueryApi({
    symbolsMap,
    async analyzeFunction() {
      return { startAddr: BASE, model, decompiler: cCache };
    },
  });
  const snapC = await apiC.snapshot();

  // Matching 'c' -> reuses cache
  const rCReuse = await apiC.decompile(snapC, BASE, { objcSyntax: 'c' });
  assert.equal(rCReuse.value.pseudocode, cCache.pseudocode);

  // Requesting 'objc' or invalid value against 'c' cache -> re-decompiles in ObjC mode
  const rCtoObjc = await apiC.decompile(snapC, BASE, { objcSyntax: 'objc' });
  assert.notEqual(rCtoObjc.value.pseudocode, cCache.pseudocode);
  assert.match(rCtoObjc.value.signature, /-\[SettingsVC applyTheme:forKey:\]/);

  const rCtoInvalid = await apiC.decompile(snapC, BASE, { objcSyntax: 'bogus' });
  assert.notEqual(rCtoInvalid.value.pseudocode, cCache.pseudocode);
  assert.match(rCtoInvalid.value.signature, /-\[SettingsVC applyTheme:forKey:\]/);

  // 3c. No model -> reuses cache even on mismatch
  const apiNoModel = makeQueryApi({
    symbolsMap,
    async analyzeFunction() {
      return { startAddr: BASE, decompiler: undefinedCache };
    },
  });
  const snapNoModel = await apiNoModel.snapshot();
  const rNoModel = await apiNoModel.decompile(snapNoModel, BASE, { objcSyntax: 'c' });
  assert.equal(rNoModel.value.pseudocode, undefinedCache.pseudocode);
});

test('4. query.translationUnit defaults to objcSyntax="c" and respects cache matching', async () => {
  const model = makeObjcModel();
  const symbolsMap = new Map([[BASE, '-[SettingsVC applyTheme:forKey:]']]);

  // Cached 'objc' (undefined) decompiler must be bypassed by default translationUnit() when model exists
  const staleObjcCache = {
    pseudocode: 'id -[SettingsVC applyTheme:forKey:](id a1) { return [a1 setValue:7]; }',
    signature: 'id -[SettingsVC applyTheme:forKey:](id a1)',
  };
  const apiStale = makeQueryApi({
    symbolsMap,
    async analyzeFunction() {
      return { startAddr: BASE, model, decompiler: staleObjcCache };
    },
  });
  const snapStale = await apiStale.snapshot();
  const tuDefault = await apiStale.translationUnit(snapStale, [BASE]);
  assert.match(tuDefault.value.source, /objc_inst_SettingsVC_applyTheme_forKey/);
  assert.doesNotMatch(tuDefault.value.source, /-\[SettingsVC/);

  // Explicit { objcSyntax: 'objc' } reuses the undefined cache
  const tuObjc = await apiStale.translationUnit(snapStale, [BASE], { objcSyntax: 'objc' });
  assert.equal(tuObjc.value.functions[0].syntaxOnly, true);

  // Cached objcSyntax: 'c' decompiler is reused without re-decompiling
  const cachedC = {
    pseudocode: 'uint64_t cached_c_fn(uint64_t a1) {\n    return a1 + 42;\n}',
    signature: 'uint64_t cached_c_fn(uint64_t a1)',
    objcSyntax: 'c',
  };
  const apiCachedC = makeQueryApi({
    symbolsMap,
    async analyzeFunction() {
      return { startAddr: BASE, model, decompiler: cachedC };
    },
  });
  const snapCachedC = await apiCachedC.snapshot();
  const tuReuseC = await apiCachedC.translationUnit(snapCachedC, [BASE]);
  assert.match(tuReuseC.value.source, /return a1 \+ 42;/);
});

test('5. query.translationUnit non-destructively merges result.value.globalEvidence and producer.globalEvidence', async () => {
  const pseudocode = [
    'uint64_t merge_probe(void)',
    '{',
    '    return (uint64_t)global_5000 + (uint64_t)global_5008 + (uint64_t)global_6000;',
    '}',
  ].join('\n');

  // 5a. Map primary (hex string key + BigInt key + identifier key) + Array secondary
  const primaryMap = new Map([
    ['0x5000', { type: 'int32_t', provenance: 'elf-symbol' }],
    [0x5008n, { type: 'double', provenance: 'explicit-global-evidence' }],
    ['global_5010', { type: 'uint8_t', address: 0x5010n, provenance: 'elf-symbol' }],
  ]);
  const secondaryArray = [
    { name: 'global_5000', address: 0x5000n, type: 'uint64_t', provenance: 'closure-binary-data' },
    { name: 'global_5008', address: '0x5008', type: 'uint64_t', provenance: 'closure-binary-data' },
    { name: 'global_5010', address: '0x9999', type: 'uint64_t', provenance: 'closure-binary-data' },
    { name: 'global_6000', address: 0x6000n, type: 'uint32_t', provenance: 'explicit-global-evidence' },
  ];

  const apiMap = makeQueryApi({
    async analyzeFunction() {
      return {
        startAddr: BASE,
        globalEvidence: primaryMap,
        decompiler: {
          pseudocode,
          signature: 'uint64_t merge_probe(void)',
          objcSyntax: 'c',
          globalEvidence: secondaryArray,
        },
      };
    },
  });
  const snapMap = await apiMap.snapshot();
  const tuMap = await apiMap.translationUnit(snapMap, [BASE]);
  const byAddr = new Map(tuMap.value.globals.map((g) => [g.name, g]));

  // Primary high-confidence entries must win over secondary duplicates (matched by normalized BigInt address)
  assert.equal(byAddr.get('global_5000')?.type, 'int32_t');
  assert.ok(byAddr.get('global_5000')?.provenance.includes('elf-symbol'));
  assert.equal(byAddr.get('global_5008')?.type, 'double');
  assert.ok(byAddr.get('global_5008')?.provenance.includes('explicit-global-evidence'));
  // Unregistered secondary entry must be appended
  assert.equal(byAddr.get('global_6000')?.type, 'uint32_t');
  assert.ok(byAddr.get('global_6000')?.provenance.includes('explicit-global-evidence'));

  // 5b. Plain Object primary (decimal address string key '20480' === 0x5000n + C identifier key) + Array secondary
  const primaryObj = {
    '20480': { type: 'int16_t', provenance: 'elf-symbol' },
    global_5008: { type: 'float', provenance: 'explicit-global-evidence' },
  };
  const apiObj = makeQueryApi({
    async analyzeFunction() {
      return {
        startAddr: BASE,
        globalEvidence: primaryObj,
        decompiler: {
          pseudocode,
          signature: 'uint64_t merge_probe(void)',
          objcSyntax: 'c',
          globalEvidence: [
            { name: 'global_5000', address: '0x5000', type: 'uint64_t', provenance: 'closure-binary-data' },
            { name: 'global_5008', address: 0x5008n, type: 'uint64_t', provenance: 'closure-binary-data' },
            { name: 'global_6000', address: '0x6000', type: 'int64_t', provenance: 'explicit-global-evidence' },
          ],
        },
      };
    },
  });
  const snapObj = await apiObj.snapshot();
  const tuObj = await apiObj.translationUnit(snapObj, [BASE]);
  const byAddrObj = new Map(tuObj.value.globals.map((g) => [g.name, g]));

  assert.equal(byAddrObj.get('global_5000')?.type, 'int16_t');
  assert.equal(byAddrObj.get('global_5008')?.type, 'float');
  assert.equal(byAddrObj.get('global_6000')?.type, 'int64_t');
});
