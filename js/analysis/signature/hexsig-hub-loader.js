// Runtime loader for Rizin-derived HSIG1 binary packs (dist/hexsig-hub/).
// Streams .hsig1.gz via js/vendor/fflate.js Gunzip with hard size cap + SHA-256 verification,
// and mounts into HexSigIndex or WASM Slot 4 (`hex_hexsig_mount`).
// INV-005 compliant: zero architecture or ABI direct imports.

import { Gunzip } from '../../vendor/fflate.js';
import {
  HSIG1_MAX_SLOT4_BYTES,
  HSIG1_MATCH_RESULT_SIZE,
  decodeHsig1Pack,
  decodeMatchResult32,
} from './hex-sig-pack.js';
import { HexSigIndex } from './hex-sig-index.js';
import { getHexEngineExports } from '../../core/hex-engine-wasm.js';
import { recordWasmCall, recordFallback } from '../../core/wasm-telemetry.js';

export const HEXSIG_HUB_SCHEMA = 'hex-hexsig-hub/v1';
export const DEFAULT_MAX_COMPRESSED_BYTES = HSIG1_MAX_SLOT4_BYTES * 2;
const SAFE_PACK_FILE_RE = /^[A-Za-z0-9._-]+\.hsig1\.gz$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * Streaming gzip decompression via fflate Gunzip with strict compressed & decompressed byte caps.
 * Immediately throws inside the Gunzip callback on limit violation to abort zip bombs.
 */
export function gunzipBounded(
  gzBytes,
  maxBytes = HSIG1_MAX_SLOT4_BYTES,
  maxCompressedBytes = DEFAULT_MAX_COMPRESSED_BYTES
) {
  if (!(gzBytes instanceof Uint8Array) || gzBytes.length === 0) {
    throw new Error('hexsig-hub: empty or invalid gzip input');
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RangeError(`hexsig-hub: invalid maxBytes (${maxBytes})`);
  }
  if (!Number.isFinite(maxCompressedBytes) || maxCompressedBytes <= 0) {
    throw new RangeError(`hexsig-hub: invalid maxCompressedBytes (${maxCompressedBytes})`);
  }
  if (gzBytes.length > maxCompressedBytes) {
    throw new RangeError(`hexsig-hub: compressed pack exceeds limit (${gzBytes.length} > ${maxCompressedBytes})`);
  }

  const limit = Math.min(Math.floor(maxBytes), HSIG1_MAX_SLOT4_BYTES);
  const chunks = [];
  let total = 0;

  const gunzip = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > limit) {
      throw new RangeError(`hexsig-hub: decompressed pack exceeds limit (${total} > ${limit})`);
    }
    chunks.push(chunk.slice());
  });

  const SLICE = 16384;
  for (let off = 0; off < gzBytes.length; off += SLICE) {
    const end = Math.min(gzBytes.length, off + SLICE);
    gunzip.push(gzBytes.subarray(off, end), end === gzBytes.length);
  }

  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256PureJs(bytes) {
  const len = bytes.length;
  const bitLenHi = Math.floor((len * 8) / 0x100000000) >>> 0;
  const bitLenLo = (len * 8) >>> 0;
  const paddedLen = (len + 9 + 63) & ~63;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes, 0);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, bitLenHi, false);
  dv.setUint32(paddedLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}

export async function computeSha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    const arr = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < arr.length; i++) {
      hex += arr[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
  return sha256PureJs(bytes);
}

function assertSafePackFile(file, packId) {
  if (typeof file !== 'string' || !SAFE_PACK_FILE_RE.test(file) || file.includes('..')) {
    throw new Error(`hexsig-hub: unsafe pack filename "${file}" for ${packId || 'unknown'}`);
  }
}

function assertSha256Field(value, fieldName, packId) {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) {
    throw new Error(`hexsig-hub: missing or invalid ${fieldName} for ${packId || 'unknown'}`);
  }
}

/**
 * Validate a parsed hexsig-hub manifest object (strict filename & SHA-256 checks).
 */
