// Background automatic HEX-SIG signature scanner (v6 Track 2 + Review Item 5.2).
// INV-005 compliant: zero architecture or semantics imports.

import {
  AUTO_ANALYSIS_STATUS,
  isStrippedFunctionName,
  normalizeVaHex,
  safeInvokeCallback,
  toSafeByteSize,
} from '../common/v6-auto-contracts.js';
import {
  HEXSIG_ARCH_NONE,
  HEXSIG_ARCH_ARM64,
  HEXSIG_ARCH_X86_64,
  fnv1a64,
  crc16Ccitt,
  computeConstHash64,
  computeStringHash64,
} from './hex-sig-extractor.js';
import { HEXSIG_VERDICT, HEXSIG_THRESHOLDS } from './hex-sig-index.js';
import { selectHexSigPacksForBinary } from './hexsig-hub-loader.js';

export { isStrippedFunctionName };

const DEFAULT_CHUNK_SIZE = 32;
const DEFAULT_MAX_BUDGET_MS = 800;
const DEFAULT_MAX_PACKS = 2;
const DEFAULT_READ_BYTES = 64;
const MAX_READ_BYTES = 256;
const MIN_ANCHOR_STRING_LEN = 6;
const MASK64 = 0xffffffffffffffffn;

function defaultYield() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Resolve an architecture identifier or name into a numeric HEX-SIG arch ID.
 * Returns HEXSIG_ARCH_NONE (0) for unsupported or unknown architectures.
 * @param {number|string|null|undefined} arch
 * @returns {number}
 */
export function resolveHexSigArchId(arch) {
  if (arch === HEXSIG_ARCH_ARM64) return HEXSIG_ARCH_ARM64;
  if (arch === HEXSIG_ARCH_X86_64) return HEXSIG_ARCH_X86_64;
  if (typeof arch !== 'string') return HEXSIG_ARCH_NONE;
  const norm = arch.trim().toLowerCase();
  if (norm === 'arm64' || norm === 'aarch64' || norm === 'arm64e' || norm === 'arm64_32') {
    return HEXSIG_ARCH_ARM64;
  }
  if (norm === 'x86_64' || norm === 'x86-64' || norm === 'x64' || norm === 'amd64') {
    return HEXSIG_ARCH_X86_64;
  }
  return HEXSIG_ARCH_NONE;
}

function archIdToSelectionArch(archId) {
  if (archId === HEXSIG_ARCH_ARM64) return 'arm64';
  if (archId === HEXSIG_ARCH_X86_64) return 'x64';
  return '';
}

/**
 * Normalize a HexSig library descriptor or string into a displayable library name.
 * @param {string|object|null|undefined} lib
 * @returns {string}
 */
export function normalizeHexSigLibName(lib) {
  if (typeof lib === 'string') return lib.trim();
  if (!lib || typeof lib !== 'object') return '';
  for (const key of ['libName', 'name', 'vendorName', 'vendor', 'packId']) {
    const val = lib[key];
    if (typeof val === 'string' && val.trim() !== '') {
      return val.trim();
    }
  }
  return '';
}

/**
 * Validate that a byte buffer contains plausible little-endian ARM64 machine code
 * rather than zero padding, 0xFF filler, ASCII text, or unallocated opcodes.
 * Pure bit-pattern check (INV-005 compliant).
 * @param {Uint8Array|ArrayLike<number>|null|undefined} codeBytes
 * @returns {boolean}
 */
export function isPlausibleArm64Code(codeBytes) {
  if (!codeBytes || codeBytes.length < 4) return false;
  const bytes = codeBytes instanceof Uint8Array ? codeBytes : new Uint8Array(codeBytes);
  const wordCount = Math.min(16, Math.floor(bytes.length / 4));
  if (wordCount === 0) return false;

  // Reject pure printable ASCII / NUL text buffers mistaken for code.
  const inspectByteLen = wordCount * 4;
  let asciiLikeBytes = 0;
  for (let i = 0; i < inspectByteLen; i++) {
    const b = bytes[i];
    if (b === 0x00 || b === 0x0a || b === 0x0d || b === 0x09 || (b >= 0x20 && b <= 0x7e)) {
      asciiLikeBytes++;
    }
  }
  if (inspectByteLen >= 8 && asciiLikeBytes === inspectByteLen) {
    return false;
  }

  let validInsns = 0;
  let firstInsnValid = false;
  for (let i = 0; i < wordCount; i++) {
    const off = i * 4;
    const word = (
      bytes[off]
      | (bytes[off + 1] << 8)
      | (bytes[off + 2] << 16)
      | (bytes[off + 3] << 24)
    ) >>> 0;
    if (word === 0x00000000 || word === 0xffffffff) {
      if (i === 0) return false;
      continue;
    }
    // In AArch64, major decode group bits [28:25]: 0..3 are reserved/unallocated in base A64.
    const op0 = (word >>> 25) & 0xf;
    if (op0 >= 4) {
      validInsns++;
      if (i === 0) firstInsnValid = true;
    }
  }

  if (!firstInsnValid) return false;
  return validInsns * 4 >= wordCount * 3; // >= 75% valid A64 instructions
}

