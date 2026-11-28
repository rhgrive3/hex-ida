// Built-in clean OSS library signature database for HEX-SIG (§11.1 / §11.2).
// Includes iOS arm64 Game Library Signature Pack (Review Item 5.2).
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.

import {
  HEXSIG_ARCH_ARM64,
  HEXSIG_ARCH_X86_64,
  HEXSIG_ENTRY_FLAGS,
  HEXSIG_PATTERN_LEN,
  fnv1a64,
  crc16Ccitt,
  computeSimHash64,
  computeMinHash4,
  computeConstHash64,
  computeStringHash64,
} from './hex-sig-extractor.js';

export const HEXSIG_LIB_KIND = Object.freeze({
  LIBRARY: 0,
  CRYPTO: 1,
  ENGINE: 2,
  RUNTIME: 3,
  ADS: 4,
  ANALYTICS: 5,
  SYSTEM: 6,
});

export const HEXSIG_LIB_HINT_BIT = Object.freeze({
  LIBC: 1 << 0,
  CRT: 1 << 1,
  ZLIB: 1 << 2,
  LIBPNG: 1 << 3,
  OPENSSL: 1 << 4,
  CXX_RUNTIME: 1 << 5,
  UNITY: 1 << 6,
  DARWIN: 1 << 7,
  COCOS2DX: 1 << 8,
  UNITY_IL2CPP: 1 << 9,
  PROTOBUF: 1 << 10,
  FIREBASE: 1 << 11,
  GOOGLE_MOBILE_ADS: 1 << 12,
  ADJUST: 1 << 13,
});

export const BUILTIN_HEXSIG_LIBS = Object.freeze([
  { id: 0, vendorName: 'libc', kindId: HEXSIG_LIB_KIND.SYSTEM, hintMask: HEXSIG_LIB_HINT_BIT.LIBC },
  { id: 1, vendorName: 'crt', kindId: HEXSIG_LIB_KIND.RUNTIME, hintMask: HEXSIG_LIB_HINT_BIT.CRT },
  { id: 2, vendorName: 'zlib', kindId: HEXSIG_LIB_KIND.LIBRARY, hintMask: HEXSIG_LIB_HINT_BIT.ZLIB },
  { id: 3, vendorName: 'libpng', kindId: HEXSIG_LIB_KIND.LIBRARY, hintMask: HEXSIG_LIB_HINT_BIT.LIBPNG },
  { id: 4, vendorName: 'OpenSSL', kindId: HEXSIG_LIB_KIND.CRYPTO, hintMask: HEXSIG_LIB_HINT_BIT.OPENSSL },
  { id: 5, vendorName: 'libc++abi', kindId: HEXSIG_LIB_KIND.RUNTIME, hintMask: HEXSIG_LIB_HINT_BIT.CXX_RUNTIME },
  { id: 6, vendorName: 'UnityEngine', kindId: HEXSIG_LIB_KIND.ENGINE, hintMask: HEXSIG_LIB_HINT_BIT.UNITY },
  { id: 7, vendorName: 'Darwin', kindId: HEXSIG_LIB_KIND.SYSTEM, hintMask: HEXSIG_LIB_HINT_BIT.DARWIN },
  { id: 8, vendorName: 'cocos2d-x', kindId: HEXSIG_LIB_KIND.ENGINE, hintMask: HEXSIG_LIB_HINT_BIT.COCOS2DX },
  { id: 9, vendorName: 'UnityIL2CPP', kindId: HEXSIG_LIB_KIND.ENGINE, hintMask: HEXSIG_LIB_HINT_BIT.UNITY_IL2CPP },
  { id: 10, vendorName: 'protobuf', kindId: HEXSIG_LIB_KIND.LIBRARY, hintMask: HEXSIG_LIB_HINT_BIT.PROTOBUF },
  { id: 11, vendorName: 'Firebase', kindId: HEXSIG_LIB_KIND.ANALYTICS, hintMask: HEXSIG_LIB_HINT_BIT.FIREBASE },
  { id: 12, vendorName: 'GoogleMobileAds', kindId: HEXSIG_LIB_KIND.ADS, hintMask: HEXSIG_LIB_HINT_BIT.GOOGLE_MOBILE_ADS },
  { id: 13, vendorName: 'Adjust', kindId: HEXSIG_LIB_KIND.ANALYTICS, hintMask: HEXSIG_LIB_HINT_BIT.ADJUST },
]);