export function validateHexSigHubManifest(manifest, { verifySha256 = true } = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('hexsig-hub: invalid manifest object');
  }
  if (manifest.schema !== HEXSIG_HUB_SCHEMA) {
    throw new Error(`hexsig-hub: unsupported manifest schema "${manifest.schema}"`);
  }
  if (manifest.format !== 'HSIG1') {
    throw new Error(`hexsig-hub: unsupported pack format "${manifest.format}"`);
  }
  if (!Array.isArray(manifest.packs)) {
    throw new Error('hexsig-hub: manifest.packs must be an array');
  }
  for (const p of manifest.packs) {
    if (!p || typeof p !== 'object' || typeof p.packId !== 'string' || p.packId.length === 0) {
      throw new Error('hexsig-hub: invalid pack entry in manifest');
    }
    assertSafePackFile(p.file, p.packId);
    if (verifySha256) {
      assertSha256Field(p.gzipSha256, 'gzipSha256', p.packId);
      assertSha256Field(p.rawSha256, 'rawSha256', p.packId);
    }
  }
  return manifest;
}

/**
 * Decompress, SHA-256 verify (Fail-Closed when verifySha256=true), and decode a single .hsig1.gz pack.
 */
export async function loadHexSigPack(packMeta, {
  gzBytes = null,
  fetchBytes = null,
  baseUrl = '',
  maxBytes = HSIG1_MAX_SLOT4_BYTES,
  maxCompressedBytes = DEFAULT_MAX_COMPRESSED_BYTES,
  verifySha256 = true,
} = {}) {
  if (!packMeta || typeof packMeta !== 'object') {
    throw new Error('hexsig-hub: packMeta is required');
  }
  assertSafePackFile(packMeta.file, packMeta.packId);
  if (verifySha256) {
    assertSha256Field(packMeta.gzipSha256, 'gzipSha256', packMeta.packId);
    assertSha256Field(packMeta.rawSha256, 'rawSha256', packMeta.packId);
  }

  let compressed = gzBytes;
  if (!compressed) {
    if (typeof fetchBytes !== 'function') {
      throw new Error('hexsig-hub: gzBytes or fetchBytes callback is required');
    }
    const target = baseUrl
      ? `${baseUrl.replace(/\/+$/, '')}/${packMeta.file}`
      : packMeta.file;
    compressed = await fetchBytes(target, packMeta);
  }
  if (!(compressed instanceof Uint8Array)) {
    compressed = new Uint8Array(compressed);
  }

  if (verifySha256) {
    const actualGzSha = await computeSha256Hex(compressed);
    if (actualGzSha.toLowerCase() !== packMeta.gzipSha256.toLowerCase()) {
      throw new Error(`hexsig-hub: gzip SHA-256 mismatch for ${packMeta.packId}`);
    }
  }

  const rawBytes = gunzipBounded(compressed, maxBytes, maxCompressedBytes);

  if (verifySha256) {
    const actualRawSha = await computeSha256Hex(rawBytes);
    if (actualRawSha.toLowerCase() !== packMeta.rawSha256.toLowerCase()) {
      throw new Error(`hexsig-hub: raw HSIG1 SHA-256 mismatch for ${packMeta.packId}`);
    }
  }

  const decoded = decodeHsig1Pack(rawBytes);
  return { meta: packMeta, rawBytes, decoded };
}

/**
 * Mount a validated HSIG1 binary blob into WASM Slot 4 (`hex_type_arena_alloc_slot(4, ...)` + `hex_hexsig_mount`).
 * Fail-closed: returns null if Slot 4 is unavailable/OOM or any WASM error/exception occurs (never leaks scratch).
 */