/**
 * Check if an ARM64 byte prefix starts with a recognizable standard iOS function prologue
 * (PACIBSP/BTI, STP x29/x30, SUB SP, or register move/load/branch).
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function hasArm64PrologueHint(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const w0 = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  // PACIBSP (0xd503237f) or BTI (0xd50324xx)
  if (w0 === 0xd503237f || (w0 & 0xffffff1f) === 0xd503241f) return true;
  // STP pre-index/signed-offset involving SP (rn=31 -> bits [9:5]=0x1f)
  if ((w0 & 0x3a0003e0) === 0x280003e0) return true;
  // SUB SP, SP, #imm (0xd1xxxxxx with rd=31, rn=31)
  if ((w0 & 0xff0003ff) === 0xd10003ff) return true;
  return false;
}

function normalizeAnchorStrings(rawStrings) {
  if (!Array.isArray(rawStrings) || rawStrings.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const s of rawStrings) {
    if (typeof s !== 'string') continue;
    const trimmed = s.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeAnchorConstants(rawConstants) {
  if (!Array.isArray(rawConstants) || rawConstants.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const c of rawConstants) {
    if (c === null || c === undefined) continue;
    let v;
    try {
      v = BigInt(c) & MASK64;
    } catch {
      continue;
    }
    if (v <= 16n || v === MASK64) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function countMaskedPrefixMatches(codeBytes, entry) {
  if (!codeBytes || !entry?.pattern || !entry?.mask) return { matchedBytes: 0, totalBytes: 0, fullMatch: false };
  const len = Math.min(entry.prologueLen ?? entry.length ?? 0, entry.pattern.length, entry.mask.length, codeBytes.length);
  if (len <= 0) return { matchedBytes: 0, totalBytes: 0, fullMatch: false };
  let matchedBytes = 0;
  let allMatch = true;
  for (let i = 0; i < len; i++) {
    const m = entry.mask[i] & 0xff;
    if ((codeBytes[i] & m) === (entry.pattern[i] & m)) {
      if (allMatch) matchedBytes++;
    } else {
      allMatch = false;
    }
  }
  return { matchedBytes, totalBytes: len, fullMatch: allMatch && len >= 12 };
}

/**
 * Check whether a query provides at least one corroborating string or constant
 * anchor that matches `entry` (used to gate generic-prologue `requireAnchor` entries).
 */
function hasCorroboratingAnchor(query, entry) {
  if (!query || !entry) return false;
  const qFp = query.fingerprint || {};
  const eFp = entry.fingerprint || {};
  const qStrHash = BigInt(qFp.l3StrHash64 ?? 0n) & MASK64;
  const eStrHash = BigInt(eFp.l3StrHash64 ?? 0n) & MASK64;
  const qConstHash = BigInt(qFp.l3ConstHash64 ?? 0n) & MASK64;
  const eConstHash = BigInt(eFp.l3ConstHash64 ?? 0n) & MASK64;

  if (qStrHash !== 0n && eStrHash !== 0n && qStrHash === eStrHash) return true;
  if (qConstHash !== 0n && eConstHash !== 0n && qConstHash === eConstHash) return true;

  const qStrings = normalizeAnchorStrings(query.strings);
  const eStrings = Array.isArray(entry.strings) ? entry.strings : [];
  if (qStrings.length > 0 && eStrings.length > 0) {
    const qStrSet = new Set(qStrings);
    for (const es of eStrings) {
      if (es.length >= MIN_ANCHOR_STRING_LEN && qStrSet.has(es)) {
        return true;
      }
    }
  }

  const qConstants = normalizeAnchorConstants(query.constants);
  const eConstants = Array.isArray(entry.constants) ? entry.constants : [];
  if (qConstants.length > 0 && eConstants.length > 0) {
    const qConstSet = new Set(qConstants);
    let matchedConsts = 0;
    let hasLargeConst = false;
    for (const ec of eConstants) {
      const v = BigInt(ec) & MASK64;
      if (v > 16n && qConstSet.has(v)) {
        matchedConsts++;
        if (v >= 0x10000n) hasLargeConst = true;
      }
    }
    if (matchedConsts >= 2 || (matchedConsts === 1 && hasLargeConst)) {
      return true;
    }
  }

  return false;
}

/**
 * Anchor-assisted matcher for stripped library functions when exact prologue bytes
 * vary across compiler/SDK builds, gated by ARM64 code validation and strict confidence/margin thresholds.
 */
