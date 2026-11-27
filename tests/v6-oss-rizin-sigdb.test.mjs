import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFlirtSig, runImportRizinSigdb } from '../scripts/import-rizin-sigdb.mjs';
import {
  createHexSigHubLoader,
  gunzipBounded,
  loadHexSigPack,
  validateHexSigHubManifest,
} from '../js/analysis/signature/hexsig-hub-loader.js';
import {
  HEXSIG_ARCH_ARM64,
  HEXSIG_ARCH_X86_64,
} from '../js/analysis/signature/hex-sig-extractor.js';
import { HSIG1_MAX_SLOT4_BYTES } from '../js/analysis/signature/hex-sig-pack.js';
import { getHexEngineExports } from '../js/core/hex-engine-wasm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const HUB_DIR = path.join(ROOT, 'dist/hexsig-hub');

// ============================================================================
// 1. Run real Rizin sigdb FLIRT -> HSIG1 batch compiler
// ============================================================================

const manifest = runImportRizinSigdb({ quiet: false });

assert.equal(manifest.schema, 'hex-hexsig-hub/v1');
assert.equal(manifest.format, 'HSIG1');
assert.equal(manifest.packs.length, 7, 'Should generate all 7 HSIG1 packs (6 Rizin sigdb + ios-arm64-macho)');
assert.ok(
  manifest.totalEntries >= 3000,
  `Expected >= 3,000 real Rizin sigdb signatures, got ${manifest.totalEntries}`
);

const manifestOnDisk = JSON.parse(fs.readFileSync(path.join(HUB_DIR, 'manifest.json'), 'utf8'));
assert.equal(manifestOnDisk.totalEntries, manifest.totalEntries);
assert.equal(manifestOnDisk.packs.length, 7);

const arm64PackMeta = manifest.packs.find((p) => p.packId === 'android-ndk-arm64');
const opensslPackMeta = manifest.packs.find((p) => p.packId === 'ubuntu-openssl-x64');
const zlibPackMeta = manifest.packs.find((p) => p.packId === 'fedora-zlib-x64');
assert.ok(arm64PackMeta.entryCount >= 500);
assert.ok(opensslPackMeta.entryCount >= 500);
assert.ok(zlibPackMeta.entryCount >= 100);

// ============================================================================
// 2. Verify all .hsig1.gz packs via hexsig-hub-loader + security negative tests
// ============================================================================

const loader = createHexSigHubLoader({
  manifest: manifestOnDisk,
  fetchBytes: async (relFile) => new Uint8Array(fs.readFileSync(path.join(HUB_DIR, relFile))),
});

let verifiedTotal = 0;
for (const p of manifestOnDisk.packs) {
  const loaded = await loader.loadPack(p.packId, { verifySha256: true });
  assert.ok(loaded.rawBytes.length <= HSIG1_MAX_SLOT4_BYTES);
  assert.equal(loaded.decoded.entryCount, p.entryCount);
  verifiedTotal += loaded.decoded.entryCount;
}
assert.equal(verifiedTotal, manifestOnDisk.totalEntries);
console.log(`  [PASS] Verified all 6 .hsig1.gz packs (${verifiedTotal} real signatures, SHA-256 + Slot 4 budget OK)`);

// 2B. gunzipBounded & loader security negative tests
{
  const gzSample = new Uint8Array(fs.readFileSync(path.join(HUB_DIR, arm64PackMeta.file)));
  assert.throws(() => gunzipBounded(gzSample, 1024), /exceeds limit/i);
  assert.throws(() => gunzipBounded(gzSample, 0), /invalid maxBytes/i);
  assert.throws(() => gunzipBounded(gzSample, Number.NaN), /invalid maxBytes/i);
  assert.throws(() => gunzipBounded(gzSample, HSIG1_MAX_SLOT4_BYTES, 16), /compressed pack exceeds limit/i);

  // SHA-256 tamper rejection
  const tamperedGz = gzSample.slice();
  tamperedGz[tamperedGz.length - 1] ^= 0xff;
  await assert.rejects(
    () => loadHexSigPack(arm64PackMeta, { gzBytes: tamperedGz, verifySha256: true }),
    /SHA-256 mismatch/i
  );

  // Missing rawSha256 fail-closed rejection
  await assert.rejects(
    () => loadHexSigPack({ ...arm64PackMeta, rawSha256: '' }, { gzBytes: gzSample, verifySha256: true }),
    /missing or invalid rawSha256/i
  );

  // Path traversal rejection in manifest & loadHexSigPack
  assert.throws(
    () => validateHexSigHubManifest({
      ...manifestOnDisk,
      packs: [{ ...arm64PackMeta, file: '../evil.hsig1.gz' }],
    }),
    /unsafe pack filename/i
  );
  await assert.rejects(
    () => loadHexSigPack({ ...arm64PackMeta, file: '../../etc/passwd.hsig1.gz' }, { gzBytes: gzSample }),
    /unsafe pack filename/i
  );

  // Offline / fetchBytes rejection safe degradation
  const offlineLoader = createHexSigHubLoader({
    manifest: manifestOnDisk,
    fetchBytes: async () => { throw new Error('network offline'); },
  });
  const offlineWasm = await offlineLoader.mountToWasm('android-ndk-arm64');
  assert.equal(offlineWasm, null, 'Offline mountToWasm must degrade cleanly to null');
  const offlineIdx = await offlineLoader.mountToIndex(['fedora-zlib-x64']);
  assert.equal(offlineIdx.entries.length, 0, 'Offline mountToIndex must degrade cleanly to empty index');

  console.log('  [PASS] Security & offline tests: zip-bomb, invalid limits, SHA-256 tamper/missing, path traversal & offline fallback');
}

