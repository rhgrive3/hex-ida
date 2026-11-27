#!/usr/bin/env node
// Real Rizin sigdb FLIRT (.sig) parser & HSIG1 batch pack compiler.
// Parses genuine IDA/Rizin FLIRT v5-v10 binary signature files from
// third_party/rizin-sigdb/ and emits optimized HSIG1 packs + manifest.json
// under dist/hexsig-hub/.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  HEXSIG_ARCH_ARM64,
  HEXSIG_ARCH_X86_64,
  HEXSIG_ENTRY_FLAGS,
  HEXSIG_PATTERN_LEN,
  fnv1a64,
} from '../js/analysis/signature/hex-sig-extractor.js';
import {
  HSIG1_ENTRY_SIZE,
  HSIG1_HEADER_SIZE,
  HSIG1_MAX_SLOT4_BYTES,
  encodeHsig1Pack,
} from '../js/analysis/signature/hex-sig-pack.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const FLIRT_COMPRESSED = 0x10;
const PARSE_MORE_PUBLIC_NAMES = 0x01;
const PARSE_READ_TAIL_BYTES = 0x02;
const PARSE_READ_REFERENCED_FUNCTIONS = 0x04;
const PARSE_MORE_MODULES_WITH_SAME_CRC = 0x08;
const PARSE_MORE_MODULES = 0x10;

// Hard safety caps against malformed / adversarial FLIRT .sig inputs
const MAX_INFLATE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_DEPTH = 64;
const MAX_TREE_NODES = 200000;
const MAX_PATTERN_BYTES = 64;
const MAX_BRANCHES_PER_NODE = 4096;
const MAX_LEAF_ITERATIONS = 4096;
const MAX_SYMBOL_NAME_LEN = 4096;

// Pack catalog mapping each real Rizin sigdb .sig file to pack metadata & cap
const PACK_CATALOG = [
  {
    packId: 'android-ndk-arm64',
    file: 'elf_arm_64_android-ndk.sig',
    arch: HEXSIG_ARCH_ARM64,
    archName: 'arm64',
    libKind: 'runtime',
    libId: 1,
    vendor: 'Android NDK',
    maxEntries: 1200,
    minFixedBytes: 12,
  },
  {
    packId: 'android-ndk-x64',
    file: 'elf_x86_64_android-ndk.sig',
    arch: HEXSIG_ARCH_X86_64,
    archName: 'x86_64',
    libKind: 'runtime',
    libId: 2,
    vendor: 'Android NDK',
    maxEntries: 900,
    minFixedBytes: 10,
  },
  {
    packId: 'ubuntu-openssl-x64',
    file: 'elf_x86_64_ubuntu-openssl.sig',
    arch: HEXSIG_ARCH_X86_64,
    archName: 'x86_64',
    libKind: 'crypto',
    libId: 3,
    vendor: 'OpenSSL',
    maxEntries: 1200,
    minFixedBytes: 12,
  },
  {
    packId: 'ubuntu-libcxx15-x64',
    file: 'elf_x86_64_ubuntu-libc++-15.sig',
    arch: HEXSIG_ARCH_X86_64,
    archName: 'x86_64',
    libKind: 'runtime',
    libId: 4,
    vendor: 'LLVM libc++',
    maxEntries: 700,
    minFixedBytes: 12,
  },
  {
    packId: 'fedora-zlib-x64',
    file: 'elf_x86_64_fedora-zlib.sig',
    arch: HEXSIG_ARCH_X86_64,
    archName: 'x86_64',
    libKind: 'library',
    libId: 5,
    vendor: 'zlib',
    maxEntries: 400,
    minFixedBytes: 8,
  },
  {
    packId: 'ubuntu-libgcc12-x64',
    file: 'elf_x86_64_ubuntu-libgcc-12.sig',
    arch: HEXSIG_ARCH_X86_64,
    archName: 'x86_64',
    libKind: 'runtime',
    libId: 6,
    vendor: 'GCC libgcc',
    maxEntries: 400,
    minFixedBytes: 8,
  },
];

// ============================================================================
// Genuine FLIRT (.sig) Binary Reader (IDASGN v5-v10) with Strict Bounds Guards
// ============================================================================

class FlirtReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  readByte() {
    if (this.pos >= this.buf.length) throw new Error('FLIRT: unexpected EOF in readByte');
    return this.buf[this.pos++];
  }

  readShortBE() {
    if (this.pos + 2 > this.buf.length) throw new Error('FLIRT: unexpected EOF in readShortBE');
    const v = (this.buf[this.pos] << 8) | this.buf[this.pos + 1];
    this.pos += 2;
    return v >>> 0;
  }

  readWordBE() {
    if (this.pos + 4 > this.buf.length) throw new Error('FLIRT: unexpected EOF in readWordBE');
    const v =
      (this.buf[this.pos] * 0x1000000) +
      ((this.buf[this.pos + 1] << 16) | (this.buf[this.pos + 2] << 8) | this.buf[this.pos + 3]);
    this.pos += 4;
    return v >>> 0;
  }

  readMax2Bytes() {
    const b = this.readByte();
    if ((b & 0x80) === 0) return b;
    return (((b & 0x7f) << 8) | this.readByte()) >>> 0;
  }

  readMultipleBytes() {
    const b = this.readByte();
    if ((b & 0x80) !== 0x80) return b;
    if ((b & 0xc0) !== 0xc0) {
      return (((b & 0x7f) << 8) | this.readByte()) >>> 0;
    }
    if ((b & 0xe0) !== 0xe0) {
      const b2 = this.readByte();
      const b3 = this.readByte();
      const b4 = this.readByte();
      return ((((b & 0x3f) << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0);
    }
    return this.readWordBE();
  }

  readVariantMask(length) {
    if (length < 0x10) {
      return BigInt(this.readMax2Bytes());
    }
    if (length <= 0x20) {
      return BigInt(this.readMultipleBytes());
    }
    if (length <= 0x40) {
      const hi = BigInt(this.readMultipleBytes());
      const lo = BigInt(this.readMultipleBytes());
      return (hi << 32n) | lo;
    }
    throw new Error(`FLIRT: unsupported node length ${length}`);
  }
}

export function parseFlirtSig(rawBuf) {
  if (!rawBuf || rawBuf.length < 37) {
    throw new Error('FLIRT: file too small');
  }
  const magic = rawBuf.subarray(0, 6).toString('ascii');
  if (magic !== 'IDASGN') {
    throw new Error(`FLIRT: invalid magic "${magic}"`);
  }

  const version = rawBuf[6];
  if (version < 5 || version > 10) {
    throw new Error(`FLIRT: unsupported version ${version}`);
  }

  // Exact version-dependent header minimum byte lengths
  const minHeaderBytes =
    version >= 10 ? 45 :
    version >= 8 ? 43 :
    version >= 6 ? 41 : 37;
  if (rawBuf.length < minHeaderBytes) {
    throw new Error(`FLIRT: truncated v${version} header (${rawBuf.length} < ${minHeaderBytes})`);
  }

  const archCode = rawBuf[7];
  const fileTypes = rawBuf.readUInt32LE(8);
  const osTypes = rawBuf.readUInt16LE(12);
  const appTypes = rawBuf.readUInt16LE(14);
  const features = rawBuf.readUInt16LE(16);
  const oldNFuncs = rawBuf.readUInt16LE(18);
  const headerCrc16 = rawBuf.readUInt16LE(20);
  const libNameLen = rawBuf[34];

  let pos = 37;
  let nFunctions = oldNFuncs;
  let patternSize = 32;

  if (version >= 6) {
    nFunctions = rawBuf.readUInt32LE(pos);
    pos += 4;
  }
  if (version >= 8) {
    patternSize = rawBuf.readUInt16LE(pos);
    pos += 2;
  }
  if (version >= 10) {
    pos += 2;
  }

  if (pos + libNameLen > rawBuf.length) {
    throw new Error(`FLIRT: library name OOB (${pos} + ${libNameLen} > ${rawBuf.length})`);
  }

  const libName = rawBuf.subarray(pos, pos + libNameLen).toString('utf8').replace(/\0+$/g, '');
  pos += libNameLen;

  let body = rawBuf.subarray(pos);
  if ((features & FLIRT_COMPRESSED) !== 0) {
    try {
      body = zlib.inflateSync(body, { maxOutputLength: MAX_INFLATE_BYTES });
    } catch (err) {
      if (err && err.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(`FLIRT: decompressed body exceeds ${MAX_INFLATE_BYTES} byte limit`);
      }
      body = zlib.inflateRawSync(body, { maxOutputLength: MAX_INFLATE_BYTES });
    }
  }

  const reader = new FlirtReader(body);
  const functions = [];
  let visitedNodes = 0;

  function parseLeaf(patBytes, maskBytes) {
    let outerIters = 0;
    let outerMore = true;
    while (outerMore) {
      if (++outerIters > MAX_LEAF_ITERATIONS) {
        throw new Error('FLIRT: leaf CRC group iteration limit exceeded');
      }
      const crcLen = reader.readByte();
      const crc16 = reader.readShortBE();
      let flags = 0;

      let innerIters = 0;
      let innerMore = true;
      while (innerMore) {
        if (++innerIters > MAX_LEAF_ITERATIONS) {
          throw new Error('FLIRT: leaf module iteration limit exceeded');
        }
        const moduleLen = version >= 9 ? reader.readMultipleBytes() : reader.readMax2Bytes();
        const pubFuncs = [];
        let curOffset = 0;

        let pubIters = 0;
        let morePub = true;
        while (morePub) {
          if (++pubIters > MAX_LEAF_ITERATIONS) {
            throw new Error('FLIRT: public function iteration limit exceeded');
          }
          const delta = version >= 9 ? reader.readMultipleBytes() : reader.readMax2Bytes();
          curOffset += delta;

          let isLocal = false;
          let isCollision = false;
          let flagBytes = 0;
          let b = reader.readByte();
          while (b < 0x20) {
            if (++flagBytes > 16) {
              throw new Error('FLIRT: excessive function flag prefix bytes');
            }
            if (b & 0x02) isLocal = true;
            if (b & 0x08) isCollision = true;
            b = reader.readByte();
          }

          const nameBytes = [];
          while (b >= 0x20) {
            if (nameBytes.length >= MAX_SYMBOL_NAME_LEN) {
              throw new Error('FLIRT: symbol name exceeds max length');
            }
            nameBytes.push(b);
            b = reader.readByte();
          }
          flags = b;
          const name = Buffer.from(nameBytes).toString('utf8');
          pubFuncs.push({ name, offset: curOffset, isLocal, isCollision });
          morePub = (flags & PARSE_MORE_PUBLIC_NAMES) !== 0;
        }

        if ((flags & PARSE_READ_TAIL_BYTES) !== 0) {
          const nTails = version >= 8 ? reader.readByte() : 1;
          for (let t = 0; t < nTails; t++) {
            if (version >= 9) reader.readMultipleBytes();
            else reader.readMax2Bytes();
            reader.readByte();
          }
        }

        if ((flags & PARSE_READ_REFERENCED_FUNCTIONS) !== 0) {
          const nRefs = version >= 8 ? reader.readByte() : 1;
          for (let r = 0; r < nRefs; r++) {
            if (version >= 9) reader.readMultipleBytes();
            else reader.readMax2Bytes();
            let refNameLen = reader.readByte();
            if (refNameLen === 0) refNameLen = reader.readMultipleBytes();
            if (refNameLen > MAX_SYMBOL_NAME_LEN) {
              throw new Error('FLIRT: referenced function name exceeds max length');
            }
            for (let k = 0; k < refNameLen; k++) reader.readByte();
          }
        }

        for (const fn of pubFuncs) {
          if (fn.offset === 0 && !fn.isLocal && fn.name.length > 0) {
            functions.push({
              name: fn.name,
              pattern: patBytes,
              mask: maskBytes,
              crcLen,
              crc16,
              moduleLen,
              isCollision: fn.isCollision,
            });
          }
        }

        innerMore = (flags & PARSE_MORE_MODULES_WITH_SAME_CRC) !== 0;
      }

      outerMore = (flags & PARSE_MORE_MODULES) !== 0;
    }
  }

  function parseTree(prefixPat, prefixMask, depth) {
    if (depth > MAX_TREE_DEPTH) {
      throw new Error(`FLIRT: trie depth limit exceeded (${depth} > ${MAX_TREE_DEPTH})`);
    }
    if (++visitedNodes > MAX_TREE_NODES) {
      throw new Error(`FLIRT: trie node limit exceeded (> ${MAX_TREE_NODES})`);
    }
    const branches = reader.readMultipleBytes();
    if (branches > MAX_BRANCHES_PER_NODE) {
      throw new Error(`FLIRT: excessive branch count (${branches} > ${MAX_BRANCHES_PER_NODE})`);
    }
    if (branches === 0) {
      parseLeaf(prefixPat, prefixMask);
      return;
    }
    for (let i = 0; i < branches; i++) {
      const len = reader.readByte();
      if (len === 0) {
        throw new Error('FLIRT: zero-length branch node (cycle/malformed trie)');
      }
      if (prefixPat.length + len > MAX_PATTERN_BYTES) {
        throw new Error(`FLIRT: pattern length exceeds ${MAX_PATTERN_BYTES} bytes`);
      }
      const vmask = reader.readVariantMask(len);
      const nextPat = new Uint8Array(prefixPat.length + len);
      const nextMask = new Uint8Array(prefixMask.length + len);
      nextPat.set(prefixPat, 0);
      nextMask.set(prefixMask, 0);

      for (let j = 0; j < len; j++) {
        const isVariant = ((vmask >> BigInt(len - 1 - j)) & 1n) !== 0n;
        if (isVariant) {
          nextPat[prefixPat.length + j] = 0;
          nextMask[prefixMask.length + j] = 0x00;
        } else {
          nextPat[prefixPat.length + j] = reader.readByte();
          nextMask[prefixMask.length + j] = 0xff;
        }
      }
      parseTree(nextPat, nextMask, depth + 1);
    }
  }

  parseTree(new Uint8Array(0), new Uint8Array(0), 0);

  return {
    version,
    archCode,
    fileTypes,
    osTypes,
    appTypes,
    features,
    nFunctions,
    patternSize,
    headerCrc16,
    libName,
    functions,
  };
}

// ============================================================================
// Normalization (1:1 parity with C++ hexsig_engine.cpp), Ranking & Compilation
// ============================================================================

function normalizeSymbolName(raw) {
  if (!raw) return '';
  let s = raw.trim();
  const atIdx = s.indexOf('@');
  if (atIdx > 0) s = s.slice(0, atIdx);
  if (s.length < 2 || s.length > 120) return '';
  if (s.startsWith('.L') || s.startsWith('$') || s.startsWith('__PRETTY_FUNCTION__')) return '';
  return s;
}

// 1:1 mirror of C++ `normalize_arm64_slice` in cpp/src/analysis/hexsig_engine.cpp
function alignArm64Pattern(rawPat, rawMask) {
  const len = Math.min(HEXSIG_PATTERN_LEN, rawPat.length & ~3);
  const pat = new Uint8Array(HEXSIG_PATTERN_LEN);
  const msk = new Uint8Array(HEXSIG_PATTERN_LEN);
  let adrpMask = 0;

  for (let off = 0; off < len; off += 4) {
    const m0 = rawMask[off], m1 = rawMask[off + 1], m2 = rawMask[off + 2], m3 = rawMask[off + 3];
    const wMask = ((m0) | (m1 << 8) | (m2 << 16) | (m3 << 24)) >>> 0;
    const w = ((rawPat[off]) | (rawPat[off + 1] << 8) | (rawPat[off + 2] << 16) | (rawPat[off + 3] << 24)) >>> 0;

    let normMask = 0xffffffff;
    if (((wMask & 0xfc000000) >>> 0) === 0xfc000000) {
      if (((w & 0x1f000000) >>> 0) === 0x10000000) {
        normMask = 0x9f00001f;
        const rd = w & 31;
        if (rd < 31) adrpMask |= (1 << rd);
      } else if (((w & 0x7c000000) >>> 0) === 0x14000000) {
        normMask = 0xfc000000;
      } else if (((w & 0xff000010) >>> 0) === 0x54000000) {
        normMask = 0xff00001f;
      } else if (((w & 0x7e000000) >>> 0) === 0x34000000) {
        normMask = 0xff00001f;
      } else if (((w & 0x7e000000) >>> 0) === 0x36000000) {
        normMask = 0xfff8001f;
      } else if (((w & 0x3b000000) >>> 0) === 0x18000000) {
        normMask = 0xff00001f;
      } else if (((w & 0x7f800000) >>> 0) === 0x11000000) {
        const rn = (w >>> 5) & 31;
        const rd = w & 31;
        if (rn < 31 && (adrpMask & (1 << rn)) !== 0) normMask = 0xffc003ff;
        if (rd < 31) adrpMask &= ~(1 << rd);
      } else if (((w & 0x3b000000) >>> 0) === 0x39000000) {
        const rn = (w >>> 5) & 31;
        const rt = w & 31;
        if (rn < 31 && (adrpMask & (1 << rn)) !== 0) normMask = 0xffc003ff;
        if (rt < 31 && (w & 0x00400000) !== 0) adrpMask &= ~(1 << rt);
      } else {
        const rd = w & 31;
        if (rd < 31) adrpMask &= ~(1 << rd);
      }
    }

    const finalMask = (wMask & normMask) >>> 0;
    const finalWord = (w & finalMask) >>> 0;
    pat[off] = finalWord & 0xff;
    pat[off + 1] = (finalWord >>> 8) & 0xff;
    pat[off + 2] = (finalWord >>> 16) & 0xff;
    pat[off + 3] = (finalWord >>> 24) & 0xff;
    msk[off] = finalMask & 0xff;
    msk[off + 1] = (finalMask >>> 8) & 0xff;
    msk[off + 2] = (finalMask >>> 16) & 0xff;
    msk[off + 3] = (finalMask >>> 24) & 0xff;
  }

  return { pat, msk, prologueLen: len };
}

function x64TwoByteHasModrm(op2) {
  if (op2 >= 0x40 && op2 <= 0x4f) return true;
  if (op2 >= 0x90 && op2 <= 0x9f) return true;
  if (op2 === 0xb6 || op2 === 0xb7 || op2 === 0xbe || op2 === 0xbf || op2 === 0xaf || op2 === 0x1f) {
    return true;
  }
  if (op2 === 0xa3 || op2 === 0xab || op2 === 0xb3 || op2 === 0xbb || op2 === 0xbc || op2 === 0xbd) {
    return true;
  }
  if ((op2 >= 0x10 && op2 <= 0x17) || (op2 >= 0x28 && op2 <= 0x2f)) return true;
  return false;
}

// 1:1 mirror of C++ `normalize_x64_slice` in cpp/src/analysis/hexsig_engine.cpp
function alignX64Pattern(rawPat, rawMask) {
  const normLen = Math.min(HEXSIG_PATTERN_LEN, rawPat.length);
  const normMask = new Uint8Array(HEXSIG_PATTERN_LEN);
  for (let i = 0; i < normLen; i++) normMask[i] = 0xff;

  const maskRange = (start, count) => {
    for (let k = 0; k < count && start + k < normLen; k++) {
      normMask[start + k] = 0x00;
    }
  };

  const consumeModrm = (pRef) => {
    if (pRef.p >= normLen) return;
    const modrm = rawPat[pRef.p++];
    const mod = (modrm >>> 6) & 3;
    const rm = modrm & 7;

    let sibDisp32 = false;
    if (mod !== 3 && rm === 4) {
      if (pRef.p >= normLen) {
        pRef.p = normLen;
        return;
      }
      const sib = rawPat[pRef.p++];
      if (mod === 0 && (sib & 7) === 5) sibDisp32 = true;
    }

    if (mod === 0 && rm === 5) {
      maskRange(pRef.p, 4);
      pRef.p = Math.min(normLen, pRef.p + 4);
    } else if (sibDisp32 || mod === 2) {
      pRef.p = Math.min(normLen, pRef.p + 4);
    } else if (mod === 1) {
      pRef.p = Math.min(normLen, pRef.p + 1);
    }
  };

  let pos = 0;
  while (pos < normLen) {
    // ENDBR64: F3 0F 1E FA
    if (
      pos + 4 <= normLen &&
      rawPat[pos] === 0xf3 && rawPat[pos + 1] === 0x0f &&
      rawPat[pos + 2] === 0x1e && rawPat[pos + 3] === 0xfa
    ) {
      pos += 4;
      continue;
    }

    let p = pos;
    let has66 = false;
    while (p < normLen) {
      const b = rawPat[p];
      if (b === 0x66) {
        has66 = true;
        p++;
      } else if (
        b === 0x67 || b === 0xf0 || b === 0xf2 || b === 0xf3 ||
        b === 0x2e || b === 0x3e || b === 0x26 || b === 0x64 || b === 0x65
      ) {
        p++;
      } else {
        break;
      }
    }

    let rex = 0;
    if (p < normLen && (rawPat[p] & 0xf0) === 0x40) {
      rex = rawPat[p];
      p++;
    }
    if (p >= normLen) break;

    const op = rawPat[p++];

    // CALL rel32 (E8) / JMP rel32 (E9)
    if (op === 0xe8 || op === 0xe9) {
      maskRange(p, 4);
      pos = Math.min(normLen, p + 4);
      continue;
    }

    // JMP rel8 (EB) / Jcc rel8 (70..7F)
    if (op === 0xeb || (op >= 0x70 && op <= 0x7f)) {
      maskRange(p, 1);
      pos = Math.min(normLen, p + 1);
      continue;
    }

    // 2-byte escape 0F
    if (op === 0x0f && p < normLen) {
      const op2 = rawPat[p++];
      if (op2 >= 0x80 && op2 <= 0x8f) {
        maskRange(p, 4);
        pos = Math.min(normLen, p + 4);
        continue;
      }
      if (op2 === 0xba) {
        const pRef = { p };
        consumeModrm(pRef);
        pos = Math.min(normLen, pRef.p + 1);
        continue;
      }
      if (x64TwoByteHasModrm(op2)) {
        const pRef = { p };
        consumeModrm(pRef);
        pos = pRef.p;
        continue;
      }
      pos = p;
      continue;
    }

    // PUSH/POP r64 (50..5F), NOP (90), RET (C3)
    if ((op >= 0x50 && op <= 0x5f) || op === 0x90 || op === 0xc3) {
      pos = p;
      continue;
    }

    // MOV r64, imm64 (REX.W + B8..BF) or MOV r32, imm32 (B8..BF)
    if (op >= 0xb8 && op <= 0xbf) {
      const immLen = (rex & 0x08) !== 0 ? 8 : (has66 ? 2 : 4);
      if (immLen >= 4) maskRange(p, immLen);
      pos = Math.min(normLen, p + immLen);
      continue;
    }

    // Common ModRM instructions
    const hasModrm =
      op === 0x88 || op === 0x89 || op === 0x8a || op === 0x8b || op === 0x8d ||
      op === 0x81 || op === 0x83 || op === 0x85 || op === 0x01 || op === 0x03 ||
      op === 0x29 || op === 0x2b || op === 0x31 || op === 0x33 || op === 0x39 ||
      op === 0x3b || op === 0xc1 || op === 0xc7 || op === 0xff;
    if (hasModrm && p < normLen) {
      const pRef = { p };
      consumeModrm(pRef);
      if (op === 0x83 || op === 0xc1) {
        pRef.p = Math.min(normLen, pRef.p + 1);
      } else if (op === 0x81 || op === 0xc7) {
        pRef.p = Math.min(normLen, pRef.p + (has66 ? 2 : 4));
      }
      pos = pRef.p;
      continue;
    }

    pos = p;
  }

  const pat = new Uint8Array(HEXSIG_PATTERN_LEN);
  const msk = new Uint8Array(HEXSIG_PATTERN_LEN);
  for (let i = 0; i < normLen; i++) {
    const finalM = (rawMask[i] & normMask[i]) & 0xff;
    msk[i] = finalM;
    pat[i] = rawPat[i] & finalM;
  }
  return { pat, msk, prologueLen: normLen };
}

function countFixedBits(mask, len) {
  let bits = 0;
  for (let i = 0; i < len; i++) {
    let v = mask[i] & 0xff;
    while (v) {
      v &= v - 1;
      bits++;
    }
  }
  return bits;
}

function scoreSymbolPriority(name, libKind) {
  let bonus = 0;
  if (libKind === 'crypto') {
    if (/^(EVP_|AES_|SHA|RSA_|EC_|ECDSA_|BN_|SSL_|TLS_|HMAC_|BIO_|X509_|PKCS|RAND_|CRYPTO_|OPENSSL_|chacha|poly1305|blake2|ed25519)/i.test(name)) {
      bonus += 80;
    }
  } else if (libKind === 'library') {
    if (/^(deflate|inflate|adler32|crc32|compress|uncompress|gz|zError|zlib)/i.test(name)) {
      bonus += 80;
    }
  } else {
    if (/^(malloc|free|calloc|realloc|memcpy|memmove|memset|memcmp|strlen|strcmp|strncmp|strcpy|strncpy|snprintf|vsnprintf|pthread_|__aeabi_|__udiv|__div|__ashl|__lshr|__mul|_Znwm|_ZdlPv|_ZNSt)/i.test(name)) {
      bonus += 60;
    }
  }
  if (name.length <= 40) bonus += 20;
  if (!name.includes('.')) bonus += 15;
  return bonus;
}

function compilePackFromSig(spec, sigPath, outDir) {
  const rawBuf = fs.readFileSync(sigPath);
  const parsed = parseFlirtSig(rawBuf);

  const dedup = new Map();
  const candidates = [];

  for (const fn of parsed.functions) {
    const symbolName = normalizeSymbolName(fn.name);
    if (!symbolName) continue;

    const aligned = spec.arch === HEXSIG_ARCH_ARM64
      ? alignArm64Pattern(fn.pattern, fn.mask)
      : alignX64Pattern(fn.pattern, fn.mask);

    if (aligned.prologueLen < 8) continue;

    const fixedBits = countFixedBits(aligned.msk, aligned.prologueLen);
    const fixedBytes = Math.floor(fixedBits / 8);
    if (fixedBytes < spec.minFixedBytes) continue;

    const patKey = Buffer.from(aligned.pat.subarray(0, aligned.prologueLen)).toString('hex') +
      ':' + Buffer.from(aligned.msk.subarray(0, aligned.prologueLen)).toString('hex');
    if (dedup.has(patKey)) continue;
    dedup.set(patKey, true);

    const density = fixedBits / (aligned.prologueLen * 8);
    const priority = scoreSymbolPriority(symbolName, spec.libKind);
    const rankScore = Math.round(density * 500) + aligned.prologueLen * 4 + priority - (fn.isCollision ? 120 : 0);

    const hasWildcard = fixedBits < aligned.prologueLen * 8;
    let flags = HEXSIG_ENTRY_FLAGS.VENDOR_LIB;
    if (hasWildcard) flags |= HEXSIG_ENTRY_FLAGS.HAS_WILDCARDS;
    if (spec.libKind === 'crypto') flags |= HEXSIG_ENTRY_FLAGS.CRYPTO_LIB;

    const prologueHash64 = fnv1a64(aligned.pat.subarray(0, aligned.prologueLen));
    const baseConfidence = Math.min(960, Math.max(760, Math.round(740 + density * 200)));

    candidates.push({
      rankScore,
      symbolName,
      arch: spec.arch,
      prologueLen: aligned.prologueLen,
      minFuncLen: aligned.prologueLen,
      libId: spec.libId,
      flags,
      baseConfidence,
      prologueHash64,
      pattern: aligned.pat,
      wildcardMask: aligned.msk,
      tailLen: 0,
      tailOffset: 0,
      tailCrc16: 0,
      fixedBits,
    });
  }

  candidates.sort((a, b) => (b.rankScore - a.rankScore) || a.symbolName.localeCompare(b.symbolName));

  const selected = [];
  let estStrBytes = 0;
  const seenNames = new Set();
  for (const c of candidates) {
    if (selected.length >= spec.maxEntries) break;
    const nameBytes = seenNames.has(c.symbolName) ? 0 : (Buffer.byteLength(c.symbolName, 'utf8') + 1);
    const projectedSize = HSIG1_HEADER_SIZE + (selected.length + 1) * HSIG1_ENTRY_SIZE + estStrBytes + nameBytes;
    if (projectedSize > HSIG1_MAX_SLOT4_BYTES) break;
    seenNames.add(c.symbolName);
    estStrBytes += nameBytes;
    selected.push(c);
  }

  const hsigBlob = encodeHsig1Pack({ entries: selected, archMask: spec.arch });
  const gzBlob = zlib.gzipSync(hsigBlob, { level: 9 });
  const rawSha256 = crypto.createHash('sha256').update(hsigBlob).digest('hex');
  const gzSha256 = crypto.createHash('sha256').update(gzBlob).digest('hex');

  const outFile = `${spec.packId}.hsig1.gz`;
  fs.writeFileSync(path.join(outDir, outFile), gzBlob);

  return {
    packId: spec.packId,
    file: outFile,
    sourceSig: spec.file,
    libName: parsed.libName,
    vendor: spec.vendor,
    libKind: spec.libKind,
    libId: spec.libId,
    arch: spec.archName,
    archMask: spec.arch,
    extractedCount: parsed.functions.length,
    uniqueCandidateCount: candidates.length,
    entryCount: selected.length,
    rawBytes: hsigBlob.length,
    gzipBytes: gzBlob.length,
    rawSha256,
    gzipSha256: gzSha256,
    sampleSymbols: selected.slice(0, 5).map((e) => e.symbolName),
  };
}


// ---------------------------------------------------------------------------
// 5b. Real Mach-O 64-bit ARM64 / ARM64e Object Extractor (ios-arm64-macho)
// ---------------------------------------------------------------------------
function popcount8(v) {
  let x = v & 0xff, c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}

export function extractFunctionsFromMachO64(buf, { tag = '' } = {}) {
  if (!(buf instanceof Uint8Array) || buf.length < 32) {
    throw new Error('macho64: truncated header');
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== 0xfeedfacf) {
    throw new Error(`macho64: invalid magic 0x${magic.toString(16)}`);
  }
  const ncmds = dv.getUint32(16, true);
  let off = 32;
  let textFileOff = 0;
  let textSize = 0;
  let textVmAddr = 0;
  let symoff = 0;
  let nsyms = 0;
  let stroff = 0;
  let strsize = 0;

  for (let i = 0; i < ncmds; i++) {
    if (off + 8 > buf.length) break;
    const cmd = dv.getUint32(off, true);
    const cmdsize = dv.getUint32(off + 4, true);
    if (cmdsize < 8 || off + cmdsize > buf.length) break;
    if (cmd === 0x19) {
      // LC_SEGMENT_64
      const nsects = dv.getUint32(off + 64, true);
      let soff = off + 72;
      for (let s = 0; s < nsects && soff + 80 <= off + cmdsize; s++) {
        const sectname = Buffer.from(buf.subarray(soff, soff + 16)).toString('ascii').replace(/\0.*$/, '');
        const segname = Buffer.from(buf.subarray(soff + 16, soff + 32)).toString('ascii').replace(/\0.*$/, '');
        if (sectname === '__text' && segname === '__TEXT') {
          textVmAddr = Number(dv.getBigUint64(soff + 32, true));
          textSize = Number(dv.getBigUint64(soff + 40, true));
          textFileOff = dv.getUint32(soff + 48, true);
        }
        soff += 80;
      }
    } else if (cmd === 0x02) {
      // LC_SYMTAB
      symoff = dv.getUint32(off + 8, true);
      nsyms = dv.getUint32(off + 12, true);
      stroff = dv.getUint32(off + 16, true);
      strsize = dv.getUint32(off + 20, true);
    }
    off += cmdsize;
  }

  if (textSize === 0 || textFileOff + textSize > buf.length || nsyms === 0) {
    return [];
  }

  const syms = [];
  for (let i = 0; i < nsyms; i++) {
    const eoff = symoff + i * 16;
    if (eoff + 16 > buf.length) break;
    const strx = dv.getUint32(eoff, true);
    const nType = buf[eoff + 4];
    const nSect = buf[eoff + 5];
    const nValue = Number(dv.getBigUint64(eoff + 8, true));
    // N_SECT (0x0e) in section 1 (__text), non-stab
    if ((nType & 0xe0) !== 0 || (nType & 0x0e) !== 0x0e || nSect !== 1) continue;
    if (strx >= strsize || stroff + strx >= buf.length) continue;
    let end = stroff + strx;
    while (end < stroff + strsize && end < buf.length && buf[end] !== 0) end++;
    let name = Buffer.from(buf.subarray(stroff + strx, end)).toString('utf8');
    if (name.startsWith('_')) name = name.slice(1);
    if (!name || name.startsWith('ltmp') || name.startsWith('L_')) continue;
    const relOff = nValue - textVmAddr;
    if (relOff < 0 || relOff >= textSize) continue;
    syms.push({ name: tag ? `${name}${tag}` : name, relOff });
  }

  syms.sort((a, b) => a.relOff - b.relOff);
  const out = [];
  for (let i = 0; i < syms.length; i++) {
    const start = syms[i].relOff;
    const next = i + 1 < syms.length ? syms[i + 1].relOff : textSize;
    const fnLen = Math.min(32, Math.max(0, next - start));
    if (fnLen < 8) continue;
    const rawBytes = buf.subarray(textFileOff + start, textFileOff + start + fnLen);
    const pattern = new Uint8Array(32);
    const mask = new Uint8Array(32);
    pattern.set(rawBytes.subarray(0, fnLen), 0);
    mask.fill(0xff, 0, fnLen);
    out.push({
      name: syms[i].name,
      patternLen: fnLen,
      pattern,
      mask,
      isCollision: false,
    });
  }
  return out;
}

function compileIosArm64MachoPack({ sigDir, iosObjDir, outDir }) {
  const candidates = [];
  const seenKeys = new Set();

  // 1. Real clang-compiled Mach-O arm64 & arm64e (PAC) functions
  const machoFiles = [
    { file: 'ios_arm64_crypto.o', tag: '', bonus: 280 },
    { file: 'ios_arm64e_pac_crypto.o', tag: '__arm64e', bonus: 260 },
  ];
  let machoExtracted = 0;
  for (const mf of machoFiles) {
    const abs = path.join(iosObjDir, mf.file);
    if (!fs.existsSync(abs)) continue;
    const funcs = extractFunctionsFromMachO64(fs.readFileSync(abs), { tag: mf.tag });
    machoExtracted += funcs.length;
    for (const fn of funcs) {
      const aligned = alignArm64Pattern(fn.pattern.subarray(0, fn.patternLen), fn.mask.subarray(0, fn.patternLen));
      if (aligned.prologueLen < 8) continue;
      let fixedBits = 0;
      for (let i = 0; i < aligned.prologueLen; i++) fixedBits += popcount8(aligned.msk[i]);
      if (fixedBits < 24) continue;
      const dedupeKey = `${Buffer.from(aligned.pat.subarray(0, aligned.prologueLen)).toString('hex')}|${Buffer.from(aligned.msk.subarray(0, aligned.prologueLen)).toString('hex')}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      const density = fixedBits / (aligned.prologueLen * 8);
      const hasWildcard = fixedBits < aligned.prologueLen * 8;
      let flags = HEXSIG_ENTRY_FLAGS.VENDOR_LIB | HEXSIG_ENTRY_FLAGS.CRYPTO_LIB;
      if (hasWildcard) flags |= HEXSIG_ENTRY_FLAGS.HAS_WILDCARDS;
      candidates.push({
        rankScore: 1200 + mf.bonus + Math.round(density * 500) + aligned.prologueLen * 4,
        symbolName: fn.name,
        arch: HEXSIG_ARCH_ARM64,
        prologueLen: aligned.prologueLen,
        minFuncLen: aligned.prologueLen,
        libId: 7,
        flags,
        baseConfidence: Math.min(960, Math.max(820, Math.round(780 + density * 180))),
        prologueHash64: fnv1a64(aligned.pat.subarray(0, aligned.prologueLen)),
        pattern: aligned.pat,
        wildcardMask: aligned.msk,
        tailLen: 0,
        tailOffset: 0,
        tailCrc16: 0,
        fixedBits,
      });
    }
  }

  // 2. Cross-OS AArch64 compiler-rt / libm / math / runtime routines (identical AArch64 ISA after PC-rel masking)
  const arm64SigPath = path.join(sigDir, 'elf_arm_64_android-ndk.sig');
  let sigExtracted = 0;
  if (fs.existsSync(arm64SigPath)) {
    const parsed = parseFlirtSig(fs.readFileSync(arm64SigPath));
    sigExtracted = parsed.functions.length;
    for (const fn of parsed.functions) {
      const symbolName = String(fn.name || '').trim();
      if (!symbolName || symbolName.length < 3 || symbolName.length > 96 || /^sub_|^loc_|^\.L/.test(symbolName)) continue;
      if (!symbolName) continue;
      // Keep only portable AArch64 runtime/math/compiler-rt/string/crypto routines (skip Android/bionic-only names)
      if (/android|bionic|__system_property|dl_|pthread_internal/i.test(symbolName)) continue;
      const aligned = alignArm64Pattern(fn.pattern.subarray(0, fn.patternLen), fn.mask.subarray(0, fn.patternLen));
      if (aligned.prologueLen < 8) continue;
      let fixedBits = 0;
      for (let i = 0; i < aligned.prologueLen; i++) fixedBits += popcount8(aligned.msk[i]);
      if (fixedBits < 24) continue;
      const dedupeKey = `${symbolName}|${Buffer.from(aligned.pat.subarray(0, aligned.prologueLen)).toString('hex')}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      const density = fixedBits / (aligned.prologueLen * 8);
      const priority = scoreSymbolPriority(symbolName, 'runtime');
      const rankScore = Math.round(density * 500) + aligned.prologueLen * 4 + priority - (fn.isCollision ? 120 : 0);
      const hasWildcard = fixedBits < aligned.prologueLen * 8;
      let flags = HEXSIG_ENTRY_FLAGS.VENDOR_LIB;
      if (hasWildcard) flags |= HEXSIG_ENTRY_FLAGS.HAS_WILDCARDS;
      candidates.push({
        rankScore,
        symbolName,
        arch: HEXSIG_ARCH_ARM64,
        prologueLen: aligned.prologueLen,
        minFuncLen: aligned.prologueLen,
        libId: 7,
        flags,
        baseConfidence: Math.min(960, Math.max(760, Math.round(740 + density * 200))),
        prologueHash64: fnv1a64(aligned.pat.subarray(0, aligned.prologueLen)),
        pattern: aligned.pat,
        wildcardMask: aligned.msk,
        tailLen: 0,
        tailOffset: 0,
        tailCrc16: 0,
        fixedBits,
      });
    }
  }

  candidates.sort((a, b) => (b.rankScore - a.rankScore) || a.symbolName.localeCompare(b.symbolName));

  const selected = [];
  let estStrBytes = 0;
  const seenNames = new Set();
  for (const c of candidates) {
    if (selected.length >= 1500) break;
    const nameBytes = seenNames.has(c.symbolName) ? 0 : (Buffer.byteLength(c.symbolName, 'utf8') + 1);
    const projectedSize = HSIG1_HEADER_SIZE + (selected.length + 1) * HSIG1_ENTRY_SIZE + estStrBytes + nameBytes;
    if (projectedSize > HSIG1_MAX_SLOT4_BYTES) break;
    seenNames.add(c.symbolName);
    estStrBytes += nameBytes;
    selected.push(c);
  }

  const hsigBlob = encodeHsig1Pack({ entries: selected, archMask: HEXSIG_ARCH_ARM64 });
  const gzBlob = zlib.gzipSync(hsigBlob, { level: 9 });
  const rawSha256 = crypto.createHash('sha256').update(hsigBlob).digest('hex');
  const gzSha256 = crypto.createHash('sha256').update(gzBlob).digest('hex');
  const outFile = 'ios-arm64-macho.hsig1.gz';
  fs.writeFileSync(path.join(outDir, outFile), gzBlob);

  return {
    packId: 'ios-arm64-macho',
    file: outFile,
    sourceSig: 'ios_arm64_crypto.o + ios_arm64e_pac_crypto.o + aarch64-compiler-rt',
    libName: 'iOS ARM64 / ARM64e Mach-O Crypto & Runtime',
    vendor: 'apple-ios-macho',
    libKind: 'crypto-runtime',
    libId: 7,
    arch: 'arm64',
    archMask: HEXSIG_ARCH_ARM64,
    format: 'macho',
    platforms: ['ios', 'ios-simulator', 'macos'],
    extractedCount: machoExtracted + sigExtracted,
    uniqueCandidateCount: candidates.length,
    entryCount: selected.length,
    rawBytes: hsigBlob.length,
    gzipBytes: gzBlob.length,
    rawSha256,
    gzipSha256: gzSha256,
    sampleSymbols: selected.slice(0, 5).map((e) => e.symbolName),
  };
}

export function runImportRizinSigdb({
  sigDir = path.join(ROOT, 'third_party/rizin-sigdb'),
  iosObjDir = path.join(ROOT, 'third_party/ios-arm64-macho'),
  outDir = path.join(ROOT, 'dist/hexsig-hub'),
  quiet = false,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  const packs = [];
  let totalExtracted = 0;
  let totalEntries = 0;
  let totalRawBytes = 0;
  let totalGzipBytes = 0;

  for (const spec of PACK_CATALOG) {
    const sigPath = path.join(sigDir, spec.file);
    if (!fs.existsSync(sigPath)) {
      throw new Error(`Missing Rizin sigdb file: ${sigPath}`);
    }
    const meta = compilePackFromSig(spec, sigPath, outDir);
    packs.push(meta);
    totalExtracted += meta.extractedCount;
    totalEntries += meta.entryCount;
    totalRawBytes += meta.rawBytes;
    totalGzipBytes += meta.gzipBytes;

    if (!quiet) {
      console.log(
        `[hexsig-hub] ${meta.packId.padEnd(22)} | extracted=${String(meta.extractedCount).padStart(6)} | kept=${String(meta.entryCount).padStart(4)} | raw=${(meta.rawBytes / 1024).toFixed(1).padStart(6)} KiB | gz=${(meta.gzipBytes / 1024).toFixed(1).padStart(5)} KiB | sha256=${meta.rawSha256.slice(0, 12)}`
      );
    }
  }


  // Build dedicated iOS ARM64 / ARM64e Mach-O pack when Mach-O objects are present
  if (fs.existsSync(iosObjDir)) {
    const iosMeta = compileIosArm64MachoPack({ sigDir, iosObjDir, outDir });
    packs.push(iosMeta);
    totalExtracted += iosMeta.extractedCount;
    totalEntries += iosMeta.entryCount;
    totalRawBytes += iosMeta.rawBytes;
    totalGzipBytes += iosMeta.gzipBytes;
    if (!quiet) {
      console.log(
        `[hexsig-hub] ${iosMeta.packId.padEnd(22)} | extracted=${String(iosMeta.extractedCount).padStart(6)} | kept=${String(iosMeta.entryCount).padStart(4)} | raw=${(iosMeta.rawBytes / 1024).toFixed(1).padStart(6)} KiB | gz=${(iosMeta.gzipBytes / 1024).toFixed(1).padStart(5)} KiB | sha256=${iosMeta.rawSha256.slice(0, 12)}`
      );
    }
  }

  const manifest = {
    schema: 'hex-hexsig-hub/v1',
    format: 'HSIG1',
    generatedAt: new Date().toISOString(),
    totalExtracted,
    totalEntries,
    totalRawBytes,
    totalGzipBytes,
    packs,
  };

  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  if (!quiet) {
    console.log(
      `[hexsig-hub] TOTAL: ${packs.length} packs | extracted=${totalExtracted} | kept=${totalEntries} | raw=${(totalRawBytes / 1024).toFixed(1)} KiB | gz=${(totalGzipBytes / 1024).toFixed(1)} KiB`
    );
  }

  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runImportRizinSigdb();
}