function matchByAnchors(hexSigIndex, codeBytes, archId, query, matchOpts = {}) {
  if (!hexSigIndex || !Array.isArray(hexSigIndex.entries) || hexSigIndex.entries.length === 0) {
    return null;
  }
  if (archId === HEXSIG_ARCH_ARM64 && !isPlausibleArm64Code(codeBytes)) {
    return null;
  }

  const qFp = query?.fingerprint || {};
  const qStrHash = BigInt(qFp.l3StrHash64 ?? 0n) & MASK64;
  const qConstHash = BigInt(qFp.l3ConstHash64 ?? 0n) & MASK64;
  const qStrings = normalizeAnchorStrings(query?.strings);
  const qConstants = normalizeAnchorConstants(query?.constants);

  if (qStrHash === 0n && qConstHash === 0n && qStrings.length === 0 && qConstants.length === 0) {
    return null;
  }

  const qStrSet = new Set(qStrings);
  const qConstSet = new Set(qConstants);
  const qCryptoMask = (qFp.l3CryptoMask ?? 0) & 0xffff;
  const qLibHintMask = (qFp.l3LibHintMask ?? 0) & 0xffff;

  const minScore = Number.isFinite(matchOpts.anchorMinScore)
    ? matchOpts.anchorMinScore
    : HEXSIG_THRESHOLDS.AUTO_NAME_SCORE;
  const minMargin = Number.isFinite(matchOpts.anchorMinMargin)
    ? matchOpts.anchorMinMargin
    : HEXSIG_THRESHOLDS.AUTO_NAME_MARGIN;

  const prologueHint = archId === HEXSIG_ARCH_ARM64 && hasArm64PrologueHint(codeBytes);

  let bestIdx = -1;
  let bestScore = 0;
  let secondScore = 0;

  // Track how many entries match each query anchor to guard against ambiguous anchors.
  const candidates = [];
  for (let i = 0; i < hexSigIndex.entries.length; i++) {
    const entry = hexSigIndex.entries[i];
    if (!entry) continue;
    const entryArch = entry.arch ?? entry.archId ?? HEXSIG_ARCH_ARM64;
    if (entryArch !== archId) continue;

    const eFp = entry.fingerprint || {};
    const eStrHash = BigInt(eFp.l3StrHash64 ?? 0n) & MASK64;
    const eConstHash = BigInt(eFp.l3ConstHash64 ?? 0n) & MASK64;

    const exactStrHashHit = qStrHash !== 0n && eStrHash !== 0n && qStrHash === eStrHash;
    const exactConstHashHit = qConstHash !== 0n && eConstHash !== 0n && qConstHash === eConstHash;

    // Individual string anchor overlap (for functions referencing extra strings beyond the signature anchor)
    let matchedStrings = 0;
    let maxMatchedStrLen = 0;
    const eStrings = Array.isArray(entry.strings) ? entry.strings : [];
    if (eStrings.length > 0 && qStrSet.size > 0) {
      for (const es of eStrings) {
        if (es.length >= MIN_ANCHOR_STRING_LEN && qStrSet.has(es)) {
          matchedStrings++;
          if (es.length > maxMatchedStrLen) maxMatchedStrLen = es.length;
        }
      }
    }

    // Individual constant anchor overlap
    let matchedConstants = 0;
    let hasLargeConstHit = false;
    const eConstants = Array.isArray(entry.constants) ? entry.constants : [];
    if (eConstants.length > 0 && qConstSet.size > 0) {
      for (const ec of eConstants) {
        const v = BigInt(ec) & MASK64;
        if (v > 16n && qConstSet.has(v)) {
          matchedConstants++;
          if (v >= 0x10000n) hasLargeConstHit = true;
        }
      }
    }

    const hasStrSignal = exactStrHashHit || matchedStrings > 0;
    const hasConstSignal = exactConstHashHit || matchedConstants >= 2 || (matchedConstants === 1 && eConstants.length === 1 && hasLargeConstHit);

    if (!hasStrSignal && !hasConstSignal) continue;

    // Compute anchor confidence score (0..1000)
    let anchorScore = 0;
    if (exactStrHashHit) {
      anchorScore += 560;
    } else if (matchedStrings > 0) {
      const allEntryStrings = eStrings.length > 0 && matchedStrings >= eStrings.length;
      if (allEntryStrings) {
        anchorScore += 560;
      } else if (maxMatchedStrLen >= 10 || matchedStrings >= 2) {
        anchorScore += Math.min(540, 460 + (matchedStrings - 1) * 40);
      } else {
        anchorScore += 380;
      }
    }

    if (exactConstHashHit) {
      anchorScore += 520;
    } else if (matchedConstants > 0) {
      const allEntryConsts = eConstants.length > 0 && matchedConstants >= eConstants.length;
      if (allEntryConsts && (eConstants.length >= 2 || hasLargeConstHit)) {
        anchorScore += 520;
      } else if (matchedConstants >= 2) {
        anchorScore += 460;
      } else if (hasLargeConstHit) {
        anchorScore += 340;
      }
    }

    // Cap combined raw anchor contribution before code/prologue/crypto bonuses
    anchorScore = Math.min(760, anchorScore);

    // Code validation & prologue/pattern compatibility bonus
    const codeBonus = 180;
    const prefix = countMaskedPrefixMatches(codeBytes, entry);
    let prologueBonus = 0;
    if (prefix.fullMatch) {
      prologueBonus = 140;
    } else if (prefix.matchedBytes >= 8) {
      prologueBonus = 100;
    } else if (prologueHint) {
      prologueBonus = 60;
    }

    // Crypto & library hint bonuses/penalties
    let metaBonus = 0;
    const eCryptoMask = (eFp.l3CryptoMask ?? 0) & 0xffff;
    if (eCryptoMask !== 0 && qCryptoMask !== 0) {
      if ((eCryptoMask & qCryptoMask) !== 0) {
        metaBonus += 100;
      } else {
        metaBonus -= 220;
      }
    }
    const eLibHintMask = (eFp.l3LibHintMask ?? 0) & 0xffff;
    if (eLibHintMask !== 0 && qLibHintMask !== 0 && (eLibHintMask & qLibHintMask) !== 0) {
      metaBonus += 60;
    }

    const effectiveStrMatches = matchedStrings > 0
      ? matchedStrings
      : (exactStrHashHit ? Math.max(1, eStrings.length) : 0);
    const effectiveConstMatches = matchedConstants > 0
      ? matchedConstants
      : (exactConstHashHit ? Math.max(1, eConstants.length) : 0);
    // Single-string-only matches (no corroborating 2nd string, constant, or full byte pattern)
    // must never auto-name (e.g., callers/wrappers referencing a single shared library string).
    const isSingleStringOnly = effectiveStrMatches <= 1
      && effectiveConstMatches === 0
      && !prefix.fullMatch;

    let total = Math.max(0, Math.min(1000, anchorScore + codeBonus + prologueBonus + metaBonus));
    if (isSingleStringOnly) {
      total = Math.min(total, HEXSIG_THRESHOLDS.AUTO_NAME_SCORE - 1);
    }
    candidates.push({
      idx: i,
      score: total,
      exactStrHashHit,
      exactConstHashHit,
      matchedStrings,
      matchedConstants,
      isSingleStringOnly,
    });
  }

  if (candidates.length === 0) return null;

  // Uniqueness bonus: if exactly 1 entry in the DB matched the strong anchor, boost slightly.
  for (const c of candidates) {
    let finalScore = c.score;
    if (
      !c.isSingleStringOnly
      && candidates.length === 1
      && (c.exactStrHashHit || c.exactConstHashHit || c.matchedStrings >= 2 || c.matchedConstants >= 2 || (c.matchedStrings >= 1 && c.matchedConstants >= 1))
    ) {
      finalScore = Math.min(1000, finalScore + 100);
    }
    if (c.isSingleStringOnly) {
      finalScore = Math.min(finalScore, HEXSIG_THRESHOLDS.AUTO_NAME_SCORE - 1);
    }
    if (finalScore > bestScore) {
      secondScore = bestScore;
      bestScore = finalScore;
      bestIdx = c.idx;
    } else if (finalScore > secondScore) {
      secondScore = finalScore;
    }
  }

  const margin = Math.max(0, bestScore - secondScore);
  if (bestIdx < 0 || bestScore < minScore || margin < minMargin) {
    return null;
  }

  const entry = hexSigIndex.entries[bestIdx];
  const libObj = typeof hexSigIndex.getLib === 'function'
    ? hexSigIndex.getLib(entry.libId)
    : (Array.isArray(hexSigIndex.libs) ? hexSigIndex.libs[entry.libId] : null);

  return {
    engine: 'js',
    matched: true,
    entryIndex: bestIdx,
    symbolName: entry.symbolName,
    libId: entry.libId,
    lib: libObj || null,
    score1: bestScore,
    score2: secondScore,
    margin,
    verdict: HEXSIG_VERDICT.AUTO_NAME,
    anchorMatched: true,
  };
}