function hexToPatternAndMask(hexStr) {
  const parts = hexStr.trim().split(/\s+/);
  const pattern = new Uint8Array(HEXSIG_PATTERN_LEN);
  const mask = new Uint8Array(HEXSIG_PATTERN_LEN);
  const len = Math.min(HEXSIG_PATTERN_LEN, parts.length);
  let hasWildcard = false;
  for (let i = 0; i < len; i++) {
    const tok = parts[i];
    if (tok === '??' || tok === '**') {
      pattern[i] = 0x00;
      mask[i] = 0x00;
      hasWildcard = true;
    } else {
      pattern[i] = parseInt(tok, 16) & 0xff;
      mask[i] = 0xff;
    }
  }
  return { pattern, mask, length: len, hasWildcard };
}

function makeEntry(spec) {
  const { pattern, mask, length, hasWildcard } = hexToPatternAndMask(spec.hexPattern);
  const maskedSlice = pattern.subarray(0, length);
  const patternHash64 = fnv1a64(maskedSlice);
  const tailStart = length > 16 ? 16 : 0;
  const crc16 = crc16Ccitt(maskedSlice, tailStart, length);
  const tokens = spec.tokens || Array.from(maskedSlice, (b, i) => ((b << 8) | mask[i]) & 0xffff);
  const l1Simhash64 = spec.l1Simhash64 !== undefined ? BigInt(spec.l1Simhash64) : computeSimHash64(tokens);
  const l1Minhash = spec.l1Minhash ? new Uint32Array(spec.l1Minhash) : computeMinHash4(tokens);
  const strings = Array.isArray(spec.strings) ? Object.freeze(spec.strings.filter((s) => typeof s === 'string' && s.length > 0)) : Object.freeze([]);
  const constants = Array.isArray(spec.constants) ? Object.freeze(spec.constants.map((c) => BigInt(c))) : Object.freeze([]);
  const l3ConstHash64 = constants.length > 0 ? computeConstHash64(constants) : 0n;
  const l3StrHash64 = strings.length > 0 ? computeStringHash64(strings) : 0n;
  const lib = BUILTIN_HEXSIG_LIBS[spec.libId];

  let flags = spec.flags ?? HEXSIG_ENTRY_FLAGS.VENDOR_LIB;
  if (hasWildcard) flags |= HEXSIG_ENTRY_FLAGS.HAS_WILDCARDS;
  if (lib.kindId === HEXSIG_LIB_KIND.CRYPTO) flags |= HEXSIG_ENTRY_FLAGS.CRYPTO_LIB;

  return {
    symbolName: spec.symbolName,
    libId: spec.libId,
    arch: spec.archId,
    archId: spec.archId,
    pattern,
    mask,
    prologueLen: length,
    length,
    minFuncLen: length,
    baseConfidence: spec.baseConfidence ?? 880,
    prologueHash64: patternHash64,
    patternHash64,
    crc16,
    tailCrc16: 0,
    tailOffset: 0,
    tailLen: 0,
    flags,
    requireAnchor: Boolean(spec.requireAnchor),
    strings,
    constants,
    fingerprint: {
      l1Simhash64,
      l2WlHash64: BigInt(spec.l2WlHash64 ?? 0n),
      l3ConstHash64,
      l3StrHash64,
      l1Minhash,
      l1OpProfile32: (spec.l1OpProfile32 ?? 0x40206040) >>> 0,
      l2BbCount: spec.l2BbCount ?? 1,
      l2EdgeCount: spec.l2EdgeCount ?? 0,
      l2MaxLoopDepth: spec.l2MaxLoopDepth ?? 0,
      l2LoopCount: spec.l2LoopCount ?? 0,
      l2CallOutDeg: spec.l2CallOutDeg ?? 0,
      l3CryptoMask: spec.l3CryptoMask ?? 0,
      l3LibHintMask: spec.l3LibHintMask ?? lib.hintMask,
    },
  };
}