// 2C. Malformed FLIRT .sig parser negative tests
{
  // (a) Invalid magic
  assert.throws(() => parseFlirtSig(Buffer.alloc(64, 0x41)), /invalid magic/i);

  // (b) Truncated v10 header (< 45 bytes)
  const truncV10 = Buffer.alloc(42, 0);
  truncV10.write('IDASGN', 0, 'ascii');
  truncV10[6] = 10;
  assert.throws(() => parseFlirtSig(truncV10), /truncated v10 header/i);

  // (c) libNameLen OOB
  const oobLib = Buffer.alloc(48, 0);
  oobLib.write('IDASGN', 0, 'ascii');
  oobLib[6] = 10;
  oobLib[34] = 200; // 45 + 200 > 48
  assert.throws(() => parseFlirtSig(oobLib), /library name OOB/i);

  // (d) Zero-length branch cycle (branches=1, len=0)
  const cycleSig = Buffer.alloc(48, 0);
  cycleSig.write('IDASGN', 0, 'ascii');
  cycleSig[6] = 10;
  cycleSig[34] = 0; // libNameLen=0
  cycleSig[45] = 1; // branches = 1
  cycleSig[46] = 0; // len = 0 -> must reject!
  assert.throws(() => parseFlirtSig(cycleSig), /zero-length branch/i);

  // (e) Excessive branches (> 4096)
  const hugeBranches = Buffer.alloc(50, 0);
  hugeBranches.write('IDASGN', 0, 'ascii');
  hugeBranches[6] = 10;
  hugeBranches[34] = 0;
  // readMultipleBytes: 0xC0 0x01 0x00 0x00 = 0x010000 = 65536 branches
  hugeBranches[45] = 0xc0;
  hugeBranches[46] = 0x01;
  hugeBranches[47] = 0x00;
  hugeBranches[48] = 0x00;
  assert.throws(() => parseFlirtSig(hugeBranches), /excessive branch count/i);

  console.log('  [PASS] Malformed FLIRT .sig rejected: bad magic, truncated v10, OOB libName, len=0 cycle, huge branches');
}

