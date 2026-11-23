import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveModelTexts } from '../../js/analyze.js';
import {
  closeFunctionOutput,
  isStandaloneGlobalPreludeDeclaration,
} from '../../js/decompiler/c-output-closure.js';

function makeResult(lines) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
  };
}

function checkGccSyntax(cSource, label = 'gcc-syntax') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-pass8-rodata-'));
  const srcPath = path.join(tmpDir, 'test.c');
  try {
    fs.writeFileSync(srcPath, cSource, 'utf8');
    execFileSync('gcc', ['-fsyntax-only', '-Wall', '-Wextra', '-x', 'c', srcPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    assert.fail(`${label} failed:\n--- C source ---\n${cSource}\n--- stderr ---\n${stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Fix 1: resolveModelTexts preserves raw .rodata FP bytes even on looksLikeText collision
// ============================================================================

test('Fix 1: resolveModelTexts preserves 8-byte IEEE-754 double 1.3001 bytes despite ">yX" looksLikeText collision', async () => {
  const doubleBytes = new Uint8Array(8);
  new DataView(doubleBytes.buffer).setFloat64(0, 1.3001, true);
  // 1.3001 IEEE-754 LE starts with 0x3e ('>'), 0x79 ('y'), 0x58 ('X'), 0xa8 (non-ASCII).
  assert.equal(String.fromCharCode(doubleBytes[0], doubleBytes[1], doubleBytes[2]), '>yX');

  const floatBytes = new Uint8Array([0x41, 0x31, 0x00, 0x40]); // "A1\0@" -> looksLikeText true
  const dataBytes = new Uint8Array([0x41, 0x31, 0x00, 0x40, 0, 0, 0, 0]);

  const memory = new Map([
    [String(0xa40n), { found: true, region: '.rodata', bytes: doubleBytes, text: '>yX', terminated: true }],
    [String(0xa48n), { found: true, region: '.rodata.cst4', bytes: floatBytes, text: 'A1', terminated: true }],
    [String(0x2000n), { found: true, region: '.data', bytes: dataBytes, text: 'A1', terminated: true }],
  ]);

  const backend = {
    async readAt(addr) {
      return memory.get(BigInt(addr).toString()) || { found: false };
    },
  };

  const makeValue = () => ({ kind: 'addr', ev: [] });
  const model = {
    addressRefs: [
      { row: 1, addr: 0xa40n, value: makeValue(), load: true },
      { row: 2, addr: 0xa48n, value: makeValue(), load: true },
      { row: 3, addr: 0xa48n, value: makeValue() }, // direct ref to same addr
      { row: 4, addr: 0x2000n, value: makeValue(), load: true }, // writable .data load
    ],
    semantic: [],
    facts: { stringRefs: [], strings: [] },
    calls: [],
  };

  await resolveModelTexts(backend, model, 96, { architecture: 'arm64' });

  // Double 1.3001 load ref must carry exact 8 IEEE-754 bytes even though text ">yX" matched looksLikeText.
  assert.deepEqual(model.addressRefs[0].bytes, Array.from(doubleBytes));
  const decodedDouble = new DataView(Uint8Array.from(model.addressRefs[0].bytes).buffer).getFloat64(0, true);
  assert.equal(decodedDouble, 1.3001);

  // Float .rodata.cst4 load ref also preserves raw bytes even though text "A1" matched.
  assert.deepEqual(model.addressRefs[1].bytes, Array.from(floatBytes));

  // Direct non-load ref still resolves text without attaching load bytes.
  assert.equal(model.addressRefs[2].text, 'A1');
  assert.equal(model.addressRefs[2].bytes, undefined);

  // Writable .data load ref must not attach read-only literal pool bytes.
  assert.equal(model.addressRefs[3].bytes, undefined);
});

// ============================================================================
// Fix 2: Standalone .data/.rodata global initialization & uint128 closure
// ============================================================================

test('Fix 2a: uint128 standalone global without binary data emits uint128 = 0 and compiles cleanly', () => {
  const closed = closeFunctionOutput(makeResult([
    { kind: 'sig', indent: 0, text: 'void copy128(void * dst)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: '*(uint128 *)dst = global_20048;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]));

  assert.match(closed.pseudocode, /static uint128 global_20048 = 0;/);
  assert.equal(isStandaloneGlobalPreludeDeclaration('static uint128 global_20048 = 0;'), true);
  checkGccSyntax(closed.pseudocode, 'fix2a-uint128-no-binary');

  // Strictly idempotent on second pass.
  const once = closed.pseudocode;
  closeFunctionOutput(closed);
  assert.equal(closed.pseudocode, once);
});

test('Fix 2b: uint128 and scalar globals initialize from .rodata section bytes', () => {
  const rodata = new Uint8Array(24);
  const view = new DataView(rodata.buffer);
  view.setBigUint64(0, 0x1122334455667788n, true);
  view.setBigUint64(8, 0x99aabbccddeeff00n, true);
  view.setFloat64(16, 1.3001, true);

  const opts = {
    binary: {
      sections: [
        { name: '.rodata', addr: 0xa40n, size: rodata.length, bytes: rodata, readOnly: true },
      ],
    },
  };

  const closed = closeFunctionOutput(makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 load_consts(void * dst)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: '*(uint128 *)dst = global_A40;' },
    { kind: 'ctrl', indent: 1, text: 'return global_A50;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]), opts);

  const expected128 = 'static uint128 global_A40 = (((uint128)0x99aabbccddeeff00ULL << 64) | (uint128)0x1122334455667788ULL);';
  assert.ok(closed.pseudocode.includes(expected128), `expected 128-bit initializer in:\n${closed.pseudocode}`);
  assert.equal(isStandaloneGlobalPreludeDeclaration(expected128), true);

  const doubleBits = view.getBigUint64(16, true).toString(16);
  const expected64 = `static uint64 global_A50 = 0x${doubleBits}ULL;`;
  assert.ok(closed.pseudocode.includes(expected64), `expected 64-bit initializer in:\n${closed.pseudocode}`);
  assert.equal(isStandaloneGlobalPreludeDeclaration(expected64), true);

  checkGccSyntax(closed.pseudocode, 'fix2b-rodata-bytes');

  // Strictly idempotent on second pass.
  const once = closed.pseudocode;
  closeFunctionOutput(closed, opts);
  assert.equal(closed.pseudocode, once);
});

test('Fix 2c: ELF R_AARCH64_RELATIVE relocations initialize uint128, address-taken buffer, and dereferenced string pointer globals', () => {
  const enc = new TextEncoder();
  const str0 = enc.encode('alpha\0');
  const str1 = enc.encode('beta\0');
  const str2 = enc.encode('gamma\0');
  const rodata = new Uint8Array(str0.length + str1.length + str2.length);
  rodata.set(str0, 0);
  rodata.set(str1, str0.length);
  rodata.set(str2, str0.length + str1.length);

  const roBase = 0x1000n;
  const s0Addr = roBase;
  const s1Addr = roBase + BigInt(str0.length);
  const s2Addr = roBase + BigInt(str0.length + str1.length);

  const dataRelRo = new Uint8Array(32); // 4 x 8-byte pointer slots
  const opts = {
    binary: {
      sections: [
        { name: '.rodata', addr: roBase, size: rodata.length, bytes: rodata, readOnly: true },
        { name: '.data.rel.ro', addr: 0x20048n, size: dataRelRo.length, bytes: dataRelRo },
      ],
      relocations: [
        { address: 0x20048n, type: 1027, addend: s0Addr }, // R_AARCH64_RELATIVE -> "alpha"
        { address: 0x20050n, type: 1027, addend: s1Addr }, // R_AARCH64_RELATIVE -> "beta"
        { address: 0x20058n, type: 1027, addend: s2Addr }, // R_AARCH64_RELATIVE -> "gamma"
      ],
    },
  };

  // Case 1: uint128 load of two relocated string pointers at 0x20048
  const closedU128 = closeFunctionOutput(makeResult([
    { kind: 'sig', indent: 0, text: 'void load_pair(void * dst)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: '*(uint128 *)dst = global_20048;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]), opts);

  assert.match(closedU128.pseudocode, /static uint64 __hex_global_20048_buf\[2\] = \{ \(uint64\)\(uintptr_t\)"alpha", \(uint64\)\(uintptr_t\)"beta" \};/);
  assert.match(closedU128.pseudocode, /#define global_20048 \(\*\(uint128 \*\)&__hex_global_20048_buf\[0\]\)/);
  assert.equal(
    isStandaloneGlobalPreludeDeclaration('static uint64 __hex_global_20048_buf[2] = { (uint64)(uintptr_t)"alpha", (uint64)(uintptr_t)"beta" };'),
    true,
  );
  assert.equal(
    isStandaloneGlobalPreludeDeclaration('#define global_20048 (*(uint128 *)&__hex_global_20048_buf[0])'),
    true,
  );
  checkGccSyntax(closedU128.pseudocode, 'fix2c-reloc-uint128');

  const onceU128 = closedU128.pseudocode;
  closeFunctionOutput(closedU128, opts);
  assert.equal(closedU128.pseudocode, onceU128);

  // Case 2: address-taken &global_20048 initializes full pointer table in buf[512]
  const closedArr = closeFunctionOutput(makeResult([
    { kind: 'sig', indent: 0, text: 'const char * pick_str(uint64 idx)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'const char ** tbl = (const char **)&global_20048;' },
    { kind: 'ctrl', indent: 1, text: 'return tbl[idx];' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]), opts);

  assert.match(
    closedArr.pseudocode,
    /static uint64 __hex_global_20048_buf\[512\] = \{ \(uint64\)\(uintptr_t\)"alpha", \(uint64\)\(uintptr_t\)"beta", \(uint64\)\(uintptr_t\)"gamma" \};/,
  );
  assert.match(closedArr.pseudocode, /#define global_20048 \(__hex_global_20048_buf\[0\]\)/);
  checkGccSyntax(closedArr.pseudocode, 'fix2c-reloc-array');

  // Case 3: dereferenced single global_20058 with relocation resolves directly to string pointer
  const closedDeref = closeFunctionOutput(makeResult([
    { kind: 'sig', indent: 0, text: 'uint8 first_ch(void)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'ctrl', indent: 1, text: 'return *(const uint8 *)(uintptr_t)global_20058;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]), opts);

  assert.match(closedDeref.pseudocode, /static uint64 global_20058 = \(uint64\)\(uintptr_t\)"gamma";/);
  assert.doesNotMatch(closedDeref.pseudocode, /__hex_global_20058_backing/);
  assert.equal(isStandaloneGlobalPreludeDeclaration('static uint64 global_20058 = (uint64)(uintptr_t)"gamma";'), true);
  checkGccSyntax(closedDeref.pseudocode, 'fix2c-reloc-deref');
});

test('Fix 2d: isGlobalAddressTaken distinguishes cast-& with space from bitwise AND after parenthesized expr', () => {
  const closed = closeFunctionOutput(makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 edge_cases(uint64 a1, char ** out)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: '*out = (char *)& global_20048;' },
    { kind: 'stmt', indent: 1, text: 'uint64 masked = (a1 + 1)&global_30000;' },
    { kind: 'ctrl', indent: 1, text: 'return masked;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]));

  // Cast followed by `& global_20048` (with space) must still be treated as address-taken.
  assert.match(closed.pseudocode, /static uint64 __hex_global_20048_buf\[512\] = \{0\};/);
  assert.match(closed.pseudocode, /#define global_20048 \(__hex_global_20048_buf\[0\]\)/);

  // Bitwise AND `(a1 + 1)&global_30000` must NOT be misclassified as address-taken.
  assert.match(closed.pseudocode, /static uint64 global_30000 = 0;/);
  assert.doesNotMatch(closed.pseudocode, /__hex_global_30000_buf/);

  checkGccSyntax(closed.pseudocode, 'fix2d-address-taken-edges');
});
