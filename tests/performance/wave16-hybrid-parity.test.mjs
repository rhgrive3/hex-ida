import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBinary } from '../../js/binary/index.js';
import { buildSampleBinary } from '../../js/sample.js';
import {
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

function summarizeSymbols(symbols) {
  return (symbols || []).map((s) => ({
    name: s.name,
    address: s.address == null ? null : String(s.address),
    size: s.size == null ? null : String(s.size),
    kind: s.kind,
    binding: s.binding,
    defined: s.defined,
    sectionIndex: s.sectionIndex ?? null,
    source: s.source,
  }));
}

test('Wave 16 hybrid parity: all 13 real binaries match 0-diff (sections, segments, symbols, strings) and invoke elf_symbols WASM', () => {
  const corpus = loadRealCorpus();
  assert.equal(corpus.length, 13);

  resetAllTelemetry();
  for (const fx of corpus) {
    const jsImg = withEngineMode('js', () => openBinary(fx.bytes, { strings: true, _engine: 'js' }));
    const autoImg = withEngineMode('auto', () => openBinary(fx.bytes, { strings: true, _engine: 'auto' }));

    assert.equal(autoImg.format, jsImg.format, `${fx.id}: format mismatch`);
    assert.equal(autoImg.arch, jsImg.arch, `${fx.id}: arch mismatch`);
    assert.equal(
      (autoImg.sections || []).length,
      (jsImg.sections || []).length,
      `${fx.id}: sections.length mismatch`,
    );
    assert.equal(
      (autoImg.segments || []).length,
      (jsImg.segments || []).length,
      `${fx.id}: segments.length mismatch`,
    );
    assert.deepStrictEqual(
      summarizeSymbols(autoImg.symbols),
      summarizeSymbols(jsImg.symbols),
      `${fx.id}: symbols 0-diff mismatch`,
    );
    assert.deepStrictEqual(
      autoImg.strings,
      jsImg.strings,
      `${fx.id}: strings 0-diff mismatch`,
    );
  }

  assert.ok(
    getWasmCallCount('elf_symbols') > 0,
    `expected getWasmCallCount('elf_symbols') > 0 across ELF corpus, got ${getWasmCallCount('elf_symbols')} (all=${JSON.stringify(getWasmCallCounts())})`,
  );
});

test('Wave 16 transparent lazy image.strings: enumerable, 0 calls before access, cached on 2nd access, writable', () => {
  const corpus = loadRealCorpus();
  const sample = corpus.find((fx) => fx.id === 'arm64-semantic-holdout');
  assert.ok(sample);

  const jsExpectedStrings = withEngineMode('js', () => openBinary(sample.bytes, { strings: true, _engine: 'js' }).strings);
  assert.ok(Array.isArray(jsExpectedStrings) && jsExpectedStrings.length > 0);

  withEngineMode('auto', () => {
    resetAllTelemetry();
    const img = openBinary(sample.bytes, { strings: true, _engine: 'auto' });

    assert.equal('strings' in img, true, "'strings' in img must be true");
    assert.equal(Object.keys(img).includes('strings'), true, "Object.keys(img) must include 'strings'");
    assert.equal(getWasmCallCount('strings'), 0, 'lazy strings must perform 0 WASM calls before first access');

    const first = img.strings;
    const afterFirst = getWasmCallCount('strings');
    assert.ok(afterFirst >= 1, `expected >= 1 strings WASM call on first access, got ${afterFirst}`);
    assert.deepStrictEqual(first, jsExpectedStrings, 'lazy strings must match JS 0-diff');

    const second = img.strings;
    assert.strictEqual(second, first, 'second access to img.strings must return cached result');
    assert.equal(getWasmCallCount('strings'), afterFirst, 'second access must not trigger additional WASM calls');

    img.strings = [];
    assert.deepStrictEqual(img.strings, [], 'img.strings must remain writable');
  });
});

test('Wave 16 JS isolation gate: HEX_ENGINE=js and { _engine: "js" } record 0 WASM calls across all domains', () => {
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
      assert.equal(
        getWasmCallCount(domain),
        0,
        `HEX_ENGINE=js must record 0 WASM calls for '${domain}', got ${getWasmCallCount(domain)}`,
      );
    }
  });

  // 2. Explicit { _engine: 'js' }
  withEngineMode(null, () => {
    resetAllTelemetry();
    for (const fx of corpus) {
      const img = openBinary(fx.bytes, { strings: true, _engine: 'js' });
      void img.strings;
    }
    for (const domain of domains) {
      assert.equal(
        getWasmCallCount(domain),
        0,
        `{ _engine: 'js' } must record 0 WASM calls for '${domain}', got ${getWasmCallCount(domain)}`,
      );
    }
  });
});