/**
 * Return a non-destructive copy of a HexSig hub manifest whose pack `arch` fields
 * are normalized to `'arm64'` or `'x64'` so `selectHexSigPacksForBinary` matches accurately.
 * @param {object|null|undefined} manifest
 * @returns {object}
 */
export function normalizeHexSigManifestForSelection(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { packs: [] };
  }
  const rawPacks = Array.isArray(manifest.packs) ? manifest.packs : [];
  const packs = [];
  for (const p of rawPacks) {
    if (!p || typeof p !== 'object') continue;
    let archId = resolveHexSigArchId(p.arch);
    if (archId === HEXSIG_ARCH_NONE && (p.arch == null || p.arch === '')) {
      archId = resolveHexSigArchId(p.archMask);
    }
    const normalizedArch = archIdToSelectionArch(archId);
    packs.push({
      ...p,
      arch: normalizedArch || (typeof p.arch === 'string' ? p.arch.trim().toLowerCase() : p.arch),
    });
  }
  return {
    ...manifest,
    packs,
  };
}

/**
 * Build a HexSigIndex.match() query object from raw function prologue bytes.
 * Merges optional custom `extractQuery(bytes, archId)` output and optional anchor metadata
 * (`strings`, `constants`, `cryptoMask`, `libHintMask`, `fingerprint`) when provided.
 * @param {Uint8Array|ArrayLike<number>} codeBytes
 * @param {number|string} archId
 * @param {Function|null} [extractQuery=null]
 * @param {object|null} [anchorContext=null]
 * @returns {object}
 */
