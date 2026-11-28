/**
 * Tier-1 TIL Pack Manager with 2-Slot Hot Mounting (Pack A / Pack B),
 * LRU Slot Eviction, Safe Non-Colliding TID Base Allocation, Streaming Gzip / Pre-Filtered ZIP
 * Decompression via fflate, Dual SHA-256 + FNV-32 Verification, Manifest Validation,
 * Community Mirror URL Defense, and Offline/Failure Cache->Core Fallback.
 * Spec: hex_ida_beyond_ida_design.md §10.1, §18.1
 * INV-005: ZERO imports from js/targets/architecture/.
 */

import { TIL_NS } from './til-lite-data.js';
import { Til1View, validateTil1Buffer } from './til-binary-compiler.js';
import { SLOT_ID } from './til-lite-resolver.js';
import { MemoryTilStorage, verifySha256 } from './til-storage.js';
import { validateSdkFilePath, assertNoZipSymlinks, BATCH_SECURITY_LIMITS } from './sdk-batch-compiler.js';

export const PACK_LIMITS = Object.freeze({
  MAX_MANIFEST_BYTES: 512 * 1024,
  MAX_PACK_BYTES: 4 * 1024 * 1024,
  MAX_TOTAL_LOGICAL_SLOTS: 8,
  TID_STRIDE_PER_SLOT: 2560,
});

const GZIP_STREAM_CHUNK_BYTES = 64 * 1024;

let cachedFflate = null;
async function getFflate(injected) {
  if (injected) return injected;
  if (!cachedFflate) {
    cachedFflate = await import('../../../vendor/fflate.js');
  }
  return cachedFflate;
}

function isGzipBytes(bytes) {
  return bytes && bytes.length >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B;
}

function isZipBytes(bytes) {
  return bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function createAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(reason == null ? 'Operation aborted' : String(reason));
  err.name = 'AbortError';
  return err;
}

/**
 * Validates a community mirror URL (§18.1):
 * Requires https:, rejects localhost / loopback / private IPv4/IPv6 ranges.
 */
export function validateCommunityMirrorUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Community mirror must use https:' };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    return { ok: false, error: `Private or local host '${host}' is rejected` };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Validates a TIL-Hub manifest payload against PACK_LIMITS.MAX_MANIFEST_BYTES and schema v1.
 */
