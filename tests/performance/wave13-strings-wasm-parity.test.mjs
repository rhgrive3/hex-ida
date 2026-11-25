/**
 * Wave 13 K4 Strings Scanner WASM Parity Test.
 *
 * Verifies 0-diff parity between JS and WASM string scanning across:
 *   1. All 13 real multi-arch corpus binaries (`openBinary(..., { strings: true })`).
 *   2. UTF-8 multibyte (Japanese, emoji, TAB, overlong invalid sequences, lone surrogates,
 *      C1 control chars 0x7f..0x9f, truncated sequences).
 *   3. UTF-16LE / UTF-16BE / `utf16: 'both'` / `utf16: false` / even & odd byte parity.
 *   4. `minLength` / `maxLength` / `limit` boundary splitting and capping.
 *   5. Overlapping section union (#8736).
 *   6. Telemetry (`getWasmCallCount('strings') > 0` in WASM mode, `=== 0` in `_engine: 'js'`
 *      and `globalThis.HEX_ENGINE = 'js'` rollback modes).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { openBinary } from '../../js/binary/index.js';
import { BinaryImage } from '../../js/binary/model.js';
import { scanStrings } from '../../js/binary/strings.js';
import { buildSampleBinary } from '../../js/sample.js';
import {
  getWasmCallCount,
  resetAllTelemetry,
} from '../../js/core/wasm-telemetry.js';

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

function makeRawImage(bytes, { endian = 'little', sectionName = '.rodata' } = {}) {
  const image = new BinaryImage(bytes, { format: 'raw', arch: 'arm64', bits: 64, endian });
  image.addSection({
    name: sectionName,
    address: 0x1000n,
    size: BigInt(bytes.length),
    fileOffset: 0n,
    fileSize: BigInt(bytes.length),
    perms: { read: true },
  });
  return image;
}

function encodeUtf16(str, be = false) {
  const out = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (be) {
      out[i * 2] = (code >> 8) & 0xff;
      out[i * 2 + 1] = code & 0xff;
    } else {
      out[i * 2] = code & 0xff;
      out[i * 2 + 1] = (code >> 8) & 0xff;
    }
  }
  return out;
}

function concatBytes(...chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. All 13 real binaries: 0-diff parity between _engine: 'js' and 'wasm'
// ---------------------------------------------------------------------------
test('Wave 13 K4: all 13 real binaries produce 0-diff identical strings in JS vs WASM mode', (t) => {
  const summary = [];

  for (const spec of REAL_CORPUS_SPECS) {
    const bytes = spec.bytes || new Uint8Array(fs.readFileSync(spec.file));

    resetAllTelemetry();
    const jsImg = openBinary(bytes, { strings: true, _engine: 'js' });
    const jsStringsCalls = getWasmCallCount('strings');
    assert.equal(
      jsStringsCalls,
      0,
      `${spec.id}: _engine: 'js' must record 0 WASM 'strings' calls, got ${jsStringsCalls}`,
    );

    resetAllTelemetry();
    const wasmImg = openBinary(bytes, { strings: true, _engine: 'wasm' });
    const wasmStringsCalls = getWasmCallCount('strings');

    assert.deepStrictEqual(
      wasmImg.strings,
      jsImg.strings,
      `${spec.id}: WASM strings output diverged from JS oracle`,
    );

    if (jsImg.strings.length > 0) {
      assert.ok(
        wasmStringsCalls > 0,
        `${spec.id}: expected getWasmCallCount('strings') > 0 in WASM mode, got ${wasmStringsCalls}`,
      );
    }

    summary.push({
      id: spec.id,
      count: jsImg.strings.length,
      wasmCalls: wasmStringsCalls,
    });
  }

  t.diagnostic(JSON.stringify({ binaries: summary.length, summary }));
});

// ---------------------------------------------------------------------------
// 2. UTF-8 multibyte, invalid sequences, control chars, TAB, truncated tail
// ---------------------------------------------------------------------------
test('Wave 13 K4: UTF-8 multibyte, emoji, TAB, overlong, lone surrogate, and C1 control edge cases match 0-diff', () => {
  const enc = new TextEncoder();
  const payload = concatBytes(
    enc.encode('Hello\tWorld!'),
    new Uint8Array([0x00]),
    enc.encode('日本語テスト文字列'),
    new Uint8Array([0x00]),
    enc.encode('🚀🔥🎉✨'),
    new Uint8Array([0x00]),
    // Overlong 2/3/4-byte sequences (invalid UTF-8) surrounded by valid ASCII
    enc.encode('ABCD'),
    new Uint8Array([0xc0, 0xaf]),
    enc.encode('EFGH'),
    new Uint8Array([0xe0, 0x80, 0xaf]),
    enc.encode('IJKL'),
    new Uint8Array([0xf0, 0x80, 0x80, 0xaf]),
    enc.encode('MNOP'),
    // UTF-8 encoded lone surrogate U+D800 (0xed 0xa0 0x80)
    new Uint8Array([0xed, 0xa0, 0x80]),
    enc.encode('QRST'),
    // DEL (0x7f) and C1 control U+0080 (0xc2 0x80) / U+009F (0xc2 0x9f)
    new Uint8Array([0x7f]),
    enc.encode('UVWX'),
    new Uint8Array([0xc2, 0x80]),
    enc.encode('YZ01'),
    new Uint8Array([0xc2, 0x9f]),
    enc.encode('2345'),
    // Truncated 3-byte UTF-8 lead at end of buffer
    new Uint8Array([0xe3, 0x81]),
  );

  const image = makeRawImage(payload);
  resetAllTelemetry();
  const jsOut = scanStrings(image, { utf16: false, minLength: 4, _engine: 'js' });
  assert.equal(getWasmCallCount('strings'), 0);

  resetAllTelemetry();
  const wasmOut = scanStrings(image, { utf16: false, minLength: 4, _engine: 'wasm' });
  assert.ok(getWasmCallCount('strings') > 0, 'expected WASM strings scan to run for UTF-8 edge cases');
  assert.deepStrictEqual(wasmOut, jsOut);
  assert.ok(wasmOut.some((s) => s.text === 'Hello\tWorld!'));
  assert.ok(wasmOut.some((s) => s.text === '日本語テスト文字列'));
  assert.ok(wasmOut.some((s) => s.text === '🚀🔥🎉✨'));
});

// ---------------------------------------------------------------------------
// 3. UTF-16LE / UTF-16BE / both / false / even & odd parity + surrogates
// ---------------------------------------------------------------------------
test('Wave 13 K4: UTF-16LE, UTF-16BE, both, false, and even/odd parity match 0-diff', () => {
  const payload = concatBytes(
    // Even-aligned UTF-16LE with TAB and surrogate pair emoji
    encodeUtf16('EvenLE\t日本語🚀', false),
    new Uint8Array([0x00, 0x00, 0x00]), // 3-byte gap shifts next string to odd parity
    // Odd-aligned UTF-16LE
    encodeUtf16('OddLE123', false),
    new Uint8Array([0x00, 0x00]),
    // Lone high surrogate (0xd800) and lone low surrogate (0xdc00) in LE
    new Uint8Array([0x00, 0xd8, 0x00, 0xdc]),
    // Even-aligned UTF-16BE with Japanese + emoji
    encodeUtf16('EvenBE\tテスト🔥', true),
    new Uint8Array([0x00, 0x00, 0x00]),
    // Odd-aligned UTF-16BE
    encodeUtf16('OddBE456', true),
    new Uint8Array([0x00, 0x00]),
  );

  const image = makeRawImage(payload);
  for (const utf16 of ['le', 'be', 'both', false]) {
    resetAllTelemetry();
    const jsOut = scanStrings(image, { utf16, minLength: 4, _engine: 'js' });
    assert.equal(getWasmCallCount('strings'), 0, `utf16=${String(utf16)}: JS mode must not call WASM`);

    resetAllTelemetry();
    const wasmOut = scanStrings(image, { utf16, minLength: 4, _engine: 'wasm' });
    assert.ok(getWasmCallCount('strings') > 0, `utf16=${String(utf16)}: WASM mode must invoke strings scanner`);
    assert.deepStrictEqual(wasmOut, jsOut, `utf16=${String(utf16)}: WASM vs JS mismatch`);
  }
});

// ---------------------------------------------------------------------------
// 4. minLength / maxLength / limit edge cases
// ---------------------------------------------------------------------------
test('Wave 13 K4: minLength, maxLength splitting, and limit truncation match 0-diff', () => {
  const enc = new TextEncoder();
  const payload = concatBytes(
    enc.encode('ab'),
    new Uint8Array([0x00]),
    enc.encode('abcdefghijklmno'),
    new Uint8Array([0x00]),
    enc.encode('0123456789ABCDEF'),
    new Uint8Array([0x00]),
    encodeUtf16('WideStringAlphaBeta', false),
  );
  const image = makeRawImage(payload);

  const configs = [
    { minLength: 2, maxLength: 4096, limit: 100, utf16: 'both' },
    { minLength: 4, maxLength: 6, limit: 100, utf16: 'le' },
    { minLength: 8, maxLength: 10, limit: 2, utf16: 'both' },
    { minLength: 2, maxLength: 4, limit: 1, utf16: false },
  ];

  for (const cfg of configs) {
    resetAllTelemetry();
    const jsOut = scanStrings(image, { ...cfg, _engine: 'js' });
    assert.equal(getWasmCallCount('strings'), 0);

    resetAllTelemetry();
    const wasmOut = scanStrings(image, { ...cfg, _engine: 'wasm' });
    assert.ok(getWasmCallCount('strings') > 0);
    assert.deepStrictEqual(wasmOut, jsOut, `config ${JSON.stringify(cfg)} mismatch`);
  }
});

// ---------------------------------------------------------------------------
// 5. Overlapping sections union (#8736) & globalThis.HEX_ENGINE rollback
// ---------------------------------------------------------------------------
test('Wave 13 K4: overlapping section union (#8736) and globalThis.HEX_ENGINE="js" rollback match 0-diff', () => {
  const payload = new Uint8Array(4096 + 64);
  payload.fill(0x41, 32, 32 + 4096);
  for (let at = 32; at < 32 + 4096; at += 97) payload[at] = 0x00;

  const image = new BinaryImage(payload, { format: 'test', arch: 'x86_64', bits: 64 });
  for (let i = 0; i < 64; i += 1) {
    image.addSection({
      name: `.alias${i}`,
      address: BigInt(0x1000 + i * 0x1000),
      size: 4096n,
      fileOffset: 32n,
      fileSize: 4096n,
      perms: { read: true },
    });
  }
  image.addSection({
    name: '.partial',
    address: 0x90000n,
    size: 1024n,
    fileOffset: 16n,
    fileSize: 1024n,
    perms: { read: true },
  });

  resetAllTelemetry();
  const jsOut = scanStrings(image, { utf16: false, minLength: 4, _engine: 'js' });
  assert.equal(getWasmCallCount('strings'), 0);

  resetAllTelemetry();
  const wasmOut = scanStrings(image, { utf16: false, minLength: 4, _engine: 'wasm' });
  assert.ok(getWasmCallCount('strings') > 0);
  assert.deepStrictEqual(wasmOut, jsOut);

  // Verify globalThis.HEX_ENGINE = 'js' rollback
  const prevGlobal = globalThis.HEX_ENGINE;
  try {
    globalThis.HEX_ENGINE = 'js';
    resetAllTelemetry();
    const rollbackOut = scanStrings(image, { utf16: false, minLength: 4 });
    assert.equal(getWasmCallCount('strings'), 0, 'globalThis.HEX_ENGINE="js" must bypass WASM strings scanner');
    assert.deepStrictEqual(rollbackOut, jsOut);
  } finally {
    if (prevGlobal === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prevGlobal;
  }
});