export function buildHexSigMatchQuery(codeBytes, archId, extractQuery = null, anchorContext = null) {
  const bytes = codeBytes instanceof Uint8Array
    ? codeBytes
    : new Uint8Array(codeBytes || 0);
  const resolvedArch = typeof archId === 'number'
    ? archId
    : resolveHexSigArchId(archId);

  const pattern = bytes.subarray(0, Math.min(32, bytes.length));
  const patternHash64 = fnv1a64(pattern);
  const tailLen = Math.min(32, Math.max(0, bytes.length - pattern.length));
  const crc16 = tailLen > 0
    ? crc16Ccitt(bytes, pattern.length, pattern.length + tailLen)
    : crc16Ccitt(pattern, pattern.length > 16 ? 16 : 0, pattern.length);

  const baseQuery = {
    arch: resolvedArch,
    archId: resolvedArch,
    codeBytes: bytes,
    pattern,
    length: pattern.length,
    patternHash64,
    crc16,
    tailOffset: tailLen > 0 ? pattern.length : 0,
    tailLen,
  };

  if (anchorContext && typeof anchorContext === 'object') {
    const strings = normalizeAnchorStrings(anchorContext.strings);
    const constants = normalizeAnchorConstants(anchorContext.constants);
    const baseFp = anchorContext.fingerprint && typeof anchorContext.fingerprint === 'object'
      ? { ...anchorContext.fingerprint }
      : {};
    if (strings.length > 0) {
      baseQuery.strings = strings;
      if (baseFp.l3StrHash64 === undefined || baseFp.l3StrHash64 === 0n) {
        baseFp.l3StrHash64 = computeStringHash64(strings);
      }
    }
    if (constants.length > 0) {
      baseQuery.constants = constants;
      if (baseFp.l3ConstHash64 === undefined || baseFp.l3ConstHash64 === 0n) {
        baseFp.l3ConstHash64 = computeConstHash64(constants);
      }
    }
    if (typeof anchorContext.cryptoMask === 'number' && baseFp.l3CryptoMask === undefined) {
      baseFp.l3CryptoMask = anchorContext.cryptoMask & 0xffff;
    }
    if (typeof anchorContext.libHintMask === 'number' && baseFp.l3LibHintMask === undefined) {
      baseFp.l3LibHintMask = anchorContext.libHintMask & 0xffff;
    }
    if (Object.keys(baseFp).length > 0) {
      baseQuery.fingerprint = baseFp;
    }
  }

  if (typeof extractQuery === 'function') {
    const custom = extractQuery(bytes, resolvedArch, anchorContext);
    if (custom && typeof custom === 'object') {
      const mergedArch = custom.arch ?? custom.archId ?? resolvedArch;
      const mergedFp = (baseQuery.fingerprint && custom.fingerprint)
        ? { ...baseQuery.fingerprint, ...custom.fingerprint }
        : (custom.fingerprint ?? baseQuery.fingerprint);
      const merged = {
        ...baseQuery,
        ...custom,
        arch: mergedArch,
        archId: custom.archId ?? mergedArch,
        codeBytes: custom.codeBytes ?? bytes,
      };
      if (mergedFp !== undefined) {
        merged.fingerprint = mergedFp;
      }
      return merged;
    }
  }

  return baseQuery;
}

function toUint8ArrayOrNull(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  return null;
}

/**
 * Create a budgeted, abortable background HEX-SIG auto-scanner.
 */