export function validateManifestPayload(rawInput, { maxBytes = PACK_LIMITS.MAX_MANIFEST_BYTES } = {}) {
  let text;
  let byteLength;
  if (rawInput instanceof Uint8Array) {
    byteLength = rawInput.byteLength;
    if (byteLength > maxBytes) {
      return { ok: false, error: `Manifest exceeds MAX_MANIFEST_BYTES (${byteLength} > ${maxBytes})` };
    }
    text = new TextDecoder('utf-8').decode(rawInput);
  } else if (typeof rawInput === 'string') {
    byteLength = new TextEncoder().encode(rawInput).byteLength;
    if (byteLength > maxBytes) {
      return { ok: false, error: `Manifest exceeds MAX_MANIFEST_BYTES (${byteLength} > ${maxBytes})` };
    }
    text = rawInput;
  } else if (rawInput && typeof rawInput === 'object') {
    text = JSON.stringify(rawInput);
    byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxBytes) {
      return { ok: false, error: `Manifest exceeds MAX_MANIFEST_BYTES (${byteLength} > ${maxBytes})` };
    }
  } else {
    return { ok: false, error: 'Manifest payload must be Uint8Array, string, or object' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid manifest JSON: ${err.message}` };
  }

  if (!parsed || parsed.schema !== 'til-hub-manifest/v1' || !Array.isArray(parsed.packs)) {
    return { ok: false, error: "Invalid manifest schema: expected 'til-hub-manifest/v1' with packs[]" };
  }
  for (const p of parsed.packs) {
    if (!p || typeof p.id !== 'string' || !p.id) {
      return { ok: false, error: 'Manifest contains pack entry without valid id' };
    }
    if (p.rawBytes !== undefined && p.rawBytes > PACK_LIMITS.MAX_PACK_BYTES) {
      return { ok: false, error: `Pack '${p.id}' declares rawBytes > MAX_PACK_BYTES` };
    }
  }
  return { ok: true, manifest: parsed, byteLength };
}

/**
 * Streaming Gzip decompression via fflate.Gunzip that aborts immediately if cumulative
 * decompressed bytes exceed maxBytes (prevents Gzip Bomb OOM).
 */
function streamingGunzip(ff, bytes, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  let limitErr = null;

  const gunzip = new ff.Gunzip((chunk) => {
    if (limitErr) return;
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      limitErr = new Error(`Decompressed TIL pack exceeds maxBytes (${totalBytes} > ${maxBytes})`);
      throw limitErr;
    }
    chunks.push(chunk);
  });

  for (let off = 0; off < bytes.byteLength; off += GZIP_STREAM_CHUNK_BYTES) {
    const end = Math.min(bytes.byteLength, off + GZIP_STREAM_CHUNK_BYTES);
    const isFinal = end >= bytes.byteLength;
    gunzip.push(bytes.subarray(off, end), isFinal);
    if (limitErr) throw limitErr;
  }
  if (bytes.byteLength === 0) {
    gunzip.push(bytes, true);
  }

  const out = new Uint8Array(totalBytes);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/**
 * Decompresses raw TIL1, .til.gz (streaming Gunzip with immediate maxBytes abort),
 * or .zip (pre-filtered via validateSdkFilePath, symlink check, and maxBytes before inflation).
 */
export async function decompressTilPayload(rawBytes, { fflate = null, maxBytes = PACK_LIMITS.MAX_PACK_BYTES } = {}) {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);

  if (isGzipBytes(bytes)) {
    const ff = await getFflate(fflate);
    const out = streamingGunzip(ff, bytes, maxBytes);
    return { bytes: out, compression: 'gzip', entryName: null };
  }

  if (isZipBytes(bytes)) {
    assertNoZipSymlinks(bytes);
    const ff = await getFflate(fflate);
    let selectedEntry = null;
    let totalCandidateBytes = 0;

    const entries = ff.unzipSync(bytes, {
      filter(file) {
        if (file.name.endsWith('/')) return false;
        const pathCheck = validateSdkFilePath(file.name);
        if (!pathCheck.ok) {
          throw new Error(`Security violation in TIL ZIP: ${pathCheck.error}`);
        }
        const origSize = file.originalSize >>> 0;
        const compSize = file.size >>> 0;
        if (origSize > maxBytes) {
          throw new Error(`ZIP TIL entry '${file.name}' exceeds maxBytes (${origSize} > ${maxBytes})`);
        }
        if (
          origSize > BATCH_SECURITY_LIMITS.ZIP_BOMB_MIN_BYTES &&
          compSize > 0 &&
          origSize / compSize > BATCH_SECURITY_LIMITS.MAX_ZIP_RATIO
        ) {
          throw new Error(`Zip Bomb detected before inflation for '${file.name}'`);
        }
        const isTil = /\.(?:til1?|bin)$/i.test(file.name);
        if (!selectedEntry && isTil) {
          totalCandidateBytes += origSize;
          if (totalCandidateBytes > maxBytes) {
            throw new Error(`Unzipped TIL pack exceeds maxBytes (${totalCandidateBytes} > ${maxBytes})`);
          }
          selectedEntry = file.name;
          return true;
        }
        return false;
      },
    });

    if (!selectedEntry || !entries[selectedEntry]) {
      throw new Error('ZIP archive contains no valid .til/.til1 pack entry');
    }
    const out = entries[selectedEntry];
    if (out.byteLength > maxBytes) {
      throw new Error(`Unzipped TIL pack exceeds maxBytes (${out.byteLength} > ${maxBytes})`);
    }
    return { bytes: out, compression: 'zip', entryName: selectedEntry };
  }

  if (bytes.byteLength > maxBytes) {
    throw new Error(`TIL pack exceeds maxBytes (${bytes.byteLength} > ${maxBytes})`);
  }
  return { bytes, compression: 'none', entryName: null };
}

/**
 * Manages 2-slot Tier-1 pack mounting (Pack A / Pack B) with LRU eviction,
 * non-colliding TID base allocation, storage caching, fflate decompression,
 * dual SHA-256 + TIL1 FNV-32 verification, and offline cache->Core degradation.
 */
export class TilPackManager {
  constructor({ resolver = null, storage = null, fflate = null, fetcher = null } = {}) {
    this.resolver = resolver;
    this.storage = storage || new MemoryTilStorage();
    this.fflate = fflate;
    this.fetcher = fetcher || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

    // 2 hot slots: 'A' (Slot 1) and 'B' (Slot 2)
    this.slots = {
      A: null,
      B: null,
    };
    this._accessSeq = 0;
    this._evictionLog = [];

    // Safe 8-slot logical TID pool (NO % 8 wraparound collision!)
    this._freeTidBases = [];
    for (let i = 0; i < PACK_LIMITS.MAX_TOTAL_LOGICAL_SLOTS; i++) {
      this._freeTidBases.push(TIL_NS.PACK_MIN + i * PACK_LIMITS.TID_STRIDE_PER_SLOT);
    }
    this._assignedTidBaseByPack = new Map(); // packId -> tidBase (currently pinned/referenced)
    this._reclaimableTidBases = new Map(); // packId -> tidBase (explicitly released/unreferenced)
  }

  _isTidBaseMounted(tidBase) {
    return this.slots.A?.tidBase === tidBase || this.slots.B?.tidBase === tidBase;
  }

  _allocateTidBase(packId) {
    if (this._assignedTidBaseByPack.has(packId)) {
      return this._assignedTidBaseByPack.get(packId);
    }
    if (this._reclaimableTidBases.has(packId)) {
      const reused = this._reclaimableTidBases.get(packId);
      this._reclaimableTidBases.delete(packId);
      this._assignedTidBaseByPack.set(packId, reused);
      return reused;
    }
    if (this._freeTidBases.length > 0) {
      const tidBase = this._freeTidBases.shift();
      this._assignedTidBaseByPack.set(packId, tidBase);
      return tidBase;
    }
    // Safely reclaim an unreferenced, non-mounted tidBase if one was released
    for (const [oldPackId, candidateBase] of this._reclaimableTidBases.entries()) {
      if (!this._isTidBaseMounted(candidateBase)) {
        this._reclaimableTidBases.delete(oldPackId);
        this._assignedTidBaseByPack.set(packId, candidateBase);
        return candidateBase;
      }
    }
    throw new Error(
      `No free logical TIL pack slot available (${PACK_LIMITS.MAX_TOTAL_LOGICAL_SLOTS}/${PACK_LIMITS.MAX_TOTAL_LOGICAL_SLOTS} TID ranges pinned)`
    );
  }

  /**
   * Explicitly marks an evicted/unmounted pack's TID base as unreferenced and safe for reuse.
   */
  releasePackTidBase(packId) {
    if (this.slots.A?.packId === packId || this.slots.B?.packId === packId) {
      return false; // Still actively mounted
    }
    const tidBase = this._assignedTidBaseByPack.get(packId);
    if (tidBase === undefined) return false;
    this._assignedTidBaseByPack.delete(packId);
    this._reclaimableTidBases.set(packId, tidBase);
    return true;
  }

  _pickSlotForMount(preferredSlot = null) {
    if (preferredSlot === 'A' || preferredSlot === 'B') return preferredSlot;
    if (!this.slots.A) return 'A';
    if (!this.slots.B) return 'B';
    return this.slots.A.lastAccess <= this.slots.B.lastAccess ? 'A' : 'B';
  }

  touchPack(packId) {
    for (const slotKey of ['A', 'B']) {
      if (this.slots[slotKey]?.packId === packId) {
        this.slots[slotKey].lastAccess = ++this._accessSeq;
        return slotKey;
      }
    }
    return null;
  }

  /**
   * Loads, verifies (SHA-256 + TIL1 FNV-32), decompresses (raw/gzip/zip), caches,
   * and mounts a Tier-1 pack into Pack A or Pack B with LRU eviction.
   * Re-mounting the same packId updates its view and resolver in place.
   */
  async mountPack(packId, rawPayload, {
    expectedSha256 = null,
    expectedRawSha256 = null,
    preferredSlot = null,
    cache = true,
    meta = {},
  } = {}) {
    if (!packId) throw new Error('TilPackManager.mountPack: packId is required');
    const payloadBytes = rawPayload instanceof Uint8Array ? rawPayload : new Uint8Array(rawPayload);

    if (expectedSha256) {
      const check = await verifySha256(payloadBytes, expectedSha256);
      if (!check.ok) {
        throw new Error(`SHA-256 mismatch for pack '${packId}': expected ${check.expected}, got ${check.actual}`);
      }
    }

    const { bytes: tilBytes, compression } = await decompressTilPayload(payloadBytes, {
      fflate: this.fflate,
    });

    if (expectedRawSha256) {
      const check = await verifySha256(tilBytes, expectedRawSha256);
      if (!check.ok) {
        throw new Error(`Raw TIL1 SHA-256 mismatch for pack '${packId}': expected ${check.expected}, got ${check.actual}`);
      }
    }

    const validation = validateTil1Buffer(tilBytes);
    if (!validation.ok) {
      throw new Error(`Invalid TIL1 pack '${packId}': ${validation.error}`);
    }

    if (cache && this.storage) {
      await this.storage.put(packId, tilBytes, {
        ...meta,
        packId,
        compression,
        checksumFnv32: validation.header.checksumFnv32,
      });
    }

    // Check if already mounted in A or B -> refresh view & resolver with the new payload!
    for (const slotKey of ['A', 'B']) {
      if (this.slots[slotKey]?.packId === packId) {
        const tidBase = this.slots[slotKey].tidBase;
        const freshView = new Til1View(tilBytes, {
          tidBase,
          tidCap: PACK_LIMITS.TID_STRIDE_PER_SLOT,
          packId,
        });
        const updatedEntry = {
          packId,
          slot: slotKey,
          tidBase,
          view: freshView,
          compression,
          mountedAt: Date.now(),
          lastAccess: ++this._accessSeq,
          meta: { ...meta, packId, tidBase },
        };
        this.slots[slotKey] = updatedEntry;
        if (this.resolver) {
          const resolverSlot = slotKey === 'A' ? SLOT_ID.PACK_A : SLOT_ID.PACK_B;
          this.resolver.mountPack(resolverSlot, freshView, updatedEntry.meta);
        }
        return {
          slot: slotKey,
          evictedPackId: null,
          reloaded: true,
          entry: updatedEntry,
        };
      }
    }

    const targetSlot = this._pickSlotForMount(preferredSlot);
    const evictedPackId = this.slots[targetSlot]?.packId || null;
    if (evictedPackId) {
      this._evictionLog.push({
        evictedPackId,
        replacedBy: packId,
        slot: targetSlot,
        seq: this._accessSeq,
      });
    }

    const tidBase = this._allocateTidBase(packId);
    const view = new Til1View(tilBytes, {
      tidBase,
      tidCap: PACK_LIMITS.TID_STRIDE_PER_SLOT,
      packId,
    });

    const entry = {
      packId,
      slot: targetSlot,
      tidBase,
      view,
      compression,
      mountedAt: Date.now(),
      lastAccess: ++this._accessSeq,
      meta: { ...meta, packId, tidBase },
    };
    this.slots[targetSlot] = entry;

    if (this.resolver) {
      const resolverSlot = targetSlot === 'A' ? SLOT_ID.PACK_A : SLOT_ID.PACK_B;
      this.resolver.mountPack(resolverSlot, view, entry.meta);
    }

    return {
      slot: targetSlot,
      evictedPackId,
      reloaded: false,
      entry,
    };
  }

  /**
   * Fetches a remote TIL-Hub manifest with MAX_MANIFEST_BYTES enforcement and mirror defense.
   */
  async fetchManifest(url, { isCommunityMirror = false, signal = null } = {}) {
    if (signal?.aborted) throw createAbortError(signal);
    if (isCommunityMirror) {
      const check = validateCommunityMirrorUrl(url);
      if (!check.ok) throw new Error(`Community mirror rejected: ${check.error}`);
    }
    if (!this.fetcher) {
      throw new Error('No fetch implementation available');
    }
    const resp = await this.fetcher(url, { redirect: 'error', ...(signal ? { signal } : {}) });
    if (signal?.aborted) throw createAbortError(signal);
    if (!resp || !resp.ok) {
      throw new Error(`Manifest fetch failed with status ${resp ? resp.status : 'network-error'}`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (signal?.aborted) throw createAbortError(signal);
    const validated = validateManifestPayload(buf);
    if (!validated.ok) throw new Error(validated.error);
    return validated.manifest;
  }

  /**
   * Remote fetch -> verify & mount -> on offline/failure, degrade cleanly to
   * local cache -> Core TIL without throwing (§10.1, §18.1).
   */
  async loadPackWithFallback(packId, {
    url = null,
    isCommunityMirror = false,
    expectedSha256 = null,
    expectedRawSha256 = null,
    preferredSlot = null,
    meta = {},
    signal = null,
  } = {}) {
    if (signal?.aborted) throw createAbortError(signal);
    let remoteError = null;

    if (url && this.fetcher) {
      try {
        if (isCommunityMirror) {
          const check = validateCommunityMirrorUrl(url);
          if (!check.ok) throw new Error(`Community mirror rejected: ${check.error}`);
        }
        const resp = await this.fetcher(url, { redirect: 'error', ...(signal ? { signal } : {}) });
        if (signal?.aborted) throw createAbortError(signal);
        if (!resp || !resp.ok) {
          throw new Error(`HTTP ${resp ? resp.status : 'network-error'}`);
        }
        const rawBytes = new Uint8Array(await resp.arrayBuffer());
        if (signal?.aborted) throw createAbortError(signal);
        const mounted = await this.mountPack(packId, rawBytes, {
          expectedSha256,
          expectedRawSha256,
          preferredSlot,
          cache: true,
          meta,
        });
        return { mounted: true, source: 'remote', ...mounted };
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        remoteError = err;
      }
    }

    if (signal?.aborted) throw createAbortError(signal);

    // Fallback 1: Local persistent cache (OPFS / IDB / Memory)
    try {
      const fromCache = await this.mountFromCache(packId, {
        expectedRawSha256,
        preferredSlot,
      });
      if (fromCache) {
        return {
          mounted: true,
          source: 'cache-fallback',
          remoteError: remoteError ? remoteError.message : null,
          ...fromCache,
        };
      }
    } catch (cacheErr) {
      if (signal?.aborted || cacheErr?.name === 'AbortError') throw cacheErr;
      remoteError = remoteError || cacheErr;
    }

    // Fallback 2: Core TIL graceful degradation (no exception thrown)
    return {
      mounted: false,
      source: 'core-fallback',
      packId,
      slot: null,
      reason: remoteError ? remoteError.message : 'offline-no-cache',
    };
  }

  async mountFromCache(packId, opts = {}) {
    if (!this.storage) return null;
    const cached = await this.storage.get(packId);
    if (!cached) return null;
    return this.mountPack(packId, cached.bytes, { ...opts, cache: false, meta: cached.meta });
  }

  unmountSlot(slotKey, { releaseTidBase = false } = {}) {
    if (slotKey !== 'A' && slotKey !== 'B') return false;
    const prev = this.slots[slotKey];
    this.slots[slotKey] = null;
    if (this.resolver) {
      this.resolver.unmountPack(slotKey === 'A' ? SLOT_ID.PACK_A : SLOT_ID.PACK_B);
    }
    if (prev && releaseTidBase) {
      this.releasePackTidBase(prev.packId);
    }
    return Boolean(prev);
  }

  purgeAllSlots({ releaseTidBases = false } = {}) {
    const prevA = this.slots.A?.packId;
    const prevB = this.slots.B?.packId;
    this.slots.A = null;
    this.slots.B = null;
    if (this.resolver) this.resolver.purgePacks();
    if (releaseTidBases) {
      if (prevA) this.releasePackTidBase(prevA);
      if (prevB) this.releasePackTidBase(prevB);
    }
  }

  getMountedSlots() {
    return {
      A: this.slots.A ? { packId: this.slots.A.packId, tidBase: this.slots.A.tidBase, lastAccess: this.slots.A.lastAccess } : null,
      B: this.slots.B ? { packId: this.slots.B.packId, tidBase: this.slots.B.tidBase, lastAccess: this.slots.B.lastAccess } : null,
    };
  }

  getEvictionLog() {
    return [...this._evictionLog];
  }
}
