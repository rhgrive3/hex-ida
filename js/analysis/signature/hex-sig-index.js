// Fast 2-stage hash + masked-byte + CRC16 lookup & multi-layer HEX-SIG index (§11.1).
// Includes optional WASM bridge (`hex_hexsig_mount` / `hex_hexsig_match_fn`) & telemetry hooks.
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.

import {
  HEXSIG_PATTERN_LEN,
  HEXSIG_ARCH_ARM64,
  scoreHexSigPair,
} from './hex-sig-extractor.js';
import {
  encodeHsig1Pack,
  decodeMatchResult32,
  HSIG1_MATCH_RESULT_SIZE,
} from './hex-sig-pack.js';
import { getHexEngineExports } from '../../core/hex-engine-wasm.js';
import { recordWasmCall, recordFallback } from '../../core/wasm-telemetry.js';

export const HEXSIG_VERDICT = Object.freeze({
  REJECT: 0,
  VENDOR_FOLD_ONLY: 1,
  AUTO_NAME: 2,
  NEED_CG_TIEBREAK: 3,
});

export const HEXSIG_THRESHOLDS = Object.freeze({
  AUTO_NAME_SCORE: 820,
  AUTO_NAME_MARGIN: 80,
  VENDOR_FOLD_SCORE: 640,
  SMALL_FUNC_L1_SCORE: 290,
  SMALL_FUNC_MIN_ANCHOR_NEIGHBORS: 2,
});

function countLayers(layerMask) {
  return ((layerMask & 1) ? 1 : 0) + ((layerMask & 2) ? 1 : 0) + ((layerMask & 4) ? 1 : 0);
}

function maskedPatternMatches(queryPattern, entryPattern, entryMask, length) {
  if (!queryPattern || !entryPattern || !entryMask || length <= 0) return false;
  const n = Math.min(HEXSIG_PATTERN_LEN, length, queryPattern.length, entryPattern.length, entryMask.length);
  if (n <= 0) return false;
  let activeBytes = 0;
  for (let i = 0; i < n; i++) {
    const m = entryMask[i] & 0xff;
    if (m === 0) continue;
    activeBytes++;
    if ((queryPattern[i] & m) !== (entryPattern[i] & m)) return false;
  }
  return activeBytes > 0;
}

export class HexSigIndex {
  constructor(entries = [], libs = []) {
    this.libs = libs.map((l) => ({ ...l }));
    this.entries = [];
    this.byPatternHash = new Map();
    this.byAnchorHash = new Map();
    this.byWlHash = new Map();
    this.byMinHash = new Map();
    this.byArch = new Map();
    this._wasmPackCache = null;

    for (const entry of entries) {
      this.addEntry(entry);
    }
  }

  addEntry(entry) {
    const idx = this.entries.length;
    this.entries.push(entry);
    this._wasmPackCache = null;

    const archId = entry.arch ?? entry.archId ?? HEXSIG_ARCH_ARM64;
    if (!this.byArch.has(archId)) this.byArch.set(archId, []);
    this.byArch.get(archId).push(idx);

    if (typeof entry.patternHash64 === 'bigint' && entry.patternHash64 !== 0n) {
      const key = `${archId}:${entry.patternHash64}`;
      if (!this.byPatternHash.has(key)) this.byPatternHash.set(key, []);
      this.byPatternHash.get(key).push(idx);
    }

    const fp = entry.fingerprint || {};
    const anchors = [fp.l3StrHash64, fp.l3ConstHash64].filter((h) => h && h !== 0n);
    for (const a of anchors) {
      const key = `${archId}:${a}`;
      if (!this.byAnchorHash.has(key)) this.byAnchorHash.set(key, []);
      this.byAnchorHash.get(key).push(idx);
    }

    if (fp.l2WlHash64 && fp.l2WlHash64 !== 0n) {
      const key = `${archId}:${fp.l2WlHash64}`;
      if (!this.byWlHash.has(key)) this.byWlHash.set(key, []);
      this.byWlHash.get(key).push(idx);
    }

    const mh = fp.l1Minhash;
    if (mh && mh.length >= 4) {
      for (let k = 0; k < 4; k++) {
        if ((mh[k] >>> 0) === 0xffffffff) continue;
        const key = `${archId}:${k}:${mh[k] >>> 0}`;
        if (!this.byMinHash.has(key)) this.byMinHash.set(key, []);
        this.byMinHash.get(key).push(idx);
      }
    }
    return idx;
  }