export function createHexSigAutoScanner({
  hexSigIndex,
  hubLoader = null,
  mountPack = null,
  mountedPackIds = null,
  isPackMounted = null,
  extractQuery = null,
  getFunctionAnchors = null,
  matchOpts = null,
  chunkSize = DEFAULT_CHUNK_SIZE,
  maxBudgetMs = DEFAULT_MAX_BUDGET_MS,
  maxPacks = DEFAULT_MAX_PACKS,
  yieldFn = null,
  nowFn = () => Date.now(),
} = {}) {
  const safeChunkSize = Number.isFinite(Number(chunkSize)) && Number(chunkSize) >= 1
    ? Math.floor(Number(chunkSize))
    : DEFAULT_CHUNK_SIZE;
  const safeMaxBudgetMs = Number.isFinite(Number(maxBudgetMs)) && Number(maxBudgetMs) >= 0
    ? Number(maxBudgetMs)
    : DEFAULT_MAX_BUDGET_MS;
  const safeMaxPacks = Number.isFinite(Number(maxPacks)) && Number(maxPacks) >= 0
    ? Math.floor(Number(maxPacks))
    : DEFAULT_MAX_PACKS;
  const effectiveYieldFn = typeof yieldFn === 'function' ? yieldFn : defaultYield;
  const effectiveNowFn = typeof nowFn === 'function' ? nowFn : () => Date.now();
  const mountedSet = mountedPackIds instanceof Set ? mountedPackIds : new Set();

  function checkPackMounted(packId) {
    if (typeof isPackMounted === 'function') {
      try {
        if (isPackMounted(packId)) return true;
      } catch {
        // Ignore callback failure and fall back to internal set.
      }
    }
    return mountedSet.has(packId);
  }

  return {
    async run({
      binaryMeta = {},
      functions = [],
      readFunctionBytes,
      getFunctionAnchors: runGetFunctionAnchors = null,
      signal = null,
      onNamed = null,
      onBatchNamed = null,
      onProgress = null,
    } = {}) {
      const results = [];
      const errors = [];
      let scanned = 0;
      let named = 0;
      let skippedNamed = 0;
      const effectiveGetAnchors = typeof runGetFunctionAnchors === 'function'
        ? runGetFunctionAnchors
        : (typeof getFunctionAnchors === 'function' ? getFunctionAnchors : null);

      if (signal?.aborted) {
        safeInvokeCallback(onProgress, {
          phase: 'hexsig',
          status: AUTO_ANALYSIS_STATUS.ABORTED,
          completed: 0,
          total: 0,
        });
        return {
          status: AUTO_ANALYSIS_STATUS.ABORTED,
          scanned,
          named,
          skippedNamed,
          results,
          errors,
        };
      }

      if (!hexSigIndex || typeof hexSigIndex.match !== 'function') {
        safeInvokeCallback(onProgress, {
          phase: 'hexsig',
          status: AUTO_ANALYSIS_STATUS.SKIPPED,
          completed: 0,
          total: 0,
        });
        return {
          status: AUTO_ANALYSIS_STATUS.SKIPPED,
          scanned,
          named,
          skippedNamed,
          results,
          errors,
        };
      }

      const archId = resolveHexSigArchId(binaryMeta?.arch ?? binaryMeta?.archId);
      if (archId === HEXSIG_ARCH_NONE) {
        safeInvokeCallback(onProgress, {
          phase: 'hexsig',
          status: AUTO_ANALYSIS_STATUS.UNSUPPORTED_ARCH,
          completed: 0,
          total: 0,
        });
        return {
          status: AUTO_ANALYSIS_STATUS.UNSUPPORTED_ARCH,
          scanned,
          named,
          skippedNamed,
          results,
          errors,
        };
      }

      const startMs = effectiveNowFn();
      const isBudgetExceeded = () => (effectiveNowFn() - startMs) >= safeMaxBudgetMs;
      const funcList = Array.isArray(functions) ? functions : [];
      const totalFuncs = funcList.length;

      // Phase 1: Select & load packs via hubLoader (if configured).
      if (
        hubLoader
        && hubLoader.manifest
        && typeof hubLoader.loadPack === 'function'
        && safeMaxPacks > 0
      ) {
        const normalizedManifest = normalizeHexSigManifestForSelection(hubLoader.manifest);
        const selectedPacks = selectHexSigPacksForBinary(normalizedManifest, {
          arch: archIdToSelectionArch(archId),
          format: binaryMeta?.format || '',
          platform: binaryMeta?.platform || '',
        }).slice(0, safeMaxPacks);

        if (selectedPacks.length > 0) {
          safeInvokeCallback(onProgress, {
            phase: 'hexsig',
            status: AUTO_ANALYSIS_STATUS.RUNNING,
            completed: 0,
            total: totalFuncs,
            detail: 'loading_packs',
          });
        }

        for (const pack of selectedPacks) {
          if (signal?.aborted) {
            safeInvokeCallback(onProgress, {
              phase: 'hexsig',
              status: AUTO_ANALYSIS_STATUS.ABORTED,
              completed: 0,
              total: totalFuncs,
            });
            return {
              status: AUTO_ANALYSIS_STATUS.ABORTED,
              scanned,
              named,
              skippedNamed,
              results,
              errors,
            };
          }
          if (isBudgetExceeded()) {
            safeInvokeCallback(onProgress, {
              phase: 'hexsig',
              status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
              completed: 0,
              total: totalFuncs,
            });
            return {
              status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
              scanned,
              named,
              skippedNamed,
              results,
              errors,
            };
          }
          if (checkPackMounted(pack.packId)) continue;

          try {
            const loaded = await hubLoader.loadPack(pack.packId);
            if (signal?.aborted) {
              safeInvokeCallback(onProgress, {
                phase: 'hexsig',
                status: AUTO_ANALYSIS_STATUS.ABORTED,
                completed: 0,
                total: totalFuncs,
              });
              return {
                status: AUTO_ANALYSIS_STATUS.ABORTED,
                scanned,
                named,
                skippedNamed,
                results,
                errors,
              };
            }
            if (isBudgetExceeded()) {
              safeInvokeCallback(onProgress, {
                phase: 'hexsig',
                status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
                completed: 0,
                total: totalFuncs,
              });
              return {
                status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
                scanned,
                named,
                skippedNamed,
                results,
                errors,
              };
            }

            if (typeof mountPack === 'function') {
              const mRes = await mountPack(loaded);
              if (signal?.aborted) {
                safeInvokeCallback(onProgress, {
                  phase: 'hexsig',
                  status: AUTO_ANALYSIS_STATUS.ABORTED,
                  completed: 0,
                  total: totalFuncs,
                });
                return {
                  status: AUTO_ANALYSIS_STATUS.ABORTED,
                  scanned,
                  named,
                  skippedNamed,
                  results,
                  errors,
                };
              }
              if (mRes && mRes.ok === false) {
                errors.push({
                  packId: pack.packId,
                  reason: mRes.reason || 'mount_failed',
                });
              } else {
                mountedSet.add(pack.packId);
              }
            } else {
              const meta = loaded?.meta || pack;
              const decoded = loaded?.decoded;
              if (meta && meta.libId !== undefined && Array.isArray(hexSigIndex.libs)) {
                hexSigIndex.libs[meta.libId] = {
                  libId: meta.libId,
                  packId: meta.packId,
                  vendor: meta.vendor,
                  kind: meta.libKind,
                  libName: meta.libName,
                };
              }
              if (decoded && Array.isArray(decoded.entries) && typeof hexSigIndex.addEntry === 'function') {
                for (const entry of decoded.entries) {
                  hexSigIndex.addEntry(entry);
                }
              }
              mountedSet.add(pack.packId);
            }
          } catch (err) {
            errors.push({
              packId: pack.packId,
              reason: err?.message || String(err),
            });
            if (signal?.aborted) {
              safeInvokeCallback(onProgress, {
                phase: 'hexsig',
                status: AUTO_ANALYSIS_STATUS.ABORTED,
                completed: 0,
                total: totalFuncs,
              });
              return {
                status: AUTO_ANALYSIS_STATUS.ABORTED,
                scanned,
                named,
                skippedNamed,
                results,
                errors,
              };
            }
          }
        }
      }

      // Phase 2: Guard against empty index or missing reader.
      const entryCount = Array.isArray(hexSigIndex.entries) ? hexSigIndex.entries.length : 0;
      if (entryCount === 0) {
        const status = errors.length > 0
          ? AUTO_ANALYSIS_STATUS.OFFLINE
          : AUTO_ANALYSIS_STATUS.SKIPPED;
        safeInvokeCallback(onProgress, {
          phase: 'hexsig',
          status,
          completed: 0,
          total: totalFuncs,
        });
        return {
          status,
          scanned,
          named,
          skippedNamed,
          results,
          errors,
        };
      }

      if (typeof readFunctionBytes !== 'function') {
        safeInvokeCallback(onProgress, {
          phase: 'hexsig',
          status: AUTO_ANALYSIS_STATUS.SKIPPED,
          completed: 0,
          total: totalFuncs,
        });
        return {
          status: AUTO_ANALYSIS_STATUS.SKIPPED,
          scanned,
          named,
          skippedNamed,
          results,
          errors,
        };
      }

      // Phase 3: Chunked function scanning with WASM auto-demotion and budget enforcement.
      const baseMatchOpts = matchOpts && typeof matchOpts === 'object' ? { ...matchOpts } : {};
      let sessionPreferWasm = baseMatchOpts.preferWasm !== false;
      let chunkBatch = [];

      function flushChunkBatch() {
        if (chunkBatch.length === 0) return;
        const batch = chunkBatch;
        chunkBatch = [];
        safeInvokeCallback(onBatchNamed, batch);
      }

      safeInvokeCallback(onProgress, {
        phase: 'hexsig',
        status: AUTO_ANALYSIS_STATUS.RUNNING,
        completed: 0,
        total: totalFuncs,
      });

      for (let i = 0; i < totalFuncs; i++) {
        if (signal?.aborted) {
          safeInvokeCallback(onProgress, {
            phase: 'hexsig',
            status: AUTO_ANALYSIS_STATUS.ABORTED,
            completed: i,
            total: totalFuncs,
          });
          return {
            status: AUTO_ANALYSIS_STATUS.ABORTED,
            scanned,
            named,
            skippedNamed,
            results,
            errors,
          };
        }

        if (isBudgetExceeded()) {
          flushChunkBatch();
          safeInvokeCallback(onProgress, {
            phase: 'hexsig',
            status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
            completed: i,
            total: totalFuncs,
          });
          return {
            status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
            scanned,
            named,
            skippedNamed,
            results,
            errors,
          };
        }

        const fn = funcList[i];
        if (fn && typeof fn === 'object') {
          const vaHex = normalizeVaHex(fn.vaHex ?? fn.va ?? fn.addr ?? fn.address);
          if (vaHex) {
            const oldName = typeof fn.name === 'string'
              ? fn.name
              : (fn.name == null ? null : String(fn.name));

            if (!isStrippedFunctionName(oldName)) {
              skippedNamed++;
            } else {
              const readLen = fn.size == null
                ? DEFAULT_READ_BYTES
                : Math.min(toSafeByteSize(fn.size, DEFAULT_READ_BYTES), MAX_READ_BYTES);

              if (readLen > 0) {
                let rawBytes = null;
                let readFailed = false;
                try {
                  rawBytes = await readFunctionBytes(vaHex, readLen, { signal });
                } catch (err) {
                  readFailed = true;
                  errors.push({
                    vaHex,
                    reason: err?.message || String(err),
                  });
                }

                if (signal?.aborted) {
                  safeInvokeCallback(onProgress, {
                    phase: 'hexsig',
                    status: AUTO_ANALYSIS_STATUS.ABORTED,
                    completed: i,
                    total: totalFuncs,
                  });
                  return {
                    status: AUTO_ANALYSIS_STATUS.ABORTED,
                    scanned,
                    named,
                    skippedNamed,
                    results,
                    errors,
                  };
                }

                if (!readFailed) {
                  const codeBytes = toUint8ArrayOrNull(rawBytes);
                  if (codeBytes && codeBytes.length >= 4) {
                    scanned++;
                    try {
                      let anchorContext = null;
                      if (
                        Array.isArray(fn.strings)
                        || Array.isArray(fn.constants)
                        || typeof fn.cryptoMask === 'number'
                        || typeof fn.libHintMask === 'number'
                        || (fn.fingerprint && typeof fn.fingerprint === 'object')
                      ) {
                        anchorContext = {
                          strings: fn.strings,
                          constants: fn.constants,
                          cryptoMask: fn.cryptoMask,
                          libHintMask: fn.libHintMask,
                          fingerprint: fn.fingerprint,
                        };
                      }
                      if (effectiveGetAnchors) {
                        try {
                          const extraAnchors = await effectiveGetAnchors(vaHex, fn);
                          if (extraAnchors && typeof extraAnchors === 'object') {
                            anchorContext = anchorContext
                              ? {
                                  ...anchorContext,
                                  ...extraAnchors,
                                  strings: [
                                    ...(Array.isArray(anchorContext.strings) ? anchorContext.strings : []),
                                    ...(Array.isArray(extraAnchors.strings) ? extraAnchors.strings : []),
                                  ],
                                  constants: [
                                    ...(Array.isArray(anchorContext.constants) ? anchorContext.constants : []),
                                    ...(Array.isArray(extraAnchors.constants) ? extraAnchors.constants : []),
                                  ],
                                }
                              : extraAnchors;
                          }
                        } catch {
                          // Ignore optional anchor provider errors and proceed with prologue matching.
                        }
                      }

                      const query = buildHexSigMatchQuery(codeBytes, archId, extractQuery, anchorContext);
                      let res = hexSigIndex.match(query, {
                        ...baseMatchOpts,
                        preferWasm: sessionPreferWasm,
                      });

                      if (
                        sessionPreferWasm === true
                        && codeBytes.length >= 4
                        && hexSigIndex.entries.length > 0
                        && res?.engine === 'js'
                      ) {
                        sessionPreferWasm = false;
                      }

                      // Gate generic-prologue (`requireAnchor`) entries: never promote to AUTO_NAME
                      // on prologue bytes alone without a corroborating string or constant anchor.
                      if (
                        res
                        && res.matched === true
                        && res.verdict === HEXSIG_VERDICT.AUTO_NAME
                        && Boolean(res.symbolName)
                      ) {
                        const matchedEntry = (
                          typeof res.entryIndex === 'number'
                          && res.entryIndex >= 0
                          && Array.isArray(hexSigIndex.entries)
                        )
                          ? hexSigIndex.entries[res.entryIndex]
                          : null;
                        if (matchedEntry?.requireAnchor === true && !hasCorroboratingAnchor(query, matchedEntry)) {
                          res = {
                            ...res,
                            matched: false,
                            verdict: HEXSIG_VERDICT.VENDOR_FOLD_ONLY,
                          };
                        }
                      }

                      // Anchor-assisted fallback for stripped functions with string/constant anchors
                      // when exact prologue bytes differ across SDK/compiler builds.
                      if (
                        !(res && res.matched === true && res.verdict === HEXSIG_VERDICT.AUTO_NAME && Boolean(res.symbolName))
                        && baseMatchOpts.enableAnchorMatch !== false
                      ) {
                        const anchorHit = matchByAnchors(hexSigIndex, codeBytes, archId, query, baseMatchOpts);
                        if (anchorHit) {
                          res = anchorHit;
                        }
                      }

                      if (
                        res
                        && res.matched === true
                        && res.verdict === HEXSIG_VERDICT.AUTO_NAME
                        && Boolean(res.symbolName)
                      ) {
                        const libObj = res.lib
                          ?? (typeof hexSigIndex.getLib === 'function' ? hexSigIndex.getLib(res.libId) : null);
                        const matchRecord = {
                          vaHex,
                          oldName,
                          newName: String(res.symbolName),
                          libId: typeof res.libId === 'number' ? res.libId : 0xffff,
                          libName: normalizeHexSigLibName(libObj),
                          score: typeof res.score1 === 'number'
                            ? res.score1
                            : (typeof res.confidence === 'number' ? res.confidence : 0),
                          margin: typeof res.margin === 'number' ? res.margin : 0,
                          engine: res.engine === 'wasm' ? 'wasm' : 'js',
                          verdict: res.verdict,
                        };
                        named++;
                        results.push(matchRecord);
                        chunkBatch.push(matchRecord);
                        safeInvokeCallback(onNamed, matchRecord);
                      }
                    } catch (err) {
                      errors.push({
                        vaHex,
                        reason: err?.message || String(err),
                      });
                    }
                  }
                }
              }
            }
          }
        }

        if ((i + 1) % safeChunkSize === 0 && (i + 1) < totalFuncs) {
          flushChunkBatch();
          safeInvokeCallback(onProgress, {
            phase: 'hexsig',
            status: AUTO_ANALYSIS_STATUS.RUNNING,
            completed: i + 1,
            total: totalFuncs,
          });
          if (isBudgetExceeded()) {
            safeInvokeCallback(onProgress, {
              phase: 'hexsig',
              status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
              completed: i + 1,
              total: totalFuncs,
            });
            return {
              status: AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED,
              scanned,
              named,
              skippedNamed,
              results,
              errors,
            };
          }
          await effectiveYieldFn();
          if (signal?.aborted) {
            safeInvokeCallback(onProgress, {
              phase: 'hexsig',
              status: AUTO_ANALYSIS_STATUS.ABORTED,
              completed: i + 1,
              total: totalFuncs,
            });
            return {
              status: AUTO_ANALYSIS_STATUS.ABORTED,
              scanned,
              named,
              skippedNamed,
              results,
              errors,
            };
          }
        }
      }

      flushChunkBatch();
      safeInvokeCallback(onProgress, {
        phase: 'hexsig',
        status: AUTO_ANALYSIS_STATUS.DONE,
        completed: totalFuncs,
        total: totalFuncs,
      });
      return {
        status: AUTO_ANALYSIS_STATUS.DONE,
        scanned,
        named,
        skippedNamed,
        results,
        errors,
      };
    },
  };
}
