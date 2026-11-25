import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BinaryImage, openBinary, parseELF, parseMachO } from '../../js/binary/index.js';
import { machOImageAuthority } from '../../js/binary/macho-core.js';
import {
  executableELFRange,
  mappedELFFileRangeForVa,
  elfSectionFileSpanConsistentWithLoads,
} from '../../js/binary/elf-mapping.js';
import { buildSampleBinary } from '../../js/sample.js';
import { IncrementalSha256, sha256BlobHex } from '../../js/cache/content-identity.js';
import {
  getFallbackCounts,
  getWasmCallCount,
  getWasmCallCounts,
  resetAllTelemetry,
} from '../../js/core/wasm-telemetry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const REAL_CORPUS_SPECS = [
  { id: 'macho-sample-arm64', bytes: buildSampleBinary() },
  { id: 'arm64-semantic-holdout', file: 'tests/scpa/fixtures/arm64-real-byte-semantic-holdout.elf' },
  { id: 'arm64-fpsimd-holdout', file: 'tests/scpa/fixtures/arm64-real-byte-fpsimd-atomic-holdout.elf' },
  { id: 'arm64-threaded-int', file: 'tests/scpa/fixtures/threaded-integer.elf' },
  { id: 'arm64-threaded-mem', file: 'tests/scpa/fixtures/threaded-call-memory.elf' },
  { id: 'arm64-dispatch-table', file: 'tests/scpa/fixtures/dispatch-table.elf' },
  { id: 'arm64-gnu-b-key-cfi', file: 'tests/phase4/binary/fixtures/issue-4255-gnu-b-key-cfi.elf' },
  { id: 'arm64_32-objc', file: 'tests/phase12/integration/fixtures/issue-8280-arm64_32-objc.o' },
  { id: 'x86_64-sysv-elf', file: 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf' },
  { id: 'x86_64-pe-exe', file: 'tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe' },
  { id: 'x86_64-macho-o', file: 'tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o' },
  { id: 'x86_64-stripped-elf', file: 'tests/fixtures/cxx-dwarf-holdout/holdout.stripped.elf' },
  { id: 'x86-pe-exe', file: 'tests/phase12/rebuild/fixtures/vertical-microsoft-x86.exe' },
];

function loadRealCorpus() {
  return REAL_CORPUS_SPECS.map((spec) => ({
    id: spec.id,
    bytes: spec.bytes || new Uint8Array(fs.readFileSync(path.join(ROOT, spec.file))),
  }));
}