export function mountHexSigPackToWasm(rawBytes, decoded = null, opts = {}) {
  try {
    const ex = opts.wasmExports ?? getHexEngineExports(opts);
    if (
      !ex ||
      typeof ex.hex_hexsig_mount !== 'function' ||
      typeof ex.hex_hexsig_match_fn !== 'function' ||
      typeof ex.hex_type_arena_alloc_slot !== 'function' ||
      typeof ex.hex_engine_scratch_alloc !== 'function'
    ) {
      recordFallback('hexsig:exports_missing');
      return null;
    }
    if (!(rawBytes instanceof Uint8Array) || rawBytes.length > HSIG1_MAX_SLOT4_BYTES) {
      recordFallback('hexsig:invalid_arg');
      return null;
    }

    const parsed = decoded || decodeHsig1Pack(rawBytes);

    // Strictly allocate pack in dedicated Slot 4 so scratch arena can always be reset safely per query
    const packPtr = ex.hex_type_arena_alloc_slot(4, rawBytes.length) >>> 0;
    if (!packPtr) {
      recordFallback('hexsig:oom');
      return null;
    }

    // Re-read ex.memory.buffer after arena allocation (memory.grow detach safety)
    new Uint8Array(ex.memory.buffer).set(rawBytes, packPtr);
    const mountStatus = ex.hex_hexsig_mount(packPtr, rawBytes.length);
    if (mountStatus !== 0) {
      recordFallback(`hexsig:wasm_status_${mountStatus}`);
      return null;
    }
    recordWasmCall('hexsig');

    const textDecoder = new TextDecoder();

    function matchFn(codeBytes, archId) {
      try {
        if (!(codeBytes instanceof Uint8Array) || codeBytes.length < 4) {
          return { matched: false, symbolName: null, confidence: 0, status: 0, entryIndex: -1 };
        }
        if (typeof ex.hex_engine_scratch_reset === 'function') {
          ex.hex_engine_scratch_reset();
        }
        const codePtr = ex.hex_engine_scratch_alloc(codeBytes.length, 8) >>> 0;
        const outPtr = ex.hex_engine_scratch_alloc(HSIG1_MATCH_RESULT_SIZE, 8) >>> 0;
        if (!codePtr || !outPtr) {
          recordFallback('hexsig:oom');
          return { matched: false, symbolName: null, confidence: 0, status: 0, entryIndex: -1 };
        }
        new Uint8Array(ex.memory.buffer).set(codeBytes, codePtr);
        const st = ex.hex_hexsig_match_fn(codePtr, codeBytes.length, archId >>> 0, outPtr);
        if (st !== 0) {
          recordFallback(`hexsig:wasm_status_${st}`);
          return { matched: false, symbolName: null, confidence: 0, status: 0, entryIndex: -1 };
        }
        recordWasmCall('hexsig');
        const res = decodeMatchResult32(new Uint8Array(ex.memory.buffer, outPtr, HSIG1_MATCH_RESULT_SIZE));
        const matched = res.status !== 0 && res.entryIndex < parsed.entryCount;
        let symbolName = null;
        if (matched) {
          if (parsed.entries[res.entryIndex]) {
            symbolName = parsed.entries[res.entryIndex].symbolName;
          } else if (res.nameOff !== 0xffffffff && res.nameLen > 0) {
            symbolName = textDecoder.decode(
              rawBytes.subarray(parsed.strPoolOff + res.nameOff, parsed.strPoolOff + res.nameOff + res.nameLen)
            );
          }
        }
        return {
          engine: 'wasm',
          matched,
          symbolName,
          confidence: res.confidence,
          runnerUpConf: res.runnerUpConf,
          status: res.status,
          entryIndex: matched ? res.entryIndex : -1,
          libId: res.libId,
          wasmResult: res,
        };
      } catch {
        recordFallback('hexsig:wasm_exception');
        return { matched: false, symbolName: null, confidence: 0, status: 0, entryIndex: -1 };
      }
    }

    return {
      engine: 'wasm',
      usesSlot4: true,
      packPtr,
      packLen: rawBytes.length,
      decoded: parsed,
      matchFn,
    };
  } catch {
    recordFallback('hexsig:wasm_exception');
    return null;
  }
}