const RAW_BUILTIN_SPECS = [
  // =========================================================================
  // Core OSS Built-ins (IDs 0..11 preserved for backward compatibility)
  // =========================================================================
  {
    symbolName: 'memcpy',
    libId: 0,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'e3 03 00 aa 02 ?? ?? b4 24 04 40 38 64 04 00 38 42 04 00 f1 01 ?? ?? 54 c0 03 5f d6',
    l2BbCount: 3,
    l2EdgeCount: 3,
    l2LoopCount: 1,
    l2MaxLoopDepth: 1,
  },
  {
    symbolName: 'strlen',
    libId: 0,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'e1 03 00 aa 22 14 40 38 02 ?? ?? 35 20 00 00 cb 00 04 00 d1 c0 03 5f d6',
    l2BbCount: 2,
    l2EdgeCount: 2,
    l2LoopCount: 1,
    l2MaxLoopDepth: 1,
  },
  {
    symbolName: 'memset',
    libId: 0,
    archId: HEXSIG_ARCH_X86_64,
    hexPattern: '48 89 f8 48 89 d1 40 0f b6 c6 f3 aa c3',
    l2BbCount: 1,
    l2EdgeCount: 0,
  },
  {
    symbolName: '_start',
    libId: 1,
    archId: HEXSIG_ARCH_X86_64,
    hexPattern: '31 ed 49 89 d1 5e 48 89 e2 48 83 e4 f0 50 54',
    l2BbCount: 1,
    l2EdgeCount: 0,
  },
  {
    symbolName: 'adler32',
    libId: 2,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'e3 fe 1f 52 24 00 00 12 05 3c 40 53 06 ?? ?? b4',
    constants: [65521n, 5552n],
    l2BbCount: 6,
    l2EdgeCount: 8,
    l2LoopCount: 2,
    l2MaxLoopDepth: 2,
  },
  {
    symbolName: 'inflateInit2_',
    requireAnchor: true,
    libId: 2,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 fd 03 00 91 f3 03 00 aa f4 03 01 2a',
    strings: ['1.2.11', 'inflate 1.2.11 Copyright 1995-2017 Mark Adler'],
    l2BbCount: 8,
    l2EdgeCount: 11,
  },
  {
    symbolName: 'png_sig_cmp',
    requireAnchor: true,
    libId: 3,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 fd 03 00 91 5f 20 00 f1 08 ?? ?? 54',
    constants: [0x89504e47n, 0x0d0a1a0an],
    l2BbCount: 5,
    l2EdgeCount: 6,
  },
  {
    symbolName: 'AES_set_encrypt_key',
    requireAnchor: true,
    libId: 4,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bb a9 fd 03 00 91 00 ?? ?? b4 02 ?? ?? b4',
    constants: [0x01000000n, 0x1b000000n, 0x637c777bn],
    l3CryptoMask: 1 << 0,
    l2BbCount: 10,
    l2EdgeCount: 14,
    l2LoopCount: 1,
    l2MaxLoopDepth: 1,
  },
  {
    symbolName: 'SHA256_Update',
    requireAnchor: true,
    libId: 4,
    archId: HEXSIG_ARCH_X86_64,
    hexPattern: '41 57 41 56 41 55 41 54 55 53 48 83 ec 28 48 85 d2',
    constants: [0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an],
    l3CryptoMask: 1 << 1,
    l2BbCount: 7,
    l2EdgeCount: 9,
  },
  {
    symbolName: '__cxa_throw',
    requireAnchor: true,
    libId: 5,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 f4 4f 01 a9 fd 03 00 91 f3 03 00 aa',
    strings: ['__cxa_throw'],
    l2BbCount: 3,
    l2EdgeCount: 2,
  },
  {
    symbolName: 'il2cpp_runtime_invoke',
    requireAnchor: true,
    libId: 9,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bc a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91',
    strings: ['il2cpp_runtime_invoke'],
    l3LibHintMask: HEXSIG_LIB_HINT_BIT.UNITY | HEXSIG_LIB_HINT_BIT.UNITY_IL2CPP,
    l2BbCount: 5,
    l2EdgeCount: 6,
  },
  {
    symbolName: 'objc_retainAutoreleasedReturnValue',
    requireAnchor: true,
    libId: 7,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bf a9 fd 03 00 91 e1 03 1e aa 1f 00 00 f1',
    strings: ['objc_retainAutoreleasedReturnValue'],
    l2BbCount: 4,
    l2EdgeCount: 5,
  },

  // =========================================================================
  // UnityEngine (libId: 6) — iOS arm64
  // =========================================================================
  {
    symbolName: 'UnitySendMessage',
    requireAnchor: true,
    libId: 6,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f5 03 02 aa f4 03 01 aa f3 03 00 aa',
    strings: ['UnitySendMessage', 'UnityFramework'],
    l2BbCount: 4,
    l2EdgeCount: 5,
  },

  // =========================================================================
  // cocos2d-x (libId: 8) — iOS arm64 Game Engine Signatures
  // =========================================================================
  {
    symbolName: 'CDAudioManager::sharedManager',
    requireAnchor: true,
    libId: 8,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 f4 4f 01 a9 fd 03 00 91 08 ?? ?? 90 08 01 40 f9 08 ?? ?? b5',
    strings: ['CDAudioManager', 'Denshion::CDAudioManager'],
    l2BbCount: 5,
    l2EdgeCount: 6,
  },
  {
    symbolName: 'CCDirector::sharedDirector',
    requireAnchor: true,
    libId: 8,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 f4 4f 01 a9 fd 03 00 91 08 ?? ?? 90 08 01 40 f9 08 ?? ?? b4',
    strings: ['CCDirector', 'cocos2d: CCDirector: Error in gettimeofday'],
    l2BbCount: 4,
    l2EdgeCount: 5,
  },
  {
    symbolName: 'CCNode::addChild',
    requireAnchor: true,
    libId: 8,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bc a9 f8 5f 01 a9 f6 57 02 a9 f4 4f 03 a9 fd 03 00 91 f5 03 02 2a f4 03 01 aa',
    strings: ['CCNode::addChild', "child already added. It can't be added again"],
    l2BbCount: 9,
    l2EdgeCount: 12,
  },
  {
    symbolName: 'CCSprite::initWithTexture',
    requireAnchor: true,
    libId: 8,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bb a9 f8 5f 01 a9 f6 57 02 a9 f4 4f 03 a9 fd 03 00 91 f3 03 00 aa f4 03 01 aa',
    strings: ['CCSprite::initWithTexture', 'cocos2d: CCSprite: Invalid texture'],
    l2BbCount: 10,
    l2EdgeCount: 14,
  },
  {
    symbolName: 'CCFileUtils::fullPathForFilename',
    requireAnchor: true,
    libId: 8,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'ff 03 02 d1 f8 5f 05 a9 f6 57 06 a9 f4 4f 07 a9 fd 7b 08 a9 fd 03 02 91',
    strings: ['CCFileUtils', 'cocos2d: fullPathForFilename: No file found at %s'],
    l2BbCount: 14,
    l2EdgeCount: 20,
  },
  {
    symbolName: 'CCUserDefault::sharedUserDefault',
    requireAnchor: true,
    libId: 8,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 fd 03 00 91 08 ?? ?? 90 08 01 40 f9 08 ?? ?? b5 e0 03 08 aa',
    strings: ['CCUserDefault', 'UserDefault.xml'],
    l2BbCount: 5,
    l2EdgeCount: 6,
  },
  {
    symbolName: 'CCScheduler::scheduleSelector',
    requireAnchor: true,
    libId: 8,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b ba a9 fa 67 01 a9 f8 5f 02 a9 f6 57 03 a9 f4 4f 04 a9 fd 03 00 91',
    strings: ['CCScheduler', 'CCScheduler#scheduleSelector. Selector already scheduled'],
    l2BbCount: 12,
    l2EdgeCount: 16,
  },
  {
    symbolName: 'CCTextureCache::addImage',
    requireAnchor: true,
    libId: 8,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'ff 43 01 d1 f8 5f 02 a9 f6 57 03 a9 f4 4f 04 a9 fd 7b 05 a9 fd 43 01 91',
    strings: ['CCTextureCache', "cocos2d: Couldn't create texture for file:%s in CCTextureCache"],
    l2BbCount: 15,
    l2EdgeCount: 22,
  },
  {
    symbolName: 'CCActionManager::addAction',
    requireAnchor: true,
    libId: 8,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bc a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f5 03 02 2a f3 03 00 aa 01 ?? ?? b4',
    strings: ['CCActionManager', 'CCActionManager::addAction'],
    l2BbCount: 8,
    l2EdgeCount: 11,
  },
  {
    symbolName: 'cocos2d::ZipUtils::ccInflateMemory',
    requireAnchor: true,
    libId: 8,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'ff 83 01 d1 f8 5f 03 a9 f6 57 04 a9 f4 4f 05 a9 fd 7b 06 a9 fd 83 01 91',
    strings: ['cocos2d: ZipUtils: inflateInit2 failed', 'cocos2d: ZipUtils: error decoding gzip header'],
    constants: [0x8b1fn, 0x0800n],
    l2BbCount: 11,
    l2EdgeCount: 15,
    l2LoopCount: 1,
    l2MaxLoopDepth: 1,
  },

  // =========================================================================
  // Unity IL2CPP Runtime (libId: 9) — iOS arm64
  // =========================================================================
  {
    symbolName: 'il2cpp_init',
    requireAnchor: true,
    libId: 9,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 f4 4f 01 a9 fd 03 00 91 f3 03 00 aa 08 ?? ?? 90',
    strings: ['il2cpp_init', 'global-metadata.dat'],
    l3LibHintMask: HEXSIG_LIB_HINT_BIT.UNITY | HEXSIG_LIB_HINT_BIT.UNITY_IL2CPP,
    l2BbCount: 6,
    l2EdgeCount: 8,
  },
  {
    symbolName: 'il2cpp_domain_get',
    requireAnchor: true,
    libId: 9,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bf a9 fd 03 00 91 08 ?? ?? 90 00 01 40 f9 00 ?? ?? b4',
    strings: ['il2cpp_domain_get', 'IL2CPP Root Domain'],
    l3LibHintMask: HEXSIG_LIB_HINT_BIT.UNITY | HEXSIG_LIB_HINT_BIT.UNITY_IL2CPP,
    l2BbCount: 3,
    l2EdgeCount: 4,
  },
  {
    symbolName: 'il2cpp_class_from_name',
    requireAnchor: true,
    libId: 9,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f5 03 02 aa f4 03 01 aa 00 ?? ?? b4',
    strings: ['il2cpp_class_from_name'],
    l3LibHintMask: HEXSIG_LIB_HINT_BIT.UNITY | HEXSIG_LIB_HINT_BIT.UNITY_IL2CPP,
    l2BbCount: 7,
    l2EdgeCount: 10,
  },
  {
    symbolName: 'il2cpp_string_new',
    requireAnchor: true,
    libId: 9,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 f4 4f 01 a9 fd 03 00 91 f3 03 00 aa 13 ?? ?? b4',
    strings: ['il2cpp_string_new'],
    l3LibHintMask: HEXSIG_LIB_HINT_BIT.UNITY | HEXSIG_LIB_HINT_BIT.UNITY_IL2CPP,
    l2BbCount: 4,
    l2EdgeCount: 5,
  },
  {
    symbolName: 'il2cpp_object_new',
    requireAnchor: true,
    libId: 9,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 f4 4f 01 a9 fd 03 00 91 f3 03 00 aa 08 04 40 f9',
    strings: ['il2cpp_object_new'],
    l3LibHintMask: HEXSIG_LIB_HINT_BIT.UNITY | HEXSIG_LIB_HINT_BIT.UNITY_IL2CPP,
    l2BbCount: 5,
    l2EdgeCount: 6,
  },
  {
    symbolName: 'il2cpp_gc_collect',
    requireAnchor: true,
    libId: 9,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bf a9 fd 03 00 91 1f 00 00 71 0b ?? ?? 54',
    strings: ['il2cpp_gc_collect'],
    l3LibHintMask: HEXSIG_LIB_HINT_BIT.UNITY | HEXSIG_LIB_HINT_BIT.UNITY_IL2CPP,
    l2BbCount: 3,
    l2EdgeCount: 3,
  },
  {
    symbolName: 'il2cpp_thread_attach',
    requireAnchor: true,
    libId: 9,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 f4 4f 01 a9 fd 03 00 91 f3 03 00 aa 08 08 40 f9',
    strings: ['il2cpp_thread_attach'],
    l3LibHintMask: HEXSIG_LIB_HINT_BIT.UNITY | HEXSIG_LIB_HINT_BIT.UNITY_IL2CPP,
    l2BbCount: 5,
    l2EdgeCount: 6,
  },

  // =========================================================================
  // OpenSSL (libId: 4) — Expanded iOS arm64 Crypto & TLS Signatures
  // =========================================================================
  {
    symbolName: 'AES_encrypt',
    requireAnchor: true,
    libId: 4,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b ba a9 fc 6f 01 a9 fa 67 02 a9 f8 5f 03 a9 f6 57 04 a9 f4 4f 05 a9 fd 03 00 91',
    constants: [0x637c777bn, 0xc66363a5n, 0xa56363c6n],
    l3CryptoMask: 1 << 0,
    l2BbCount: 4,
    l2EdgeCount: 5,
    l2LoopCount: 1,
    l2MaxLoopDepth: 1,
  },
  {
    symbolName: 'AES_decrypt',
    requireAnchor: true,
    libId: 4,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'ff 83 01 d1 fc 6f 01 a9 fa 67 02 a9 f8 5f 03 a9 f6 57 04 a9 f4 4f 05 a9 fd 7b 06 a9',
    constants: [0x52096ad5n, 0x51f4a750n, 0x7e416553n],
    l3CryptoMask: 1 << 0,
    l2BbCount: 4,
    l2EdgeCount: 5,
    l2LoopCount: 1,
    l2MaxLoopDepth: 1,
  },
  {
    symbolName: 'SHA256_Init',
    libId: 4,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'e8 cc 9c 52 28 41 ad 72 a9 d0 95 52 e9 6c b7 72 4a e6 87 52 ca 8d a7 72',
    constants: [0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an, 0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n],
    l3CryptoMask: 1 << 1,
    l2BbCount: 1,
    l2EdgeCount: 0,
  },
  {
    symbolName: 'SHA256_Update',
    requireAnchor: true,
    libId: 4,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bc a9 f8 5f 01 a9 f6 57 02 a9 f4 4f 03 a9 fd 03 00 91 02 ?? ?? b4 f3 03 00 aa',
    constants: [0x428a2f98n, 0x71374491n, 0xb5c0fbcfn, 0xe9b5dba5n],
    l3CryptoMask: 1 << 1,
    l2BbCount: 7,
    l2EdgeCount: 9,
  },
  {
    symbolName: 'SHA512_Init',
    libId: 4,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: '08 21 99 d2 88 79 bf f2 c8 cc dc f2 28 41 ed f2 08 00 00 f9',
    constants: [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n],
    l3CryptoMask: 1 << 2,
    l2BbCount: 1,
    l2EdgeCount: 0,
  },
  {
    symbolName: 'MD5_Init',
    libId: 4,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: '28 60 84 52 a8 88 ac 72 29 71 95 52 a9 f9 bd 72 c9 00 00 b9 08 00 00 b9',
    constants: [0x67452301n, 0xefcdab89n, 0x98badcfen, 0x10325476n],
    l3CryptoMask: 1 << 3,
    l2BbCount: 1,
    l2EdgeCount: 0,
  },
  {
    symbolName: 'EVP_DigestInit_ex',
    requireAnchor: true,
    libId: 4,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f3 03 00 aa f4 03 01 aa f5 03 02 aa',
    strings: ['EVP_DigestInit_ex', 'crypto/evp/digest.c'],
    l3CryptoMask: 1 << 4,
    l2BbCount: 11,
    l2EdgeCount: 16,
  },
  {
    symbolName: 'SSL_CTX_new',
    requireAnchor: true,
    libId: 4,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bc a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f4 03 00 aa 14 ?? ?? b4',
    strings: ['SSL_CTX_new', 'ssl/ssl_lib.c'],
    l3CryptoMask: 1 << 5,
    l2BbCount: 14,
    l2EdgeCount: 20,
  },
  {
    symbolName: 'BIO_new',
    requireAnchor: true,
    libId: 4,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 f4 4f 01 a9 fd 03 00 91 f4 03 00 aa 14 ?? ?? b4',
    strings: ['BIO_new', 'crypto/bio/bio_lib.c'],
    l3CryptoMask: 1 << 5,
    l2BbCount: 6,
    l2EdgeCount: 8,
  },

  // =========================================================================
  // zlib (libId: 2) — Expanded iOS arm64 Compression Signatures
  // =========================================================================
  {
    symbolName: 'deflateInit2_',
    requireAnchor: true,
    libId: 2,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b ba a9 fc 6f 01 a9 fa 67 02 a9 f8 5f 03 a9 f6 57 04 a9 fd 03 00 91',
    strings: ['1.2.11', 'deflate 1.2.11 Copyright 1995-2017 Jean-loup Gailly and Mark Adler'],
    constants: [32768n, 258n],
    l2BbCount: 12,
    l2EdgeCount: 18,
  },
  {
    symbolName: 'deflate',
    requireAnchor: true,
    libId: 2,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bb a9 f8 5f 01 a9 f6 57 02 a9 f4 4f 03 a9 fd 03 00 91 00 ?? ?? b4 08 18 40 f9',
    strings: ['need dictionary', 'stream end', 'insufficient memory'],
    constants: [258n, 262n],
    l2BbCount: 24,
    l2EdgeCount: 38,
    l2LoopCount: 2,
    l2MaxLoopDepth: 1,
  },
  {
    symbolName: 'inflate',
    requireAnchor: true,
    libId: 2,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'ff c3 01 d1 fc 6f 02 a9 fa 67 03 a9 f8 5f 04 a9 f6 57 05 a9 f4 4f 06 a9 fd 7b 07 a9',
    strings: ['invalid block type', 'invalid stored block lengths', 'too many length or distance symbols'],
    constants: [0x8b1fn, 32768n],
    l2BbCount: 32,
    l2EdgeCount: 54,
    l2LoopCount: 3,
    l2MaxLoopDepth: 2,
  },
  {
    symbolName: 'crc32',
    libId: 2,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'e8 03 00 2a e9 03 01 aa ea 03 02 2a 09 ?? ?? b4 0a ?? ?? 34 e8 03 28 2a',
    constants: [0xedb88320n, 0x77073096n, 0xee0e612cn],
    l2BbCount: 6,
    l2EdgeCount: 8,
    l2LoopCount: 1,
    l2MaxLoopDepth: 1,
  },
  {
    symbolName: 'uncompress',
    requireAnchor: true,
    libId: 2,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'ff 03 02 d1 f6 57 06 a9 f4 4f 07 a9 fd 7b 08 a9 fd 03 02 91 f4 03 01 aa',
    strings: ['inflateInit_'],
    constants: [0x789cn, 0x78dan],
    l2BbCount: 8,
    l2EdgeCount: 11,
  },
  {
    symbolName: 'compress2',
    requireAnchor: true,
    libId: 2,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'ff 03 02 d1 f8 5f 05 a9 f6 57 06 a9 f4 4f 07 a9 fd 7b 08 a9 fd 03 02 91 f5 03 04 2a',
    strings: ['deflateInit_'],
    constants: [0x7801n, 0x789cn],
    l2BbCount: 8,
    l2EdgeCount: 11,
  },

  // =========================================================================
  // libpng (libId: 3) — Expanded iOS arm64 Image Decoding Signatures
  // =========================================================================
  {
    symbolName: 'png_create_read_struct',
    requireAnchor: true,
    libId: 3,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bc a9 f8 5f 01 a9 f6 57 02 a9 f4 4f 03 a9 fd 03 00 91 f6 03 03 aa f5 03 02 aa',
    strings: ['libpng version', 'Incompatible libpng version in application and library'],
    constants: [0x89504e47n],
    l2BbCount: 9,
    l2EdgeCount: 12,
  },
  {
    symbolName: 'png_read_info',
    requireAnchor: true,
    libId: 3,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bb a9 f8 5f 01 a9 f6 57 02 a9 f4 4f 03 a9 fd 03 00 91 00 ?? ?? b4 01 ?? ?? b4',
    strings: ['Not a PNG file', 'Missing IHDR before IDAT'],
    constants: [0x49484452n, 0x49444154n],
    l2BbCount: 18,
    l2EdgeCount: 28,
    l2LoopCount: 1,
    l2MaxLoopDepth: 1,
  },
  {
    symbolName: 'png_read_image',
    requireAnchor: true,
    libId: 3,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bb a9 fa 67 01 a9 f8 5f 02 a9 f6 57 03 a9 f4 4f 04 a9 fd 03 00 91 f3 03 00 aa',
    strings: ['png_read_image: unsupported transformation', 'Invalid interlace type'],
    constants: [0x49444154n, 0x49454e44n],
    l2BbCount: 10,
    l2EdgeCount: 14,
    l2LoopCount: 2,
    l2MaxLoopDepth: 2,
  },
  {
    symbolName: 'png_destroy_read_struct',
    requireAnchor: true,
    libId: 3,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f3 03 00 aa 13 ?? ?? b4',
    strings: ['png_destroy_read_struct'],
    constants: [0x504e4700n],
    l2BbCount: 7,
    l2EdgeCount: 9,
  },

  // =========================================================================
  // protobuf (libId: 10) — iOS arm64 Serialization Signatures
  // =========================================================================
  {
    symbolName: 'CodedInputStream::ReadVarint32Fallback',
    requireAnchor: true,
    libId: 10,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 f4 4f 01 a9 fd 03 00 91 08 00 40 f9 09 04 40 f9 1f 01 09 eb',
    strings: ['CodedInputStream::ReadVarint32Fallback'],
    constants: [0x80808080n, 0x0fffffffn],
    l2BbCount: 9,
    l2EdgeCount: 14,
    l2LoopCount: 1,
    l2MaxLoopDepth: 1,
  },
  {
    symbolName: 'CodedInputStream::ReadTagFallback',
    requireAnchor: true,
    libId: 10,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 f4 4f 01 a9 fd 03 00 91 f3 03 00 aa 08 00 40 f9 09 04 40 f9',
    strings: ['CodedInputStream::ReadTagFallback', 'Protocol message contained an invalid tag (zero).'],
    constants: [0x7f7f7f7fn],
    l2BbCount: 8,
    l2EdgeCount: 11,
  },
  {
    symbolName: 'MessageLite::ParseFromArray',
    requireAnchor: true,
    libId: 10,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'ff 83 01 d1 f6 57 04 a9 f4 4f 05 a9 fd 7b 06 a9 fd 83 01 91 f4 03 01 aa f5 03 02 2a',
    strings: ['MessageLite::ParseFromArray', "Can't parse message of type"],
    l2BbCount: 6,
    l2EdgeCount: 8,
  },
  {
    symbolName: 'WireFormatLite::WriteString',
    requireAnchor: true,
    libId: 10,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bc a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f5 03 02 aa f4 03 01 aa f3 03 00 2a',
    strings: ['WireFormatLite::WriteString', 'String field contains invalid UTF-8 data when serializing a protocol buffer'],
    l2BbCount: 7,
    l2EdgeCount: 9,
  },

  // =========================================================================
  // Firebase (libId: 11) — iOS arm64 Analytics & Core SDK Signatures
  // =========================================================================
  {
    symbolName: 'FIRApp::configure',
    requireAnchor: true,
    libId: 11,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 00 ?? ?? 90 01 ?? ?? 90',
    strings: ['FIRApp', '[Firebase/Core]', 'GoogleService-Info.plist'],
    l2BbCount: 8,
    l2EdgeCount: 11,
  },
  {
    symbolName: 'FIRAnalytics::logEventWithName',
    requireAnchor: true,
    libId: 11,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bc a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f3 03 02 aa f4 03 03 aa',
    strings: ['FIRAnalytics', '[Firebase/Analytics]', 'app_measurement'],
    l2BbCount: 6,
    l2EdgeCount: 8,
  },
  {
    symbolName: 'FIRInstallations::installations',
    requireAnchor: true,
    libId: 11,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 f4 4f 01 a9 fd 03 00 91 08 ?? ?? 90 00 01 40 f9',
    strings: ['FIRInstallations', '[Firebase/Installations]'],
    l2BbCount: 5,
    l2EdgeCount: 6,
  },

  // =========================================================================
  // Google Mobile Ads (libId: 12) — iOS arm64 Ad SDK Signatures
  // =========================================================================
  {
    symbolName: 'GADRequest::request',
    requireAnchor: true,
    libId: 12,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 f4 4f 01 a9 fd 03 00 91 00 ?? ?? 90 e1 03 01 aa',
    strings: ['GADRequest', 'googleads.g.doubleclick.net'],
    l2BbCount: 4,
    l2EdgeCount: 4,
  },
  {
    symbolName: 'GADBannerView::loadRequest',
    requireAnchor: true,
    libId: 12,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f3 03 00 aa f4 03 02 aa',
    strings: ['GADBannerView', 'kGADAdSizeBanner'],
    l2BbCount: 7,
    l2EdgeCount: 9,
  },
  {
    symbolName: 'GADInterstitial::presentFromRootViewController',
    requireAnchor: true,
    libId: 12,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bc a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91 f3 03 00 aa f5 03 02 aa',
    strings: ['GADInterstitial', 'GADInterstitialAd'],
    l2BbCount: 8,
    l2EdgeCount: 10,
  },

  // =========================================================================
  // Adjust (libId: 13) — iOS arm64 Attribution & Analytics SDK Signatures
  // =========================================================================
  {
    symbolName: 'ADJActivityHandler::initWithConfig',
    requireAnchor: true,
    libId: 13,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bb a9 f8 5f 01 a9 f6 57 02 a9 f4 4f 03 a9 fd 03 00 91 f4 03 02 aa f5 03 03 aa',
    strings: ['ADJActivityHandler', 'AdjustIoActivityState'],
    l2BbCount: 10,
    l2EdgeCount: 14,
  },
  {
    symbolName: 'ADJPackageBuilder::buildSessionPackage',
    requireAnchor: true,
    libId: 13,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bc a9 f8 5f 01 a9 f6 57 02 a9 f4 4f 03 a9 fd 03 00 91 f3 03 00 aa 08 04 40 f9',
    strings: ['ADJPackageBuilder', 'app_token', 'idfv'],
    l2BbCount: 9,
    l2EdgeCount: 12,
  },
  {
    symbolName: 'Adjust::appDidLaunch',
    requireAnchor: true,
    libId: 13,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 f4 4f 01 a9 fd 03 00 91 f3 03 02 aa 13 ?? ?? b4',
    strings: ['Adjust::appDidLaunch', 'Adjust SDK', 'app.adjust.com'],
    l2BbCount: 6,
    l2EdgeCount: 8,
  },
];

export const BUILTIN_HEXSIG_ENTRIES = Object.freeze(RAW_BUILTIN_SPECS.map(makeEntry));

export function buildBuiltinHexSigDb() {
  return {
    libs: BUILTIN_HEXSIG_LIBS.map((l) => ({ ...l })),
    entries: BUILTIN_HEXSIG_ENTRIES.map((e) => ({
      ...e,
      pattern: new Uint8Array(e.pattern),
      mask: new Uint8Array(e.mask),
      strings: Array.isArray(e.strings) ? [...e.strings] : [],
      constants: Array.isArray(e.constants) ? [...e.constants] : [],
      fingerprint: {
        ...e.fingerprint,
        l1Minhash: new Uint32Array(e.fingerprint.l1Minhash),
      },
    })),
  };
}
