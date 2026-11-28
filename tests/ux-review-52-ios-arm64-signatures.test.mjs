import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEXSIG_LIB_KIND,
  HEXSIG_LIB_HINT_BIT,
  BUILTIN_HEXSIG_LIBS,
  BUILTIN_HEXSIG_ENTRIES,
  buildBuiltinHexSigDb,
} from '../js/analysis/signature/hexsig-db-data.js';
import {
  HEXSIG_ARCH_ARM64,
  HEXSIG_ARCH_X86_64,
  computeConstHash64,
  computeStringHash64,
} from '../js/analysis/signature/hex-sig-extractor.js';
import { HexSigIndex, HEXSIG_VERDICT } from '../js/analysis/signature/hex-sig-index.js';
import { encodeHsig1Pack, decodeHsig1Pack, HSIG1_MAX_SLOT4_BYTES } from '../js/analysis/signature/hex-sig-pack.js';
import {
  isPlausibleArm64Code,
  normalizeHexSigLibName,
  buildHexSigMatchQuery,
  createHexSigAutoScanner,
} from '../js/analysis/signature/hexsig-auto-scanner.js';
import { AUTO_ANALYSIS_STATUS } from '../js/analysis/common/v6-auto-contracts.js';

function hexToBytes(hexStr) {
  const parts = hexStr.trim().split(/\s+/);
  const out = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    out[i] = parseInt(parts[i], 16) & 0xff;
  }
  return out;
}

/**
 * Materialize concrete valid ARM64 bytes from a signature entry's pattern/mask,
 * filling wildcard bytes with non-zero branch/page offset bytes and appending valid ARM64 epilogue.
 */
function materializeArm64FromEntry(entry) {
  const len = entry.prologueLen ?? entry.length;
  const buf = new Uint8Array(Math.max(48, len + 16));
  for (let i = 0; i < len; i++) {
    buf[i] = entry.mask[i] === 0xff ? entry.pattern[i] : ((0x14 + i * 3) & 0xff);
  }
  // Fill trailing instructions with valid ARM64 NOP (d503201f) and RET (d65f03c0)
  for (let off = len; off + 4 <= buf.length - 4; off += 4) {
    buf[off] = 0x1f;
    buf[off + 1] = 0x20;
    buf[off + 2] = 0x03;
    buf[off + 3] = 0xd5;
  }
  buf[buf.length - 4] = 0xc0;
  buf[buf.length - 3] = 0x03;
  buf[buf.length - 2] = 0x5f;
  buf[buf.length - 1] = 0xd6;
  return buf;
}

/**
 * Valid iOS arm64e (PACIBSP + alternate frame) function prologue that does NOT match
 * any exact DB prologue bytes, used to test compiler-variant anchor matching.
 */
const ALT_IOS_ARM64_PROLOGUE = hexToBytes(
  '7f 23 03 d5 ' + // pacibsp
  'ff 43 02 d1 ' + // sub sp, sp, #0x90
  'f4 4f 07 a9 ' + // stp x20, x19, [sp, #0x70]
  'fd 7b 08 a9 ' + // stp x29, x30, [sp, #0x80]
  'fd 03 02 91 ' + // add x29, sp, #0x80
  '1f 20 03 d5 ' + // nop
  'e0 03 1f aa ' + // mov x0, xzr
  'c0 03 5f d6'    // ret
);

