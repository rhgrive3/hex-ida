// Built-in clean OSS library signature database for HEX-SIG (§11.1 / §11.2).
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
  const l3ConstHash64 = spec.constants ? computeConstHash64(spec.constants) : 0n;
  const l3StrHash64 = spec.strings ? computeStringHash64(spec.strings) : 0n;
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
    libId: 2,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b be a9 fd 03 00 91 f3 03 00 aa f4 03 01 2a',
    strings: ['1.2.11', 'inflate 1.2.11 Copyright 1995-2017 Mark Adler'],
    l2BbCount: 8,
    l2EdgeCount: 11,
  },
  {
    symbolName: 'png_sig_cmp',
    libId: 3,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 fd 03 00 91 5f 20 00 f1 08 ?? ?? 54',
    constants: [0x89504e47n, 0x0d0a1a0an],
    l2BbCount: 5,
    l2EdgeCount: 6,
  },
  {
    symbolName: 'AES_set_encrypt_key',
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
    libId: 5,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bd a9 f4 4f 01 a9 fd 03 00 91 f3 03 00 aa',
    strings: ['__cxa_throw'],
    l2BbCount: 3,
    l2EdgeCount: 2,
  },
  {
    symbolName: 'il2cpp_runtime_invoke',
    libId: 6,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bc a9 f6 57 01 a9 f4 4f 02 a9 fd 03 00 91',
    strings: ['il2cpp_runtime_invoke'],
    l2BbCount: 5,
    l2EdgeCount: 6,
  },
  {
    symbolName: 'objc_retainAutoreleasedReturnValue',
    libId: 7,
    archId: HEXSIG_ARCH_ARM64,
    hexPattern: 'fd 7b bf a9 fd 03 00 91 e1 03 1e aa 1f 00 00 f1',
    strings: ['objc_retainAutoreleasedReturnValue'],
    l2BbCount: 4,
    l2EdgeCount: 5,
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
      fingerprint: {
        ...e.fingerprint,
        l1Minhash: new Uint32Array(e.fingerprint.l1Minhash),
      },
    })),
  };
}