  getLib(libId) {
    if (libId === undefined || libId === null || libId === 0xffff) return null;
    return this.libs[libId] || null;
  }

  /**
   * Optional WASM fast-path matching using `hex_hexsig_mount` + `hex_hexsig_match_fn`.
   * Returns null and records telemetry fallback when `HEX_ENGINE=js` or WASM is unavailable.
   */
  matchWasm(codeBytes, archId, opts = {}) {
    const ex = opts.wasmExports ?? getHexEngineExports(opts);
    if (!ex || typeof ex.hex_hexsig_mount !== 'function' || typeof ex.hex_hexsig_match_fn !== 'function') {
      recordFallback('HEXSIG_JS_FALLBACK');
      return null;
    }
    if (!codeBytes || codeBytes.length < 4 || this.entries.length === 0) {
      return null;
    }
    try {
      const pack = this._wasmPackCache || (this._wasmPackCache = encodeHsig1Pack({ entries: this.entries }));
      if (typeof ex.hex_engine_scratch_reset === 'function') ex.hex_engine_scratch_reset();
      const packPtr = ex.hex_engine_scratch_alloc(pack.length, 8);
      if (!packPtr) {
        recordFallback('HEXSIG_SCRATCH_OOM');
        return null;
      }
      new Uint8Array(ex.memory.buffer).set(pack, packPtr);
      const codePtr = ex.hex_engine_scratch_alloc(codeBytes.length, 8);
      if (!codePtr) {
        recordFallback('HEXSIG_SCRATCH_OOM');
        return null;
      }
      new Uint8Array(ex.memory.buffer).set(codeBytes, codePtr);
      const outPtr = ex.hex_engine_scratch_alloc(HSIG1_MATCH_RESULT_SIZE, 8);
      if (!outPtr) {
        recordFallback('HEXSIG_SCRATCH_OOM');
        return null;
      }

      const mStatus = ex.hex_hexsig_mount(packPtr, pack.length);
      if (mStatus !== 0) {
        recordFallback('HEXSIG_MOUNT_FAIL');
        return null;
      }
      const rStatus = ex.hex_hexsig_match_fn(codePtr, codeBytes.length, archId >>> 0, outPtr);
      if (rStatus !== 0) {
        recordFallback('HEXSIG_MATCH_FAIL');
        return null;
      }
      recordWasmCall('hexsig');
      const res = decodeMatchResult32(new Uint8Array(ex.memory.buffer, outPtr, HSIG1_MATCH_RESULT_SIZE));
      const hasCandidate = res.status !== 0 && res.entryIndex < this.entries.length;
      let verdict = HEXSIG_VERDICT.REJECT;
      if (hasCandidate) {
        switch (res.status) {
          case 1:
            verdict = HEXSIG_VERDICT.VENDOR_FOLD_ONLY;
            break;
          case 2:
            verdict = HEXSIG_VERDICT.AUTO_NAME;
            break;
          case 3:
            verdict = HEXSIG_VERDICT.NEED_CG_TIEBREAK;
            break;
          default:
            verdict = HEXSIG_VERDICT.REJECT;
            break;
        }
      }
      const validCandidate = hasCandidate && verdict !== HEXSIG_VERDICT.REJECT;
      const matched = verdict === HEXSIG_VERDICT.AUTO_NAME || verdict === HEXSIG_VERDICT.VENDOR_FOLD_ONLY;
      const entry = validCandidate ? this.entries[res.entryIndex] : null;
      return {
        engine: 'wasm',
        matched,
        entryIndex: validCandidate ? res.entryIndex : -1,
        symbolName: entry ? entry.symbolName : null,
        libId: validCandidate ? res.libId : 0xffff,
        lib: validCandidate ? this.getLib(res.libId) : null,
        score1: res.confidence,
        score2: res.runnerUpConf,
        margin: Math.max(0, res.confidence - res.runnerUpConf),
        verdict,
        layerMask: validCandidate ? 1 : 0,
        runnerUpEntry: 0xffffffff,
        exactPatternMatch: validCandidate,
        wasmResult: res,
      };
    } catch {
      recordFallback('HEXSIG_WASM_EXCEPTION');
      return null;
    }
  }