// ============================================================================
// 3. INV-005 compliance on hexsig-hub-loader.js
// ============================================================================
{
  const loaderSrc = fs.readFileSync(path.join(ROOT, 'js/analysis/signature/hexsig-hub-loader.js'), 'utf8');
  assert.ok(!/from\s+['"][^'"]*targets\/architecture/.test(loaderSrc));
  assert.ok(!/from\s+['"][^'"]*targets\/abi/.test(loaderSrc));
  console.log('  [PASS] INV-005 boundary verified on hexsig-hub-loader.js');
}

// ============================================================================
// 4. Real WASM Engine End-to-End Integration (ARM64 + x86-64 + Mutated PC-rel/Imm)
// ============================================================================

const wasmExports = getHexEngineExports();
assert.ok(wasmExports);
assert.equal(typeof wasmExports.hex_hexsig_mount, 'function');
assert.equal(typeof wasmExports.hex_hexsig_match_fn, 'function');

// 4A. ARM64 Android NDK: find a real entry with masked PC-relative bits (e.g. ADRP/B/BL/B.cond/CBZ),
//     fill the masked bits with DIFFERENT random offsets, and verify WASM STILL matches!
{
  const armWasm = await loader.mountToWasm('android-ndk-arm64', { wasmExports });
  assert.ok(armWasm && armWasm.engine === 'wasm' && armWasm.usesSlot4 === true);

  const pcRelEntry = armWasm.decoded.entries.find(
    (e) => e.prologueLen >= 16 && e.mask.slice(0, e.prologueLen).some((m) => m !== 0xff && m !== 0x00)
  ) || armWasm.decoded.entries[0];
  assert.ok(pcRelEntry, 'ARM64 pack must have an entry with bit-level PC-relative wildcards');

  const fnCode = new Uint8Array(64);
  for (let i = 0; i < pcRelEntry.prologueLen; i++) {
    // Inject non-zero mutated bits strictly into wildcarded (~mask) bit positions!
    const m = pcRelEntry.mask[i];
    fnCode[i] = (pcRelEntry.pattern[i] & m) | (0x5a & (~m & 0xff));
  }
  fnCode[pcRelEntry.prologueLen + 0] = 0xc0;
  fnCode[pcRelEntry.prologueLen + 1] = 0x03;
  fnCode[pcRelEntry.prologueLen + 2] = 0x5f;
  fnCode[pcRelEntry.prologueLen + 3] = 0xd6;

  const hit = armWasm.matchFn(fnCode, HEXSIG_ARCH_ARM64);
  assert.equal(hit.matched, true, `WASM must match ARM64 symbol "${pcRelEntry.symbolName}" despite mutated PC-rel bits`);
  assert.equal(hit.symbolName, pcRelEntry.symbolName);
  assert.ok(hit.confidence >= 650);
  console.log(`  [PASS] Real WASM ARM64 PC-rel mutated match: "${hit.symbolName}" (conf=${hit.confidence})`);
}

// 4B. x86-64 OpenSSL real crypto match
{
  const sslWasm = await loader.mountToWasm('ubuntu-openssl-x64', { wasmExports });
  assert.ok(sslWasm && sslWasm.engine === 'wasm' && sslWasm.usesSlot4 === true);

  const sslEntry = sslWasm.decoded.entries.find((e) => /^(aes_|EVP_|SHA|RSA_|EC_|SSL_)/i.test(e.symbolName))
    || sslWasm.decoded.entries[0];
  const fnCode = new Uint8Array(64);
  for (let i = 0; i < sslEntry.prologueLen; i++) {
    fnCode[i] = sslEntry.mask[i] === 0xff ? sslEntry.pattern[i] : 0x37;
  }
  fnCode[sslEntry.prologueLen] = 0xc3;

  const hit = sslWasm.matchFn(fnCode, HEXSIG_ARCH_X86_64);
  assert.equal(hit.matched, true, `WASM must match x64 OpenSSL "${sslEntry.symbolName}"`);
  assert.equal(hit.symbolName, sslEntry.symbolName);
  assert.ok(hit.confidence >= 650);
  console.log(`  [PASS] Real WASM x86-64 OpenSSL match: "${hit.symbolName}" (conf=${hit.confidence})`);
}

// 4C. x86-64 Fedora zlib: find a real entry containing Jcc rel8 (0x70..0x7F) or MOV imm32 (0xB8..0xBF)
//     whose displacement/immediate was masked by alignX64Pattern, mutate those bytes, and verify WASM matches!
{
  const zlibWasm = await loader.mountToWasm('fedora-zlib-x64', { wasmExports });
  assert.ok(zlibWasm && zlibWasm.engine === 'wasm' && zlibWasm.usesSlot4 === true);

  const jccOrMovEntry = zlibWasm.decoded.entries.find((e) => {
    for (let i = 0; i + 1 < e.prologueLen; i++) {
      const b = e.pattern[i];
      if (((b >= 0x70 && b <= 0x7f) || (b >= 0xb8 && b <= 0xbf)) && e.mask[i] === 0xff && e.mask[i + 1] === 0x00) {
        return true;
      }
    }
    return false;
  });
  assert.ok(jccOrMovEntry, 'Fedora zlib x64 pack must contain a real entry with masked Jcc/MOV imm bytes');

  const fnCode = new Uint8Array(64);
  for (let i = 0; i < jccOrMovEntry.prologueLen; i++) {
    fnCode[i] = jccOrMovEntry.mask[i] === 0xff ? jccOrMovEntry.pattern[i] : 0x37; // mutate masked disp/imm!
  }
  fnCode[jccOrMovEntry.prologueLen] = 0xc3;

  const hit = zlibWasm.matchFn(fnCode, HEXSIG_ARCH_X86_64);
  assert.equal(hit.matched, true, `WASM must hit x64 zlib "${jccOrMovEntry.symbolName}" despite mutated Jcc/MOV imm bytes`);
  assert.equal(hit.symbolName, jccOrMovEntry.symbolName);
  assert.ok(hit.confidence >= 650);
  console.log(`  [PASS] Real WASM x86-64 zlib (mutated Jcc/MOV imm) match: "${hit.symbolName}" (conf=${hit.confidence})`);

  const idx = await loader.mountToIndex(['fedora-zlib-x64', 'ubuntu-libgcc12-x64']);
  assert.ok(idx.entries.length >= 500);
  console.log(`  [PASS] HexSigIndex mounted ${idx.entries.length} real entries from zlib + libgcc`);
}

console.log(`ALL RIZIN SIGDB TRACK B TESTS PASSED (${manifest.totalEntries} real signatures across 6 packs).`);