function withEngineMode(mode, fn) {
  const prevGlobal = globalThis.HEX_ENGINE;
  const prevInternal = globalThis.__HEX_ENGINE_MODE__;
  const prevEnv = process.env.HEX_ENGINE;
  const restore = () => {
    if (prevGlobal === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prevGlobal;
    if (prevInternal === undefined) delete globalThis.__HEX_ENGINE_MODE__;
    else globalThis.__HEX_ENGINE_MODE__ = prevInternal;
    if (prevEnv === undefined) delete process.env.HEX_ENGINE;
    else process.env.HEX_ENGINE = prevEnv;
  };
  let isAsync = false;
  try {
    if (mode == null) {
      delete globalThis.HEX_ENGINE;
      delete globalThis.__HEX_ENGINE_MODE__;
      delete process.env.HEX_ENGINE;
    } else {
      globalThis.HEX_ENGINE = mode;
      delete globalThis.__HEX_ENGINE_MODE__;
      delete process.env.HEX_ENGINE;
    }
    const res = fn();
    if (res && typeof res.then === 'function') {
      isAsync = true;
      return res.finally(restore);
    }
    return res;
  } finally {
    if (!isAsync) restore();
  }
}

function withEnvEngineMode(mode, fn) {
  const prevGlobal = globalThis.HEX_ENGINE;
  const prevInternal = globalThis.__HEX_ENGINE_MODE__;
  const prevEnv = process.env.HEX_ENGINE;
  try {
    delete globalThis.HEX_ENGINE;
    delete globalThis.__HEX_ENGINE_MODE__;
    if (mode == null) delete process.env.HEX_ENGINE;
    else process.env.HEX_ENGINE = mode;
    return fn();
  } finally {
    if (prevGlobal === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prevGlobal;
    if (prevInternal === undefined) delete globalThis.__HEX_ENGINE_MODE__;
    else globalThis.__HEX_ENGINE_MODE__ = prevInternal;
    if (prevEnv === undefined) delete process.env.HEX_ENGINE;
    else process.env.HEX_ENGINE = prevEnv;
  }
}

function buildSyntheticElf({
  is64 = true,
  be = false,
  entsize = null,
  withXindex = false,
  malformedXindex = false,
  unterminatedStrtab = false,
  nonAsciiName = false,
} = {}) {
  const le = !be;
  const ehSize = is64 ? 64 : 52;
  const shEntSize = is64 ? 64 : 40;
  const symEnt = entsize ?? (is64 ? 24 : 16);
  const textOff = 0x100;
  const textBytes = new Uint8Array([0xc3, 0x90, 0x90, 0x90]);

  const strChunks = [
    0x00,
    ...Buffer.from('alpha\0', 'utf8'),
    ...(nonAsciiName ? [0xc3, 0xa9, 0x80, 0x62, 0x00] : [...Buffer.from('beta\0', 'utf8')]),
    ...Buffer.from('.text\0.symtab\0.strtab\0.shstrtab\0.symtab_shndx\0', 'utf8'),
  ];
  const strtabBytes = Uint8Array.from(
    unterminatedStrtab ? [0x00, ...Buffer.from('unterminated_name', 'ascii')] : strChunks,
  );
  const shstrtabBytes = Uint8Array.from([
    0x00,
    ...Buffer.from('.text\0', 'ascii'),
    ...Buffer.from('.symtab\0', 'ascii'),
    ...Buffer.from('.strtab\0', 'ascii'),
    ...Buffer.from('.shstrtab\0', 'ascii'),
    ...Buffer.from('.symtab_shndx\0', 'ascii'),
  ]);

  const symCount = 4;
  const symOff = 0x200;
  const symBytes = new Uint8Array(symCount * symEnt);
  const sdv = new DataView(symBytes.buffer);
  const writeSym = (idx, nameOff, info, other, shndx, value, size) => {
    const o = idx * symEnt;
    if (is64) {
      sdv.setUint32(o, nameOff, le);
      sdv.setUint8(o + 4, info);
      sdv.setUint8(o + 5, other);
      sdv.setUint16(o + 6, shndx, le);
      sdv.setBigUint64(o + 8, BigInt(value), le);
      sdv.setBigUint64(o + 16, BigInt(size), le);
    } else {
      sdv.setUint32(o, nameOff, le);
      sdv.setUint32(o + 4, Number(value), le);
      sdv.setUint32(o + 8, Number(size), le);
      sdv.setUint8(o + 12, info);
      sdv.setUint8(o + 13, other);
      sdv.setUint16(o + 14, shndx, le);
    }
  };
  writeSym(0, 0, 0, 0, 0, 0, 0);
  writeSym(1, 1, 0x12, 0x02, withXindex ? 0xffff : 1, 0x401000, 4);
  writeSym(2, unterminatedStrtab ? 1 : 7, 0x11, 0x01, 1, 0x401004, 2);
  writeSym(3, 99999, 0x12, 0x00, 1, 0x401008, 4); // out-of-range st_name

  const strOff = 0x400;
  const shstrOff = 0x500;
  const xidxOff = 0x600;
  const xidxSize = malformedXindex ? 8 : symCount * 4;
  const shOff = 0x700;
  const numSh = withXindex ? 6 : 5;
  const totalSize = shOff + numSh * shEntSize + 64;
  const buf = new Uint8Array(totalSize);
  const dv = new DataView(buf.buffer);

  // ELF header
  buf.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, be ? 2 : 1, 1, 0], 0);
  dv.setUint16(16, 1, le); // ET_REL
  dv.setUint16(18, is64 ? 62 : 3, le); // EM_X86_64 or EM_386
  dv.setUint32(20, 1, le);
  if (is64) {
    dv.setBigUint64(40, BigInt(shOff), le);
    dv.setUint16(52, ehSize, le);
    dv.setUint16(58, shEntSize, le);
    dv.setUint16(60, numSh, le);
    dv.setUint16(62, 4, le); // shstrndx
  } else {
    dv.setUint32(32, shOff, le);
    dv.setUint16(40, ehSize, le);
    dv.setUint16(46, shEntSize, le);
    dv.setUint16(48, numSh, le);
    dv.setUint16(50, 4, le); // shstrndx
  }

  buf.set(textBytes, textOff);
  buf.set(symBytes, symOff);
  buf.set(strtabBytes, strOff);
  buf.set(shstrtabBytes, shstrOff);
  if (withXindex) {
    dv.setUint32(xidxOff + 0, 0, le);
    dv.setUint32(xidxOff + 4, 1, le); // resolves sym 1 -> .text
    if (!malformedXindex) {
      dv.setUint32(xidxOff + 8, 1, le);
      dv.setUint32(xidxOff + 12, 1, le);
    }
  }

  const writeSh = (idx, name, type, flags, addr, offset, size, link, info, align, es) => {
    const o = shOff + idx * shEntSize;
    if (is64) {
      dv.setUint32(o + 0, name, le);
      dv.setUint32(o + 4, type, le);
      dv.setBigUint64(o + 8, BigInt(flags), le);
      dv.setBigUint64(o + 16, BigInt(addr), le);
      dv.setBigUint64(o + 24, BigInt(offset), le);
      dv.setBigUint64(o + 32, BigInt(size), le);
      dv.setUint32(o + 40, link, le);
      dv.setUint32(o + 44, info, le);
      dv.setBigUint64(o + 48, BigInt(align), le);
      dv.setBigUint64(o + 56, BigInt(es), le);
    } else {
      dv.setUint32(o + 0, name, le);
      dv.setUint32(o + 4, type, le);
      dv.setUint32(o + 8, Number(flags), le);
      dv.setUint32(o + 12, Number(addr), le);
      dv.setUint32(o + 16, Number(offset), le);
      dv.setUint32(o + 20, Number(size), le);
      dv.setUint32(o + 24, link, le);
      dv.setUint32(o + 28, info, le);
      dv.setUint32(o + 32, Number(align), le);
      dv.setUint32(o + 36, Number(es), le);
    }
  };
  writeSh(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  writeSh(1, 1, 1, 6, 0x401000, textOff, textBytes.length, 0, 0, 16, 0); // .text
  writeSh(2, 7, 2, 0, 0, symOff, symBytes.length, 3, 1, 8, symEnt); // .symtab -> .strtab (3)
  writeSh(3, 15, 3, 0, 0, strOff, strtabBytes.length, 0, 0, 1, 0); // .strtab
  writeSh(4, 23, 3, 0, 0, shstrOff, shstrtabBytes.length, 0, 0, 1, 0); // .shstrtab
  if (withXindex) {
    writeSh(5, 33, 18, 0, 0, xidxOff, xidxSize, 2, 0, 4, 4); // SHT_SYMTAB_SHNDX -> .symtab (2)
  }
  return buf;
}

test('Wave 16 hybrid parity: all 13 real binaries match 0-diff (full symbols, sections, segments, imports, exports, functions, warnings, strings) and invoke elf_symbols WASM', () => {
  const corpus = loadRealCorpus();
  assert.equal(corpus.length, 13);

  resetAllTelemetry();
  let elfDispatched = 0;
  for (const fx of corpus) {
    const jsImg = withEngineMode('js', () => openBinary(fx.bytes, { strings: true, _engine: 'js' }));
    const beforeElfCalls = getWasmCallCount('elf_symbols');
    const autoImg = withEngineMode('auto', () => openBinary(fx.bytes, { strings: true, _engine: 'auto' }));
    const afterElfCalls = getWasmCallCount('elf_symbols');

    assert.equal(autoImg.format, jsImg.format, `${fx.id}: format mismatch`);
    assert.equal(autoImg.arch, jsImg.arch, `${fx.id}: arch mismatch`);
    assert.deepStrictEqual(autoImg.sections, jsImg.sections, `${fx.id}: sections 0-diff mismatch`);
    assert.deepStrictEqual(autoImg.segments, jsImg.segments, `${fx.id}: segments 0-diff mismatch`);
    assert.deepStrictEqual(autoImg.symbols, jsImg.symbols, `${fx.id}: full symbols 0-diff mismatch`);
    assert.deepStrictEqual(autoImg.imports, jsImg.imports, `${fx.id}: imports 0-diff mismatch`);
    assert.deepStrictEqual(autoImg.exports, jsImg.exports, `${fx.id}: exports 0-diff mismatch`);
    assert.deepStrictEqual(autoImg.functions, jsImg.functions, `${fx.id}: functions 0-diff mismatch`);
    assert.deepStrictEqual(autoImg.warnings, jsImg.warnings, `${fx.id}: warnings 0-diff mismatch`);
    if (autoImg.format === 'elf') {
      assert.deepStrictEqual(
        autoImg.metadata?.elfMetadata,
        jsImg.metadata?.elfMetadata,
        `${fx.id}: elfMetadata 0-diff mismatch`,
      );
      if ((autoImg.symbols || []).length > 0) {
        assert.ok(afterElfCalls > beforeElfCalls, `${fx.id}: expected elf_symbols WASM dispatch`);
        elfDispatched += 1;
      }
    }
    assert.deepStrictEqual(autoImg.strings, jsImg.strings, `${fx.id}: strings 0-diff mismatch`);
  }

  assert.ok(elfDispatched >= 7, `expected >= 7 ELF fixtures to dispatch elf_symbols WASM, got ${elfDispatched}`);
  const fallbacks = getFallbackCounts();
  const elfFallbacks = Object.entries(fallbacks).filter(([k]) => k.startsWith('elf_symbols:'));
  assert.deepStrictEqual(
    elfFallbacks,
    [],
    `expected 0 unexpected elf_symbols fallbacks, got ${JSON.stringify(elfFallbacks)} (calls=${JSON.stringify(getWasmCallCounts())})`,
  );
});

test('Wave 16 synthetic ELF matrix: ELF32/64 LE/BE, SHN_XINDEX, custom entsize, corrupt/unterminated strtab, non-ASCII UTF-8, and tight metadataLimits match JS 0-diff', () => {
  const cases = [
    { name: 'elf64-le-basic', opts: { is64: true, be: false } },
    { name: 'elf64-be-xindex', opts: { is64: true, be: true, withXindex: true } },
    { name: 'elf32-le-custom-ent', opts: { is64: false, be: false, entsize: 20, withXindex: true } },
    { name: 'elf32-be-non-ascii', opts: { is64: false, be: true, nonAsciiName: true } },
    { name: 'elf64-malformed-xindex', opts: { is64: true, be: false, withXindex: true, malformedXindex: true } },
    { name: 'elf64-unterminated-strtab', opts: { is64: true, be: false, unterminatedStrtab: true } },
  ];

  for (const tc of cases) {
    resetAllTelemetry();
    const bytes = buildSyntheticElf(tc.opts);
    const jsImg = withEngineMode('js', () => parseELF(bytes, { _engine: 'js' }));
    const beforeCalls = getWasmCallCount('elf_symbols');
    const autoImg = withEngineMode('auto', () => parseELF(bytes, { _engine: 'auto' }));
    const afterCalls = getWasmCallCount('elf_symbols');
    assert.ok(afterCalls > beforeCalls, `${tc.name}: expected elf_symbols WASM dispatch`);
    const synFallbacks = Object.entries(getFallbackCounts()).filter(([k]) => k.startsWith('elf_symbols:'));
    assert.deepStrictEqual(synFallbacks, [], `${tc.name}: expected 0 elf_symbols fallbacks, got ${JSON.stringify(synFallbacks)}`);
    assert.deepStrictEqual(autoImg.symbols, jsImg.symbols, `${tc.name}: symbols mismatch`);
    assert.deepStrictEqual(autoImg.warnings, jsImg.warnings, `${tc.name}: warnings mismatch`);
    assert.deepStrictEqual(autoImg.metadata?.elfMetadata, jsImg.metadata?.elfMetadata, `${tc.name}: elfMetadata mismatch`);
  }

  // Mid-symbol-table tight metadataLimits truncation parity (5 sections + 5 names + 2 of 4 symbols)
  resetAllTelemetry();
  const bytes = buildSyntheticElf({ is64: true, be: false });
  const fullImg = withEngineMode('js', () => parseELF(bytes, { _engine: 'js' }));
  const tightOpts = { metadataLimits: { records: 12 } };
  const jsTight = withEngineMode('js', () => parseELF(bytes, { ...tightOpts, _engine: 'js' }));
  const beforeTight = getWasmCallCount('elf_symbols');
  const autoTight = withEngineMode('auto', () => parseELF(bytes, { ...tightOpts, _engine: 'auto' }));
  assert.ok(getWasmCallCount('elf_symbols') > beforeTight, 'mid-symbol tight budget must dispatch elf_symbols WASM');
  assert.ok(autoTight.symbols.length > 0 && autoTight.symbols.length < fullImg.symbols.length, 'mid-symbol tight budget must partially truncate symbols');
  assert.deepStrictEqual(autoTight.symbols, jsTight.symbols, 'tight metadataLimits symbols mismatch');
  assert.deepStrictEqual(autoTight.metadata?.elfMetadata, jsTight.metadata?.elfMetadata, 'tight metadataLimits elfMetadata mismatch');

  // Pre-symbol objects budget exhaustion must skip WASM completely (0 calls)
  resetAllTelemetry();
  const autoObjExhausted = withEngineMode('auto', () => parseELF(bytes, { metadataLimits: { objects: 10 }, _engine: 'auto' }));
  assert.equal(autoObjExhausted.symbols.length, 0);
  assert.equal(getWasmCallCount('elf_symbols'), 0, 'exhausted objects budget must record 0 elf_symbols WASM calls');
});

test('Wave 16 transparent lazy image.strings: enumerable, 0 calls before access, cached, writable, seal/freeze/prototype/drift safe', () => {
  const corpus = loadRealCorpus();
  const sample = corpus.find((fx) => fx.id === 'arm64-semantic-holdout');
  assert.ok(sample);

  const jsExpectedStrings = withEngineMode('js', () => openBinary(sample.bytes, { strings: true, _engine: 'js' }).strings);
  assert.ok(Array.isArray(jsExpectedStrings) && jsExpectedStrings.length > 0);

  withEngineMode('auto', () => {
    resetAllTelemetry();
    const strOpts = { minLength: 4 };
    const img = openBinary(sample.bytes, { strings: strOpts, _engine: 'auto' });

    // Mutate caller's strOpts and flip global HEX_ENGINE after openBinary returns
    strOpts.minLength = 9999;
    globalThis.HEX_ENGINE = 'js';

    assert.equal('strings' in img, true, "'strings' in img must be true");
    assert.equal(Object.keys(img).includes('strings'), true, "Object.keys(img) must include 'strings'");
    assert.equal(getWasmCallCount('strings'), 0, 'lazy strings must perform 0 WASM calls before first access');

    const first = img.strings;
    const afterFirst = getWasmCallCount('strings');
    assert.ok(afterFirst >= 1, `pinned auto mode must still invoke strings WASM despite later HEX_ENGINE=js drift, got ${afterFirst}`);
    assert.deepStrictEqual(first, jsExpectedStrings, 'lazy strings must ignore post-call opts.strings mutation and match JS 0-diff');

    const second = img.strings;
    assert.strictEqual(second, first, 'second access to img.strings must return cached result');
    assert.equal(getWasmCallCount('strings'), afterFirst, 'second access must not trigger additional WASM calls');

    img.strings = [];
    assert.deepStrictEqual(img.strings, [], 'img.strings must remain writable');
  });

  // Object.seal(image), Object.freeze(image), and Object.create(image)
  withEngineMode('auto', () => {
    const sealed = openBinary(sample.bytes, { strings: true, _engine: 'auto' });
    Object.seal(sealed);
    assert.deepStrictEqual(sealed.strings, jsExpectedStrings, 'sealed image.strings read must succeed');
    sealed.strings = [];
    assert.deepStrictEqual(sealed.strings, [], 'sealed image.strings write must succeed');

    const frozen = openBinary(sample.bytes, { strings: true, _engine: 'auto' });
    Object.freeze(frozen);
    assert.deepStrictEqual(frozen.strings, jsExpectedStrings, 'frozen image.strings read must succeed');
    assert.throws(() => { frozen.strings = []; }, TypeError, 'frozen image.strings write must throw TypeError');
    const frozenChild = Object.create(frozen);
    assert.throws(() => { frozenChild.strings = ['x']; }, TypeError, 'frozen prototype child.strings write must throw TypeError');

    const protoImg = openBinary(sample.bytes, { strings: true, _engine: 'auto' });
    const child = Object.create(protoImg);
    child.strings = ['override'];
    assert.deepStrictEqual(child.strings, ['override'], 'child override must live on child');
    assert.deepStrictEqual(protoImg.strings, jsExpectedStrings, 'child assignment must not mutate prototype image.strings');
  });
});

test('Wave 16 Mach-O authority.buildVersion mutation immunity', () => {
  const sample = buildSampleBinary();
  const img = withEngineMode('auto', () => parseMachO(sample, { _engine: 'auto' }));
  if (img.metadata?.buildVersion && Array.isArray(img.metadata.buildVersion.tools)) {
    const origTools = img.metadata.buildVersion.tools.map((t) => ({ ...t }));
    img.metadata.buildVersion.tools.push({ tool: 'TAMPERED', version: '9.9.9', rawVersion: 0 });
    if (img.metadata.buildVersion.tools[0]) {
      img.metadata.buildVersion.tools[0].version = 'TAMPERED';
    }
    const auth = machOImageAuthority(img);
    assert.deepStrictEqual(auth.buildVersion.tools, origTools, 'authority.buildVersion.tools must be immune to post-parse mutation');
  }
});

test('Wave 16 elf-mapping & BinaryImage in-place mutation cache invalidation', () => {
  const img = new BinaryImage(new Uint8Array(0x2000), { format: 'elf', arch: 'x86_64', bits: 64, fileSize: 0x2000n });
  img.addSegment({ name: 'LOAD0', address: 0x400000n, size: 0x1000n, fileOffset: 0x0n, fileSize: 0x1000n, perms: { read: true, execute: true } });
  img.addSection({ name: '.text', index: 1, address: 0x400100n, size: 0x100n, fileOffset: 0x100n, fileSize: 0x100n, perms: { read: true, execute: true }, flags: 6 });

  assert.equal(img.offsetToAddress(0x110n), 0x400110n);
  assert.equal(executableELFRange(img, 0x400100n, 4n)?.name, '.text');
  assert.equal(mappedELFFileRangeForVa(img, 0x400100n)?.start, 0x100);
  assert.equal(elfSectionFileSpanConsistentWithLoads(img, 0x400100n, 0x100n, 0x100n, false), true);

  // Mutate section & segment in place without changing array length
  img.sections[0].fileOffset = 0x200n;
  img.sections[0].perms.execute = false;
  img.segments[0].fileOffset = 0x100n;
  img.segments[0].fileSize = 0x50n;

  assert.equal(executableELFRange(img, 0x400100n, 4n)?.name, 'LOAD0', 'in-place section.perms.execute mutation must invalidate elf-mapping section cache');
  img.segments[0].perms.execute = false;
  assert.equal(executableELFRange(img, 0x400100n, 4n), null, 'in-place segment.perms.execute mutation must invalidate elf-mapping segment cache');
  assert.equal(mappedELFFileRangeForVa(img, 0x400100n), null, 'in-place segment.fileSize mutation must invalidate elf-mapping cache');
  assert.equal(elfSectionFileSpanConsistentWithLoads(img, 0x400100n, 0x100n, 0x200n, false), false, 'in-place load mutation must invalidate loadSpan cache');
  assert.notEqual(img.offsetToAddress(0x110n), 0x400110n, 'in-place section.fileOffset mutation must invalidate BinaryImage offsetToAddress cache');
});

test('Wave 16 JS isolation gate: globalThis.HEX_ENGINE=js, process.env.HEX_ENGINE=js, { _engine: "js" }, and direct parseELF/parseMachO record 0 WASM calls', () => {
  const corpus = loadRealCorpus();
  const domains = ['elf_symbols', 'strings', 'sha256', 'binary'];

  // 1. globalThis.HEX_ENGINE = 'js'
  withEngineMode('js', () => {
    resetAllTelemetry();
    for (const fx of corpus) {
      const img = openBinary(fx.bytes, { strings: true });
      void img.strings;
    }
    for (const domain of domains) {
      assert.equal(getWasmCallCount(domain), 0, `globalThis.HEX_ENGINE=js must record 0 WASM calls for '${domain}'`);
    }
  });

  // 2. process.env.HEX_ENGINE = 'js' (with globalThis.HEX_ENGINE unset)
  withEnvEngineMode('js', () => {
    resetAllTelemetry();
    for (const fx of corpus) {
      const img = openBinary(fx.bytes, { strings: true });
      void img.strings;
    }
    for (const domain of domains) {
      assert.equal(getWasmCallCount(domain), 0, `process.env.HEX_ENGINE=js must record 0 WASM calls for '${domain}'`);
    }
  });

  // 3. Explicit { _engine: 'js' } via openBinary
  withEngineMode(null, () => {
    resetAllTelemetry();
    for (const fx of corpus) {
      const img = openBinary(fx.bytes, { strings: true, _engine: 'js' });
      void img.strings;
    }
    for (const domain of domains) {
      assert.equal(getWasmCallCount(domain), 0, `openBinary({ _engine: 'js' }) must record 0 WASM calls for '${domain}'`);
    }
  });

  // 4. Direct parseELF(bytes, { _engine: 'js' }) & parseMachO(bytes, { _engine: 'js' })
  withEngineMode(null, () => {
    resetAllTelemetry();
    const elfFx = corpus.find((fx) => fx.id === 'arm64-semantic-holdout');
    const machoFx = corpus.find((fx) => fx.id === 'macho-sample-arm64');
    parseELF(elfFx.bytes, { _engine: 'js' });
    parseMachO(machoFx.bytes, { _engine: 'js' });
    for (const domain of domains) {
      assert.equal(getWasmCallCount(domain), 0, `direct parseELF/parseMachO({ _engine: 'js' }) must record 0 WASM calls for '${domain}'`);
    }
  });
});

test('Wave 16 direct IncrementalSha256 & sha256BlobHex { _engine: "js" } isolation and parity', async () => {
  const payload = new Uint8Array(4096);
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31) & 0xff;
  const blob = new Blob([payload]);

  await withEngineMode('auto', async () => {
    resetAllTelemetry();
    const jsInc = new IncrementalSha256({ _engine: 'js' }).update(payload).hexDigest();
    const jsBlob = await sha256BlobHex(blob, { _engine: 'js' });
    assert.equal(getWasmCallCount('sha256'), 0, 'direct IncrementalSha256/sha256BlobHex({ _engine: "js" }) must record 0 sha256 WASM calls');

    const autoInc = new IncrementalSha256({ _engine: 'auto' }).update(payload).hexDigest();
    const autoBlob = await sha256BlobHex(blob, { _engine: 'auto' });
    assert.ok(getWasmCallCount('sha256') >= 2, 'auto IncrementalSha256/sha256BlobHex must dispatch sha256 WASM');
    assert.equal(autoInc, jsInc);
    assert.deepStrictEqual(autoBlob, jsBlob);
  });
});