  /**
   * 2-stage exact/masked lookup + multi-layer structural scoring.
   * Uses WASM path when `opts.preferWasm && query.codeBytes` and `HEX_ENGINE !== 'js'`,
   * otherwise runs deterministic JS path.
   */
  match(query, opts = {}) {
    if (!query || typeof query !== 'object') {
      return {
        engine: 'js',
        matched: false,
        entryIndex: -1,
        symbolName: null,
        libId: 0xffff,
        lib: null,
        score1: 0,
        score2: 0,
        margin: 0,
        verdict: HEXSIG_VERDICT.REJECT,
        layerMask: 0,
        runnerUpEntry: 0xffffffff,
        exactPatternMatch: false,
      };
    }

    const archId = query.arch ?? query.archId ?? HEXSIG_ARCH_ARM64;

    if (opts.preferWasm && query.codeBytes) {
      const wasmHit = this.matchWasm(query.codeBytes, archId, opts);
      if (wasmHit !== null) return wasmHit;
    }

    const candidateIndices = new Set();

    if (typeof query.patternHash64 === 'bigint' && query.patternHash64 !== 0n) {
      const exactBucket = this.byPatternHash.get(`${archId}:${query.patternHash64}`);
      if (exactBucket) {
        for (const i of exactBucket) candidateIndices.add(i);
      }
    }

    const qFp = query.fingerprint || {};
    for (const a of [qFp.l3StrHash64, qFp.l3ConstHash64]) {
      if (!a || a === 0n) continue;
      const bucket = this.byAnchorHash.get(`${archId}:${a}`);
      if (bucket) {
        for (const i of bucket) candidateIndices.add(i);
      }
    }
    if (qFp.l2WlHash64 && qFp.l2WlHash64 !== 0n) {
      const bucket = this.byWlHash.get(`${archId}:${qFp.l2WlHash64}`);
      if (bucket) {
        for (const i of bucket) candidateIndices.add(i);
      }
    }
    if (qFp.l1Minhash && qFp.l1Minhash.length >= 4) {
      for (let k = 0; k < 4; k++) {
        const v = qFp.l1Minhash[k] >>> 0;
        if (v === 0xffffffff) continue;
        const bucket = this.byMinHash.get(`${archId}:${k}:${v}`);
        if (bucket) {
          for (const i of bucket) candidateIndices.add(i);
        }
      }
    }

    if (candidateIndices.size === 0 || opts.fullArchScan) {
      const archList = this.byArch.get(archId) || [];
      for (const i of archList) candidateIndices.add(i);
    }

    let bestIdx = -1;
    let bestScore = 0;
    let bestLayerMask = 0;
    let bestSL1 = 0;
    let bestExactPattern = false;
    let secondIdx = -1;
    let secondScore = 0;

    for (const idx of candidateIndices) {
      const entry = this.entries[idx];
      if (!entry) continue;

      const patternMatched = Boolean(
        query.pattern
        && entry.pattern
        && entry.mask
        && maskedPatternMatches(query.pattern, entry.pattern, entry.mask, entry.prologueLen ?? entry.length ?? HEXSIG_PATTERN_LEN)
      );
      const crcMatched = patternMatched && (
        !(entry.tailLen > 0)
        || query.crc16 === undefined
        || entry.crc16 === undefined
        || query.crc16 === entry.crc16
      );

      const scored = scoreHexSigPair(qFp, entry.fingerprint || {});
      let score = scored.total;
      let layerMask = scored.layerMask;

      if (patternMatched && crcMatched) {
        score = Math.min(1000, Math.max(score, 650) + 250);
        layerMask |= 1;
      } else if (patternMatched) {
        score = Math.min(1000, Math.max(score, 500) + 180);
        layerMask |= 1;
      }

      if (score > bestScore) {
        secondIdx = bestIdx;
        secondScore = bestScore;
        bestIdx = idx;
        bestScore = score;
        bestLayerMask = layerMask;
        bestSL1 = Math.max(scored.sL1, patternMatched ? 300 : 0);
        bestExactPattern = patternMatched && crcMatched;
      } else if (score > secondScore) {
        secondIdx = idx;
        secondScore = score;
      }
    }

    if (bestIdx < 0 || bestScore < HEXSIG_THRESHOLDS.VENDOR_FOLD_SCORE) {
      const qBb = qFp.l2BbCount ?? 1;
      const isSmallCandidate = bestIdx >= 0
        && qBb <= 2
        && bestSL1 >= HEXSIG_THRESHOLDS.SMALL_FUNC_L1_SCORE;
      if (isSmallCandidate) {
        const entry = this.entries[bestIdx];
        const neighborLibIds = opts.neighborAnchorLibIds || [];
        const sameLibNeighbors = (entry.libId != null && entry.libId !== 0xffff)
          ? neighborLibIds.filter((id) => id === entry.libId).length
          : 0;
        const verdict = sameLibNeighbors >= HEXSIG_THRESHOLDS.SMALL_FUNC_MIN_ANCHOR_NEIGHBORS
          ? HEXSIG_VERDICT.AUTO_NAME
          : HEXSIG_VERDICT.NEED_CG_TIEBREAK;
        return {
          engine: 'js',
          matched: verdict === HEXSIG_VERDICT.AUTO_NAME,
          entryIndex: bestIdx,
          symbolName: entry.symbolName,
          libId: entry.libId,
          lib: this.getLib(entry.libId),
          score1: bestScore,
          score2: secondScore,
          margin: Math.max(0, bestScore - secondScore),
          verdict,
          layerMask: bestLayerMask,
          runnerUpEntry: secondIdx >= 0 ? secondIdx : 0xffffffff,
          exactPatternMatch: bestExactPattern,
        };
      }

      return {
        engine: 'js',
        matched: false,
        entryIndex: -1,
        symbolName: null,
        libId: 0xffff,
        lib: null,
        score1: bestScore,
        score2: secondScore,
        margin: Math.max(0, bestScore - secondScore),
        verdict: HEXSIG_VERDICT.REJECT,
        layerMask: bestLayerMask,
        runnerUpEntry: secondIdx >= 0 ? secondIdx : 0xffffffff,
        exactPatternMatch: false,
      };
    }

    const bestEntry = this.entries[bestIdx];
    const margin = Math.max(0, bestScore - secondScore);
    const layers = countLayers(bestLayerMask);

    let verdict = HEXSIG_VERDICT.VENDOR_FOLD_ONLY;
    if (
      bestScore >= HEXSIG_THRESHOLDS.AUTO_NAME_SCORE
      && margin >= HEXSIG_THRESHOLDS.AUTO_NAME_MARGIN
      && (layers >= 2 || bestExactPattern)
    ) {
      verdict = HEXSIG_VERDICT.AUTO_NAME;
    } else if (bestScore >= HEXSIG_THRESHOLDS.AUTO_NAME_SCORE && margin < HEXSIG_THRESHOLDS.AUTO_NAME_MARGIN) {
      verdict = HEXSIG_VERDICT.NEED_CG_TIEBREAK;
    }

    if (verdict !== HEXSIG_VERDICT.AUTO_NAME && (qFp.l2BbCount ?? 1) <= 2 && bestSL1 >= HEXSIG_THRESHOLDS.SMALL_FUNC_L1_SCORE) {
      const neighborLibIds = opts.neighborAnchorLibIds || [];
      const sameLibNeighbors = (bestEntry.libId != null && bestEntry.libId !== 0xffff)
        ? neighborLibIds.filter((id) => id === bestEntry.libId).length
        : 0;
      if (sameLibNeighbors >= HEXSIG_THRESHOLDS.SMALL_FUNC_MIN_ANCHOR_NEIGHBORS) {
        verdict = HEXSIG_VERDICT.AUTO_NAME;
      }
    }

    return {
      engine: 'js',
      matched: verdict === HEXSIG_VERDICT.AUTO_NAME || verdict === HEXSIG_VERDICT.VENDOR_FOLD_ONLY,
      entryIndex: bestIdx,
      symbolName: bestEntry.symbolName,
      libId: bestEntry.libId,
      lib: this.getLib(bestEntry.libId),
      score1: bestScore,
      score2: secondScore,
      margin,
      verdict,
      layerMask: bestLayerMask,
      runnerUpEntry: secondIdx >= 0 ? secondIdx : 0xffffffff,
      exactPatternMatch: bestExactPattern,
    };
  }

  matchBatch(queries, opts = {}) {
    if (!Array.isArray(queries)) return [];
    const out = new Array(queries.length);
    for (let i = 0; i < queries.length; i++) {
      out[i] = this.match(queries[i], opts);
    }
    return out;
  }
}

export function createHexSigIndex(entries = [], libs = []) {
  return new HexSigIndex(entries, libs);
}