describe('Review Item 5.2 — iOS arm64 Game Library Signatures', () => {
  it('registers all existing and new game library vendors with unique IDs and non-overlapping 16-bit hint masks', () => {
    // Existing IDs 0..7 preserved verbatim
    const expectedExisting = [
      [0, 'libc', HEXSIG_LIB_KIND.SYSTEM, HEXSIG_LIB_HINT_BIT.LIBC],
      [1, 'crt', HEXSIG_LIB_KIND.RUNTIME, HEXSIG_LIB_HINT_BIT.CRT],
      [2, 'zlib', HEXSIG_LIB_KIND.LIBRARY, HEXSIG_LIB_HINT_BIT.ZLIB],
      [3, 'libpng', HEXSIG_LIB_KIND.LIBRARY, HEXSIG_LIB_HINT_BIT.LIBPNG],
      [4, 'OpenSSL', HEXSIG_LIB_KIND.CRYPTO, HEXSIG_LIB_HINT_BIT.OPENSSL],
      [5, 'libc++abi', HEXSIG_LIB_KIND.RUNTIME, HEXSIG_LIB_HINT_BIT.CXX_RUNTIME],
      [6, 'UnityEngine', HEXSIG_LIB_KIND.ENGINE, HEXSIG_LIB_HINT_BIT.UNITY],
      [7, 'Darwin', HEXSIG_LIB_KIND.SYSTEM, HEXSIG_LIB_HINT_BIT.DARWIN],
    ];
    for (const [id, vendorName, kindId, hintMask] of expectedExisting) {
      const lib = BUILTIN_HEXSIG_LIBS[id];
      assert.ok(lib, `missing existing lib id ${id}`);
      assert.equal(lib.id, id);
      assert.equal(lib.vendorName, vendorName);
      assert.equal(lib.kindId, kindId);
      assert.equal(lib.hintMask, hintMask);
    }

    // New game-library vendors
    const expectedNew = [
      ['cocos2d-x', HEXSIG_LIB_KIND.ENGINE, HEXSIG_LIB_HINT_BIT.COCOS2DX],
      ['UnityIL2CPP', HEXSIG_LIB_KIND.ENGINE, HEXSIG_LIB_HINT_BIT.UNITY_IL2CPP],
      ['protobuf', HEXSIG_LIB_KIND.LIBRARY, HEXSIG_LIB_HINT_BIT.PROTOBUF],
      ['Firebase', HEXSIG_LIB_KIND.ANALYTICS, HEXSIG_LIB_HINT_BIT.FIREBASE],
      ['GoogleMobileAds', HEXSIG_LIB_KIND.ADS, HEXSIG_LIB_HINT_BIT.GOOGLE_MOBILE_ADS],
      ['Adjust', HEXSIG_LIB_KIND.ANALYTICS, HEXSIG_LIB_HINT_BIT.ADJUST],
    ];
    for (const [vendorName, kindId, hintMask] of expectedNew) {
      const lib = BUILTIN_HEXSIG_LIBS.find((l) => l.vendorName === vendorName);
      assert.ok(lib, `missing new vendor ${vendorName}`);
      assert.equal(lib.kindId, kindId);
      assert.equal(lib.hintMask, hintMask);
      assert.equal(normalizeHexSigLibName(lib), vendorName);
    }

    // No duplicate IDs, vendor names, or overlapping hint bits (all within 16-bit mask)
    const ids = new Set();
    const names = new Set();
    let combinedMask = 0;
    for (const lib of BUILTIN_HEXSIG_LIBS) {
      assert.equal(ids.has(lib.id), false, `duplicate lib id: ${lib.id}`);
      assert.equal(names.has(lib.vendorName), false, `duplicate vendorName: ${lib.vendorName}`);
      assert.ok(lib.hintMask > 0 && lib.hintMask <= 0xffff, `hintMask out of 16-bit range for ${lib.vendorName}`);
      assert.equal(combinedMask & lib.hintMask, 0, `overlapping hintMask for ${lib.vendorName}`);
      ids.add(lib.id);
      names.add(lib.vendorName);
      combinedMask |= lib.hintMask;
    }
  });

  it('validates all builtin signature entries: no duplicates, valid hashes/patterns, valid ARM64 code, HSIG1 round-trip', () => {
    const db = buildBuiltinHexSigDb();
    assert.equal(db.entries.length, BUILTIN_HEXSIG_ENTRIES.length);
    assert.ok(db.entries.length >= 60, `expected >= 60 builtin signatures, got ${db.entries.length}`);

    const seenKeys = new Set();
    const seenPatternsByArch = new Set();

    for (const entry of db.entries) {
      const key = `${entry.archId}:${entry.symbolName}`;
      assert.equal(seenKeys.has(key), false, `duplicate (archId, symbolName): ${key}`);
      seenKeys.add(key);

      const lib = BUILTIN_HEXSIG_LIBS[entry.libId];
      assert.ok(lib, `invalid libId ${entry.libId} on ${entry.symbolName}`);
      assert.ok(entry.patternHash64 !== 0n, `zero patternHash64 on ${entry.symbolName}`);
      assert.ok(entry.prologueLen >= 12 && entry.prologueLen <= 32, `invalid prologueLen on ${entry.symbolName}`);

      const patKey = `${entry.archId}:${Buffer.from(entry.pattern.subarray(0, entry.prologueLen)).toString('hex')}:${Buffer.from(entry.mask.subarray(0, entry.prologueLen)).toString('hex')}`;
      assert.equal(seenPatternsByArch.has(patKey), false, `duplicate pattern for ${entry.symbolName}`);
      seenPatternsByArch.add(patKey);

      if (entry.archId === HEXSIG_ARCH_ARM64) {
        assert.equal(entry.prologueLen % 4, 0, `ARM64 prologueLen must be 4-byte aligned for ${entry.symbolName}`);
        const materialized = materializeArm64FromEntry(entry);
        assert.equal(
          isPlausibleArm64Code(materialized),
          true,
          `materialized ARM64 bytes for ${entry.symbolName} must pass isPlausibleArm64Code`
        );
      }

      if (entry.strings.length > 0) {
        assert.equal(entry.fingerprint.l3StrHash64, computeStringHash64(entry.strings));
      }
      if (entry.constants.length > 0) {
        assert.equal(entry.fingerprint.l3ConstHash64, computeConstHash64(entry.constants));
      }
    }

    // HSIG1 binary pack round-trip fits well inside Slot 4 budget (224KB)
    const blob = encodeHsig1Pack({ entries: db.entries });
    assert.ok(blob.length <= HSIG1_MAX_SLOT4_BYTES, `HSIG1 blob exceeds Slot 4 cap: ${blob.length}`);
    const decoded = decodeHsig1Pack(blob);
    assert.equal(decoded.entryCount, db.entries.length);
  });

  it('matches exact ARM64 prologue signatures across all 9 target game/SDK libraries', async () => {
    const db = buildBuiltinHexSigDb();
    const index = new HexSigIndex(db.entries, db.libs);

    const targets = [
      { symbol: 'CCDirector::sharedDirector', vendor: 'cocos2d-x' },
      { symbol: 'il2cpp_init', vendor: 'UnityIL2CPP' },
      { symbol: 'AES_encrypt', vendor: 'OpenSSL' },
      { symbol: 'crc32', vendor: 'zlib' },
      { symbol: 'png_create_read_struct', vendor: 'libpng' },
      { symbol: 'CodedInputStream::ReadVarint32Fallback', vendor: 'protobuf' },
      { symbol: 'FIRApp::configure', vendor: 'Firebase' },
      { symbol: 'GADBannerView::loadRequest', vendor: 'GoogleMobileAds' },
      { symbol: 'ADJActivityHandler::initWithConfig', vendor: 'Adjust' },
    ];

    const functions = [];
    const bytesByVa = new Map();
    targets.forEach((t, idx) => {
      const entry = db.entries.find((e) => e.symbolName === t.symbol && e.archId === HEXSIG_ARCH_ARM64);
      assert.ok(entry, `missing ARM64 entry for ${t.symbol}`);
      const vaHex = `0x${(0x100004000 + idx * 0x100).toString(16)}`;
      // Generic-prologue entries (requireAnchor: true) require corroborating anchors alongside prologue bytes;
      // distinctive-body entries (like crc32) match on bytes alone without anchors.
      const anchorProps = entry.requireAnchor
        ? {
            ...(entry.strings.length > 0 ? { strings: entry.strings.slice(0, 1) } : {}),
            ...(entry.constants.length > 0 ? { constants: entry.constants.slice() } : {}),
          }
        : {};
      functions.push({ vaHex, name: `sub_${(0x100004000 + idx * 0x100).toString(16)}`, size: 64, ...anchorProps });
      bytesByVa.set(vaHex, materializeArm64FromEntry(entry));
    });

    const scanner = createHexSigAutoScanner({
      hexSigIndex: index,
      matchOpts: { preferWasm: false },
    });

    const out = await scanner.run({
      binaryMeta: { arch: 'arm64', format: 'macho', platform: 'ios' },
      functions,
      readFunctionBytes: async (vaHex) => bytesByVa.get(vaHex) ?? null,
    });

    assert.equal(out.status, AUTO_ANALYSIS_STATUS.DONE);
    assert.equal(out.named, targets.length);
    for (let i = 0; i < targets.length; i++) {
      const hit = out.results.find((r) => r.vaHex === functions[i].vaHex);
      assert.ok(hit, `expected match for ${targets[i].symbol}`);
      assert.equal(hit.newName, targets[i].symbol);
      assert.equal(hit.libName, targets[i].vendor);
      assert.equal(hit.verdict, HEXSIG_VERDICT.AUTO_NAME);
      assert.ok(hit.score >= 820);
    }
  });

  it('matches stripped iOS arm64e compiler-variant functions via string & constant anchors across all 9 libraries', async () => {
    const db = buildBuiltinHexSigDb();
    const index = new HexSigIndex(db.entries, db.libs);

    const anchorCases = [
      // cocos2d-x (with extra app noise strings)
      {
        vaHex: '0x100100000',
        strings: ['CDAudioManager', 'Denshion::CDAudioManager', 'bgm_stage_01.mp3'],
        expectedSymbol: 'CDAudioManager::sharedManager',
        expectedVendor: 'cocos2d-x',
      },
      {
        vaHex: '0x100100100',
        strings: ['cocos2d: ZipUtils: inflateInit2 failed', 'cocos2d: ZipUtils: error decoding gzip header'],
        constants: [0x8b1fn, 0x0800n],
        expectedSymbol: 'cocos2d::ZipUtils::ccInflateMemory',
        expectedVendor: 'cocos2d-x',
      },
      // Unity IL2CPP (multi-anchor)
      {
        vaHex: '0x100100200',
        strings: ['il2cpp_init', 'global-metadata.dat', 'Assembly-CSharp.dll'],
        expectedSymbol: 'il2cpp_init',
        expectedVendor: 'UnityIL2CPP',
      },
      {
        vaHex: '0x100100300',
        strings: ['il2cpp_domain_get', 'IL2CPP Root Domain'],
        expectedSymbol: 'il2cpp_domain_get',
        expectedVendor: 'UnityIL2CPP',
      },
      // OpenSSL (crypto constants only + string anchor)
      {
        vaHex: '0x100100400',
        constants: [0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an, 0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n],
        cryptoMask: 1 << 1,
        expectedSymbol: 'SHA256_Init',
        expectedVendor: 'OpenSSL',
      },
      {
        vaHex: '0x100100500',
        constants: [0x67452301n, 0xefcdab89n, 0x98badcfen, 0x10325476n],
        cryptoMask: 1 << 3,
        expectedSymbol: 'MD5_Init',
        expectedVendor: 'OpenSSL',
      },
      {
        vaHex: '0x100100600',
        strings: ['SSL_CTX_new', 'ssl/ssl_lib.c'],
        expectedSymbol: 'SSL_CTX_new',
        expectedVendor: 'OpenSSL',
      },
      // zlib (constant-only crc32 + string-anchored inflate)
      {
        vaHex: '0x100100700',
        constants: [0xedb88320n, 0x77073096n, 0xee0e612cn],
        expectedSymbol: 'crc32',
        expectedVendor: 'zlib',
      },
      {
        vaHex: '0x100100800',
        strings: ['invalid block type', 'invalid stored block lengths', 'too many length or distance symbols'],
        expectedSymbol: 'inflate',
        expectedVendor: 'zlib',
      },
      // libpng
      {
        vaHex: '0x100100900',
        strings: ['Not a PNG file', 'Missing IHDR before IDAT'],
        constants: [0x49484452n, 0x49444154n],
        expectedSymbol: 'png_read_info',
        expectedVendor: 'libpng',
      },
      // protobuf
      {
        vaHex: '0x100100a00',
        strings: ['MessageLite::ParseFromArray', "Can't parse message of type"],
        expectedSymbol: 'MessageLite::ParseFromArray',
        expectedVendor: 'protobuf',
      },
      // Firebase
      {
        vaHex: '0x100100b00',
        strings: ['FIRAnalytics', '[Firebase/Analytics]', 'app_measurement'],
        expectedSymbol: 'FIRAnalytics::logEventWithName',
        expectedVendor: 'Firebase',
      },
      // Google Mobile Ads
      {
        vaHex: '0x100100c00',
        strings: ['GADInterstitial', 'GADInterstitialAd'],
        expectedSymbol: 'GADInterstitial::presentFromRootViewController',
        expectedVendor: 'GoogleMobileAds',
      },
      // Adjust (provided via async getFunctionAnchors hook)
      {
        vaHex: '0x100100d00',
        viaHook: true,
        strings: ['ADJPackageBuilder', 'app_token', 'idfv'],
        expectedSymbol: 'ADJPackageBuilder::buildSessionPackage',
        expectedVendor: 'Adjust',
      },
    ];

    const functions = anchorCases.map((c) => ({
      vaHex: c.vaHex,
      name: `sub_${c.vaHex.slice(2)}`,
      size: 64,
      ...(c.viaHook ? {} : {
        strings: c.strings,
        constants: c.constants,
        cryptoMask: c.cryptoMask,
      }),
    }));

    const scanner = createHexSigAutoScanner({
      hexSigIndex: index,
      matchOpts: { preferWasm: false },
      getFunctionAnchors: async (vaHex) => {
        const tc = anchorCases.find((c) => c.vaHex === vaHex && c.viaHook);
        return tc ? { strings: tc.strings, constants: tc.constants } : null;
      },
    });

    const out = await scanner.run({
      binaryMeta: { arch: 'arm64e', format: 'macho', platform: 'ios' },
      functions,
      readFunctionBytes: async () => ALT_IOS_ARM64_PROLOGUE,
    });

    assert.equal(out.status, AUTO_ANALYSIS_STATUS.DONE);
    assert.equal(out.named, anchorCases.length);
    for (const tc of anchorCases) {
      const hit = out.results.find((r) => r.vaHex === tc.vaHex);
      assert.ok(hit, `expected anchor match for ${tc.expectedSymbol} at ${tc.vaHex}`);
      assert.equal(hit.newName, tc.expectedSymbol);
      assert.equal(hit.libName, tc.expectedVendor);
      assert.equal(hit.verdict, HEXSIG_VERDICT.AUTO_NAME);
      assert.ok(hit.score >= 820, `score too low for ${tc.expectedSymbol}: ${hit.score}`);
      assert.ok(hit.margin >= 80, `margin too low for ${tc.expectedSymbol}: ${hit.margin}`);
    }
  });

  it('false-positive guard: does NOT misname unrelated app functions, non-code buffers, or ambiguous anchors', async () => {
    const db = buildBuiltinHexSigDb();
    const index = new HexSigIndex(db.entries, db.libs);

    // Non-code buffers that must fail isPlausibleArm64Code
    const zeroBuf = new Uint8Array(64);
    const ffBuf = new Uint8Array(64).fill(0xff);
    const asciiTextBuf = new TextEncoder().encode('FIRApp [Firebase/Core] GoogleService-Info.plist padding text 12345');
    assert.equal(isPlausibleArm64Code(zeroBuf), false);
    assert.equal(isPlausibleArm64Code(ffBuf), false);
    assert.equal(isPlausibleArm64Code(asciiTextBuf), false);
    assert.equal(isPlausibleArm64Code(ALT_IOS_ARM64_PROLOGUE), true);

    const bytesByVa = new Map([
      // 1. Unrelated app function with valid ARM64 code and no anchors
      ['0x100200000', ALT_IOS_ARM64_PROLOGUE],
      // 2. Unrelated app function with valid ARM64 code and unrelated app strings/constants
      ['0x100200100', ALT_IOS_ARM64_PROLOGUE],
      // 3. Zero-filled data buffer paired with real Firebase anchor strings -> MUST REJECT (not ARM64 code)
      ['0x100200200', zeroBuf],
      // 4. ASCII string table buffer paired with real Firebase anchor strings -> MUST REJECT (not ARM64 code)
      ['0x100200300', asciiTextBuf],
      // 5. Ambiguous shared anchor string ('1.2.11' shared by inflateInit2_ and deflateInit2_) -> MUST REJECT (low margin)
      ['0x100200400', ALT_IOS_ARM64_PROLOGUE],
      // 6. Trivial small constants only -> MUST REJECT
      ['0x100200500', ALT_IOS_ARM64_PROLOGUE],
      // 7. Existing named function -> MUST SKIP
      ['0x100200600', ALT_IOS_ARM64_PROLOGUE],
    ]);

    const scanner = createHexSigAutoScanner({
      hexSigIndex: index,
      matchOpts: { preferWasm: false },
    });

    const out = await scanner.run({
      binaryMeta: { arch: 'arm64', format: 'macho', platform: 'ios' },
      functions: [
        { vaHex: '0x100200000', name: 'sub_100200000', size: 64 },
        {
          vaHex: '0x100200100',
          name: 'sub_100200100',
          size: 64,
          strings: ['TsumTsumScoreManager', 'combo_fever_bonus', 'stage_clear_dialog'],
          constants: [0x12345678n, 0xdeadbeefn, 99999n],
        },
        {
          vaHex: '0x100200200',
          name: 'sub_100200200',
          size: 64,
          strings: ['FIRApp', '[Firebase/Core]', 'GoogleService-Info.plist'],
        },
        {
          vaHex: '0x100200300',
          name: 'sub_100200300',
          size: 64,
          strings: ['FIRApp', '[Firebase/Core]', 'GoogleService-Info.plist'],
        },
        {
          vaHex: '0x100200400',
          name: 'sub_100200400',
          size: 64,
          strings: ['1.2.11'],
        },
        {
          vaHex: '0x100200500',
          name: 'sub_100200500',
          size: 64,
          constants: [0n, 1n, 2n, 4n, 8n, 16n],
        },
        {
          vaHex: '0x100200600',
          name: 'TsumGameController_updateScore',
          size: 64,
          strings: ['FIRApp', '[Firebase/Core]', 'GoogleService-Info.plist'],
        },
      ],
      readFunctionBytes: async (vaHex) => bytesByVa.get(vaHex) ?? null,
    });

    assert.equal(out.status, AUTO_ANALYSIS_STATUS.DONE);
    assert.equal(out.skippedNamed, 1);
    assert.equal(out.scanned, 6);
    assert.equal(out.named, 0, `expected 0 false positives, got: ${JSON.stringify(out.results)}`);
    assert.deepEqual(out.results, []);
  });

  it('buildHexSigMatchQuery computes l3StrHash64 and l3ConstHash64 from anchorContext while preserving backward compatibility', () => {
    const qLegacy = buildHexSigMatchQuery(ALT_IOS_ARM64_PROLOGUE, HEXSIG_ARCH_ARM64);
    assert.equal(qLegacy.archId, HEXSIG_ARCH_ARM64);
    assert.equal(qLegacy.fingerprint, undefined);

    const qAnchors = buildHexSigMatchQuery(ALT_IOS_ARM64_PROLOGUE, 'arm64e', null, {
      strings: ['GADRequest', 'googleads.g.doubleclick.net'],
      constants: [0x89504e47n, 0x0d0a1a0an],
      cryptoMask: 1 << 0,
      libHintMask: HEXSIG_LIB_HINT_BIT.GOOGLE_MOBILE_ADS,
    });
    assert.equal(qAnchors.archId, HEXSIG_ARCH_ARM64);
    assert.equal(qAnchors.fingerprint.l3StrHash64, computeStringHash64(['GADRequest', 'googleads.g.doubleclick.net']));
    assert.equal(qAnchors.fingerprint.l3ConstHash64, computeConstHash64([0x89504e47n, 0x0d0a1a0an]));
    assert.equal(qAnchors.fingerprint.l3CryptoMask, 1);
    assert.equal(qAnchors.fingerprint.l3LibHintMask, HEXSIG_LIB_HINT_BIT.GOOGLE_MOBILE_ADS);
  });

  it('regression: standard non-PAC clang ARM64 prologues without anchors and single-string wrapper produce ZERO AUTO_NAME false positives', async () => {
    const db = buildBuiltinHexSigDb();
    const index = new HexSigIndex(db.entries, db.libs);

    const padArm64 = (hexPrefix) => {
      const prefix = hexToBytes(hexPrefix);
      const buf = new Uint8Array(Math.max(48, prefix.length + 16));
      buf.set(prefix, 0);
      for (let off = prefix.length; off + 4 <= buf.length - 4; off += 4) {
        buf[off] = 0x1f; buf[off + 1] = 0x20; buf[off + 2] = 0x03; buf[off + 3] = 0xd5; // nop
      }
      buf[buf.length - 4] = 0xc0; buf[buf.length - 3] = 0x03; buf[buf.length - 2] = 0x5f; buf[buf.length - 1] = 0xd6; // ret
      return buf;
    };

    // 1. Generic 1-arg ObjC method: stp x29,x30,[sp,#-0x30]!; stp x22,x21,[sp,#0x10]; stp x20,x19,[sp,#0x20]; mov x29,sp; mov x19,x0; mov x20,x2
    const genericObjc1Arg = padArm64('fd 7b bd a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f3 03 00 aa f4 03 02 aa');
    // 2. Generic 3-arg callee-saved prologue (matches EVP_DigestInit_ex / UnitySendMessage frame)
    const generic3ArgCalleeSaved = padArm64('fd 7b bd a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f3 03 00 aa f4 03 01 aa f5 03 02 aa');
    // 3. Heavy x19..x28 save prologue (matches AES_encrypt / deflateInit2_ frame)
    const heavyCalleeSave = padArm64('fd 7b ba a9 fc 6f 01 a9 fa 67 02 a9 f8 5f 03 a9 f6 57 04 a9 f4 4f 05 a9 fd 03 00 91');
    // 4. 0x40-frame prologue (matches il2cpp_runtime_invoke frame)
    const frame0x40Prologue = padArm64('fd 7b bc a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91');

    const bytesByVa = new Map([
      ['0x100300000', genericObjc1Arg],
      ['0x100300100', generic3ArgCalleeSaved],
      ['0x100300200', heavyCalleeSave],
      ['0x100300300', frame0x40Prologue],
      ['0x100300400', ALT_IOS_ARM64_PROLOGUE],
    ]);

    const scanner = createHexSigAutoScanner({
      hexSigIndex: index,
      matchOpts: { preferWasm: false },
    });

    const out = await scanner.run({
      binaryMeta: { arch: 'arm64', format: 'macho', platform: 'ios' },
      functions: [
        { vaHex: '0x100300000', name: 'sub_100300000', size: 64 },
        { vaHex: '0x100300100', name: 'sub_100300100', size: 64 },
        { vaHex: '0x100300200', name: 'sub_100300200', size: 64 },
        { vaHex: '0x100300300', name: 'sub_100300300', size: 64 },
        // Single-string wrapper referencing only ['inflateInit_'] (no constants, non-matching prologue)
        { vaHex: '0x100300400', name: 'sub_100300400', size: 64, strings: ['inflateInit_'] },
      ],
      readFunctionBytes: async (vaHex) => bytesByVa.get(vaHex) ?? null,
    });

    assert.equal(out.status, AUTO_ANALYSIS_STATUS.DONE);
    assert.equal(out.scanned, 5);
    assert.equal(out.named, 0, `expected 0 false-positive AUTO_NAME matches, got: ${JSON.stringify(out.results)}`);
    assert.deepEqual(out.results, []);
  });
});