test('Wave 17 chunked wasmScanStringsFlat (> 1.5 MiB): UTF-8 + UTF-16LE/BE + parity ordering + 4-byte NUL boundary + limit match JS 0-diff', () => {
  // Build a 2.2 MiB synthetic buffer (> 1.5 MiB scratch arena) with strings placed across 512 KiB chunk boundaries
  const size = 2_300_000;
  const buf = new Uint8Array(size);
  const writeAscii = (off, str) => {
    for (let i = 0; i < str.length; i += 1) buf[off + i] = str.charCodeAt(i);
  };
  const writeUtf16Le = (off, str) => {
    for (let i = 0; i < str.length; i += 1) {
      const c = str.charCodeAt(i);
      buf[off + i * 2] = c & 0xff;
      buf[off + i * 2 + 1] = (c >>> 8) & 0xff;
    }
  };
  // Place UTF-8 and UTF-16LE (both even and odd offsets) around 512 KiB, 1 MiB, 1.5 MiB boundaries
  for (const base of [64, 524200, 524290, 1048500, 1048600, 1572800, 2097100]) {
    writeAscii(base, `utf8_marker_${base}`);
    writeUtf16Le(base + 40, `u16even_${base}`);
    writeUtf16Le(base + 101, `u16odd_${base}`);
  }
  const img = new BinaryImage(buf, { format: 'elf', arch: 'arm64', bits: 64, fileSize: BigInt(size) });
  img.addSegment({ name: 'DATA', address: 0x1000000n, size: BigInt(size), fileOffset: 0n, fileSize: BigInt(size), perms: { read: true, write: true, execute: false } });
  img.addSection({ name: '.rodata', index: 1, address: 0x1000000n, size: BigInt(size), fileOffset: 0n, fileSize: BigInt(size), perms: { read: true, write: false, execute: false }, flags: 2 });

  // Use scanStrings via openBinary-like options by importing scanStrings dynamically or checking via BinaryImage
  return import('../../js/binary/strings.js').then(({ scanStrings }) => {
    for (const scanOpts of [
      { utf16: false, minLength: 4 },
      { utf16: 'le', minLength: 4 },
      { utf16: 'both', minLength: 4, limit: 15 },
    ]) {
      const jsRes = withEngineMode('js', () => scanStrings(img, { ...scanOpts, _engine: 'js' }));
      resetAllTelemetry();
      const wasmRes = withEngineMode('auto', () => scanStrings(img, { ...scanOpts, _engine: 'auto' }));
      assert.ok(getWasmCallCount('strings') >= 1, `expected chunked WASM strings dispatch for ${JSON.stringify(scanOpts)}`);
      const strFallbacks = Object.entries(getFallbackCounts()).filter(([k]) => k.startsWith('strings:'));
      assert.deepStrictEqual(strFallbacks, [], `expected 0 strings fallbacks, got ${JSON.stringify(strFallbacks)}`);
      assert.deepStrictEqual(wasmRes, jsRes, `chunked WASM strings 0-diff mismatch for ${JSON.stringify(scanOpts)}`);
    }
  });
});