/**
 * High-level runtime hub loader supporting both HexSigIndex (JS) and WASM Slot 4 mounting,
 * with fail-closed offline degradation.
 */
export function createHexSigHubLoader({ manifest, baseUrl = '', fetchBytes = null, verifySha256 = true } = {}) {
  const validManifest = validateHexSigHubManifest(manifest, { verifySha256 });
  const packMap = new Map();
  for (const p of validManifest.packs) {
    packMap.set(p.packId, p);
  }
  const cache = new Map();

  return {
    manifest: validManifest,

    listPacks(archFilter = null) {
      if (!archFilter) return validManifest.packs.slice();
      return validManifest.packs.filter((p) => p.arch === archFilter || p.archMask === archFilter);
    },

    async loadPack(packId, opts = {}) {
      if (cache.has(packId)) return cache.get(packId);
      const meta = packMap.get(packId);
      if (!meta) throw new Error(`hexsig-hub: unknown packId "${packId}"`);
      const loaded = await loadHexSigPack(meta, {
        baseUrl,
        fetchBytes,
        verifySha256,
        ...opts,
      });
      cache.set(packId, loaded);
      return loaded;
    },

    async mountToIndex(packIds = null, opts = {}) {
      const { failClosed = true, ...loadOpts } = opts;
      const ids = packIds || validManifest.packs.map((p) => p.packId);
      const entries = [];
      const libs = [];
      for (const id of ids) {
        try {
          const { meta, decoded } = await this.loadPack(id, loadOpts);
          libs[meta.libId] = {
            libId: meta.libId,
            packId: meta.packId,
            vendor: meta.vendor,
            kind: meta.libKind,
            libName: meta.libName,
          };
          for (const e of decoded.entries) {
            entries.push(e);
          }
        } catch (err) {
          if (!failClosed) throw err;
          recordFallback('hexsig:load_failed');
        }
      }
      return new HexSigIndex(entries, libs);
    },

    async mountToWasm(packId, opts = {}) {
      const { failClosed = true, ...loadOpts } = opts;
      try {
        const { rawBytes, decoded } = await this.loadPack(packId, loadOpts);
        return mountHexSigPackToWasm(rawBytes, decoded, opts);
      } catch (err) {
        if (!failClosed) throw err;
        recordFallback('hexsig:load_failed');
        return null;
      }
    },
  };
}


/**
 * Select and rank HEX-SIG packs from a validated manifest for a target binary.
 * Prioritizes exact format/platform match (e.g. Mach-O iOS -> ios-arm64-macho first),
 * then matching architecture packs.
 */
export function selectHexSigPacksForBinary(manifest, {
  arch = 'arm64',
  format = '',
  platform = '',
} = {}) {
  const packs = Array.isArray(manifest?.packs) ? manifest.packs : [];
  const normArch = String(arch || '').toLowerCase().replace(/^aarch64$/, 'arm64').replace(/^arm64e$/, 'arm64').replace(/^x86_64$/, 'x64');
  const normFmt = String(format || '').toLowerCase();
  const normPlat = String(platform || '').toLowerCase();

  const scored = [];
  for (const p of packs) {
    const pArch = String(p.arch || '').toLowerCase();
    if (normArch && pArch && pArch !== normArch) continue;
    let score = 100;
    const pFmt = String(p.format || 'elf').toLowerCase();
    if (normFmt && pFmt === normFmt) score += 200;
    const pPlats = Array.isArray(p.platforms) ? p.platforms.map((x) => String(x).toLowerCase()) : [];
    if (normPlat && pPlats.includes(normPlat)) score += 150;
    if ((normFmt === 'macho' || normPlat.includes('ios') || normPlat.includes('mac')) && p.packId === 'ios-arm64-macho') {
      score += 300;
    }
    scored.push({ pack: p, score });
  }
  scored.sort((a, b) => (b.score - a.score) || String(a.pack.packId).localeCompare(String(b.pack.packId)));
  return scored.map((s) => s.pack);
}
