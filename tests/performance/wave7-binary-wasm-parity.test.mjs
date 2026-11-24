import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { openBinary } from '../../js/binary/index.js';
import { buildSampleBinary } from '../../js/sample.js';
import {
  getWasmCallCount,
  resetAllTelemetry,
} from '../../js/core/wasm-telemetry.js';

function loadCorpus() {
  const realCorpus = [
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
  for (const item of realCorpus) {
    if (item.file) item.bytes = new Uint8Array(fs.readFileSync(item.file));
  }

  const sampleElf = realCorpus.find((x) => x.id === 'arm64-semantic-holdout').bytes;
  const sampleMacho = realCorpus.find((x) => x.id === 'macho-sample-arm64').bytes;
  const samplePe = realCorpus.find((x) => x.id === 'x86_64-pe-exe').bytes;
  const mutantElf = sampleElf.slice();
  for (let i = 40; i < 48; i += 1) mutantElf[i] = 0xff;

  const corruptCorpus = [
    { id: 'corrupt-empty', bytes: new Uint8Array(0) },
    { id: 'corrupt-bad-magic', bytes: new Uint8Array(64).fill(0x5a) },
    { id: 'corrupt-truncated-elf', bytes: sampleElf.subarray(0, 32) },
    { id: 'corrupt-truncated-macho', bytes: sampleMacho.subarray(0, 24) },
    { id: 'corrupt-truncated-pe', bytes: samplePe.subarray(0, 96) },
    { id: 'corrupt-mutant-elf-shoff', bytes: mutantElf },
  ];

  return { realCorpus, corruptCorpus };
}

function summarizeImage(img) {
  return {
    format: img.format,
    arch: img.arch,
    bits: img.bits,
    endian: img.endian,
    imageBase: String(img.imageBase ?? 0n),
    entrypoint: img.entrypoint != null ? String(img.entrypoint) : null,
    sections: (img.sections || []).map((s) => ({
      name: s.name,
      address: String(s.address ?? 0n),
      size: String(s.size ?? 0n),
      fileOffset: String(s.fileOffset ?? 0n),
      fileSize: String(s.fileSize ?? 0n),
      exec: Boolean(s.perms?.execute),
    })),
    functions: (img.functions || []).map((f) => ({
      name: f.name,
      address: String(f.address ?? 0n),
      size: String(f.size ?? 0n),
    })),
    stringCount: (img.strings || []).length,
  };
}

function runCapture(bytes, opts) {
  try {
    const img = openBinary(bytes, opts);
    return { ok: true, summary: summarizeImage(img) };
  } catch (err) {
    return { ok: false, name: err?.name || 'Error', message: String(err?.message || err) };
  }
}

test('Wave 7 openBinary WASM parity across 13 real binaries + 6 corrupt cases', () => {
  const { realCorpus, corruptCorpus } = loadCorpus();
  assert.equal(realCorpus.length, 13);
  assert.equal(corruptCorpus.length, 6);

  resetAllTelemetry();
  for (const fx of [...realCorpus, ...corruptCorpus]) {
    const jsRes = runCapture(fx.bytes, { strings: true, _engine: 'js' });
    const wasmRes = runCapture(fx.bytes, { strings: true });
    assert.deepEqual(wasmRes, jsRes, `JS vs WASM mismatch on ${fx.id}`);
  }
  assert.ok(getWasmCallCount('binary') >= 1, 'expected getWasmCallCount("binary") >= 1');
});

test('Wave 7 openBinary honors HEX_ENGINE=js, globalThis.HEX_ENGINE=js, and {_engine:"js"} with 0 WASM calls', () => {
  const { realCorpus } = loadCorpus();
  const sample = realCorpus[0].bytes;

  // 1. {_engine: 'js'}
  resetAllTelemetry();
  openBinary(sample, { _engine: 'js' });
  assert.equal(getWasmCallCount('binary'), 0);

  // 2. globalThis.HEX_ENGINE === 'js'
  const prevGlobal = globalThis.HEX_ENGINE;
  try {
    resetAllTelemetry();
    globalThis.HEX_ENGINE = 'js';
    openBinary(sample);
    assert.equal(getWasmCallCount('binary'), 0);
  } finally {
    if (prevGlobal === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prevGlobal;
  }

  // 3. process.env.HEX_ENGINE === 'js'
  const prevEnv = process.env.HEX_ENGINE;
  try {
    resetAllTelemetry();
    process.env.HEX_ENGINE = 'js';
    openBinary(sample);
    assert.equal(getWasmCallCount('binary'), 0);
  } finally {
    if (prevEnv === undefined) delete process.env.HEX_ENGINE;
    else process.env.HEX_ENGINE = prevEnv;
  }
});
