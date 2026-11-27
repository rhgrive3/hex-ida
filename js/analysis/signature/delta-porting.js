// Cross-version binary diff & symbol/type delta porting engine (§11.2).
// Uses sparse inverted-index top-K candidate scoring (zero O(N*M) dense matrix OOM at 246k scale),
// canonical BigInt VA key normalization, 1:N and N:1 conflict isolation, and `data:<va>` support.
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.

import {
  encodeFingerprint64,
  decodeFingerprint64,
  scoreHexSigPair,
} from './hex-sig-extractor.js';

export const DELTA_PORT_ANCHOR_SCORE = 820;
export const DELTA_PORT_ANCHOR_MARGIN = 80;
export const DELTA_PORT_CG_NEIGHBOR_BONUS = 70;
export const DELTA_PORT_MIN_ASSIGN_SCORE = 650;
export const DELTA_PORT_TOP_K = 16;
export const DELTA_PORT_CONFLICT_MARGIN = 30;

/**
 * Canonicalize numeric, BigInt, hex string ("0x1000", "0X1000"), or decimal string ("4096")
 * into lowercase `0x...` key via BigInt.
 */
export function toVaKey(va) {
  if (typeof va === 'bigint') return `0x${va.toString(16)}`;
  if (typeof va === 'number' && Number.isFinite(va)) return `0x${BigInt(Math.trunc(va)).toString(16)}`;
  if (typeof va === 'string') {
    const trimmed = va.trim();
    if (/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) {
      return `0x${BigInt(trimmed).toString(16)}`;
    }
    return trimmed.toLowerCase();
  }
  return String(va);
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function serializeFuncFingerprints(funcs = []) {
  return funcs.map((fn) => ({
    va: toVaKey(fn.va),
    fp64_b64: bytesToBase64(encodeFingerprint64(fn.fingerprint || {})),
  }));
}

export function deserializeFuncFingerprints(records) {
  if (!Array.isArray(records)) return [];
  return records.map((rec) => ({
    va: toVaKey(rec.va),
    fingerprint: decodeFingerprint64(base64ToBytes(rec.fp64_b64)),
  }));
}

function stringJaccardBonus(oldStrings, newStrings) {
  if (!oldStrings || !newStrings || oldStrings.length === 0 || newStrings.length === 0) return 0;
  const setA = new Set(oldStrings);
  let inter = 0;
  for (const s of newStrings) {
    if (setA.has(s)) inter++;
  }
  const union = setA.size + new Set(newStrings).size - inter;
  if (union <= 0) return 0;
  return Math.round((inter / union) * 140);
}

function pairBaseScore(oldFn, newFn) {
  const scored = scoreHexSigPair(oldFn.fingerprint || {}, newFn.fingerprint || {});
  let total = scored.total;
  if (
    oldFn.patternHash64 !== undefined
    && newFn.patternHash64 !== undefined
    && oldFn.patternHash64 !== 0n
    && oldFn.patternHash64 === newFn.patternHash64
  ) {
    const crcOk = oldFn.crc16 === undefined || newFn.crc16 === undefined || oldFn.crc16 === newFn.crc16;
    total = Math.min(1000, Math.max(total, crcOk ? 860 : 720) + (crcOk ? 120 : 60));
  }
  total = Math.min(1000, total + stringJaccardBonus(oldFn.strings, newFn.strings));
  return total;
}

function buildSparseNewIndex(newFuncs) {
  const byPatternHash = new Map();
  const byString = new Map();
  const byAnchor = new Map();
  const byWl = new Map();
  const byMinHash = new Map();

  const add = (map, key, idx) => {
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    if (arr.length < 64) arr.push(idx);
  };

  for (let j = 0; j < newFuncs.length; j++) {
    const fn = newFuncs[j];
    if (fn.patternHash64 && fn.patternHash64 !== 0n) {
      add(byPatternHash, fn.patternHash64, j);
    }
    if (Array.isArray(fn.strings)) {
      for (const s of fn.strings) {
        if (s) add(byString, s, j);
      }
    }
    const fp = fn.fingerprint || {};
    if (fp.l3StrHash64 && fp.l3StrHash64 !== 0n) add(byAnchor, `s:${fp.l3StrHash64}`, j);
    if (fp.l3ConstHash64 && fp.l3ConstHash64 !== 0n) add(byAnchor, `c:${fp.l3ConstHash64}`, j);
    if (fp.l2WlHash64 && fp.l2WlHash64 !== 0n) add(byWl, fp.l2WlHash64, j);
    if (fp.l1Minhash && fp.l1Minhash.length >= 4) {
      for (let k = 0; k < 4; k++) {
        const v = fp.l1Minhash[k] >>> 0;
        if (v !== 0xffffffff) add(byMinHash, `${k}:${v}`, j);
      }
    }
  }

  return { byPatternHash, byString, byAnchor, byWl, byMinHash };
}

function collectSparseCandidates(oldFn, newFuncs, idx, topK) {
  const candSet = new Set();
  const collect = (arr) => {
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) candSet.add(arr[i]);
  };

  if (oldFn.patternHash64 && oldFn.patternHash64 !== 0n) {
    collect(idx.byPatternHash.get(oldFn.patternHash64));
  }
  if (Array.isArray(oldFn.strings)) {
    for (const s of oldFn.strings) collect(idx.byString.get(s));
  }
  const fp = oldFn.fingerprint || {};
  if (fp.l3StrHash64 && fp.l3StrHash64 !== 0n) collect(idx.byAnchor.get(`s:${fp.l3StrHash64}`));
  if (fp.l3ConstHash64 && fp.l3ConstHash64 !== 0n) collect(idx.byAnchor.get(`c:${fp.l3ConstHash64}`));
  if (fp.l2WlHash64 && fp.l2WlHash64 !== 0n) collect(idx.byWl.get(fp.l2WlHash64));
  if (fp.l1Minhash && fp.l1Minhash.length >= 4) {
    for (let k = 0; k < 4; k++) {
      const v = fp.l1Minhash[k] >>> 0;
      if (v !== 0xffffffff) collect(idx.byMinHash.get(`${k}:${v}`));
    }
  }

  // Small-binary fallback only when newFuncs <= 128 and inverted index returned nothing
  if (candSet.size === 0 && newFuncs.length <= 128) {
    for (let j = 0; j < newFuncs.length; j++) candSet.add(j);
  }

  const scored = [];
  for (const j of candSet) {
    const s = pairBaseScore(oldFn, newFuncs[j]);
    if (s > 0) scored.push({ newIdx: j, score: s, cgBoosted: false });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Sparse cross-version function matching (§11.2):
 *  (1) High-confidence anchors (score >= 820, margin >= 80)
 *  (2) Callgraph 1-hop Caller/Callee neighborhood propagation (+70 bonus)
 *  (3) 1:N & N:1 ambiguity isolation into `pendingConflicts` + global 1:1 greedy assignment
 */
export function matchFunctionsCrossVersion(oldFuncs = [], newFuncs = [], opts = {}) {
  const anchorScoreMin = opts.anchorScoreMin ?? DELTA_PORT_ANCHOR_SCORE;
  const anchorMarginMin = opts.anchorMarginMin ?? DELTA_PORT_ANCHOR_MARGIN;
  const cgBonus = opts.cgNeighborBonus ?? DELTA_PORT_CG_NEIGHBOR_BONUS;
  const minAssignScore = opts.minAssignScore ?? DELTA_PORT_MIN_ASSIGN_SCORE;
  const topK = opts.topK ?? DELTA_PORT_TOP_K;

  const oldByKey = new Map();
  const newByKey = new Map();
  oldFuncs.forEach((f, i) => oldByKey.set(toVaKey(f.va), i));
  newFuncs.forEach((f, i) => newByKey.set(toVaKey(f.va), i));

  // Build sparse inverted index over newFuncs (O(M) memory — safe for 246k+ functions)
  const sparseIdx = buildSparseNewIndex(newFuncs);
  const sparseCands = oldFuncs.map((fn) => collectSparseCandidates(fn, newFuncs, sparseIdx, topK));

  const matchedOld = new Set();
  const matchedNew = new Set();
  const matches = [];
  const pendingConflicts = [];

  // Phase 1: Confirm high-confidence anchors
  const anchorCandidates = [];
  for (let i = 0; i < oldFuncs.length; i++) {
    const row = sparseCands[i];
    if (row.length === 0) continue;
    const best = row[0];
    const secondScore = row.length > 1 ? row[1].score : 0;
    const margin = Math.max(0, best.score - secondScore);
    if (best.score >= anchorScoreMin && margin >= anchorMarginMin) {
      anchorCandidates.push({ oldIdx: i, newIdx: best.newIdx, score: best.score, margin });
    }
  }

  // Check N:1 collisions among anchors before confirming
  const anchorByNew = new Map();
  for (const cand of anchorCandidates) {
    if (!anchorByNew.has(cand.newIdx)) anchorByNew.set(cand.newIdx, []);
    anchorByNew.get(cand.newIdx).push(cand);
  }
  const nTo1BlockedOld = new Set();
  const nTo1BlockedNew = new Set();
  for (const [newIdx, list] of anchorByNew.entries()) {
    if (list.length > 1) {
      list.sort((a, b) => b.score - a.score);
      if (list[0].score - list[1].score < DELTA_PORT_CONFLICT_MARGIN) {
        nTo1BlockedNew.add(newIdx);
        for (const c of list) nTo1BlockedOld.add(c.oldIdx);
        pendingConflicts.push({
          newVa: toVaKey(newFuncs[newIdx].va),
          candidates: list.slice(0, 4).map((c) => ({
            oldVa: toVaKey(oldFuncs[c.oldIdx].va),
            score: c.score,
          })),
          reason: 'ambiguous_n_to_1',
        });
      }
    }
  }

  anchorCandidates.sort((a, b) => (b.score - a.score) || (b.margin - a.margin));
  for (const cand of anchorCandidates) {
    if (nTo1BlockedOld.has(cand.oldIdx) || nTo1BlockedNew.has(cand.newIdx)) continue;
    if (matchedOld.has(cand.oldIdx) || matchedNew.has(cand.newIdx)) continue;
    matchedOld.add(cand.oldIdx);
    matchedNew.add(cand.newIdx);
    matches.push({
      oldVa: toVaKey(oldFuncs[cand.oldIdx].va),
      newVa: toVaKey(newFuncs[cand.newIdx].va),
      score: cand.score,
      margin: cand.margin,
      confidence: Math.min(1, Number((cand.score / 1000).toFixed(3))),
      matchReason: 'anchor',
    });
  }

  // Phase 2: Callgraph 1-hop Caller/Callee neighborhood propagation (+70 bonus) on sparse candidate map
  const sparseMaps = sparseCands.map((row) => {
    const m = new Map();
    for (const c of row) m.set(c.newIdx, { ...c });
    return m;
  });

  for (const m of matches) {
    const oi = oldByKey.get(m.oldVa);
    const nj = newByKey.get(m.newVa);
    const oldFn = oldFuncs[oi];
    const newFn = newFuncs[nj];

    const oldNeighbors = [
      ...(oldFn.callers || []).map((v) => ({ va: toVaKey(v), dir: 'caller' })),
      ...(oldFn.callees || []).map((v) => ({ va: toVaKey(v), dir: 'callee' })),
    ];
    const newNeighbors = [
      ...(newFn.callers || []).map((v) => ({ va: toVaKey(v), dir: 'caller' })),
      ...(newFn.callees || []).map((v) => ({ va: toVaKey(v), dir: 'callee' })),
    ];

    for (const on of oldNeighbors) {
      const nOi = oldByKey.get(on.va);
      if (nOi === undefined || matchedOld.has(nOi) || nTo1BlockedOld.has(nOi)) continue;
      for (const nn of newNeighbors) {
        if (on.dir !== nn.dir) continue;
        const nNj = newByKey.get(nn.va);
        if (nNj === undefined || matchedNew.has(nNj) || nTo1BlockedNew.has(nNj)) continue;
        let rec = sparseMaps[nOi].get(nNj);
        if (!rec) {
          const base = pairBaseScore(oldFuncs[nOi], newFuncs[nNj]);
          rec = { newIdx: nNj, score: base, cgBoosted: false };
          sparseMaps[nOi].set(nNj, rec);
        }
        rec.score = Math.min(1000, rec.score + cgBonus);
        rec.cgBoosted = true;
      }
    }
  }

  // Phase 3: Detect 1:N & N:1 conflicts, then global 1:1 greedy assignment
  const remainingCandidates = [];
  for (let i = 0; i < oldFuncs.length; i++) {
    if (matchedOld.has(i) || nTo1BlockedOld.has(i)) continue;
    const rowScores = [...sparseMaps[i].values()]
      .filter((c) => !matchedNew.has(c.newIdx) && !nTo1BlockedNew.has(c.newIdx) && c.score >= minAssignScore)
      .sort((a, b) => b.score - a.score);
    if (rowScores.length === 0) continue;

    const best = rowScores[0];
    const second = rowScores[1] || { score: 0 };
    const margin = Math.max(0, best.score - second.score);

    if (rowScores.length > 1 && margin < DELTA_PORT_CONFLICT_MARGIN) {
      pendingConflicts.push({
        oldVa: toVaKey(oldFuncs[i].va),
        candidates: rowScores.slice(0, 4).map((c) => ({
          newVa: toVaKey(newFuncs[c.newIdx].va),
          score: c.score,
        })),
        reason: 'ambiguous_1_to_n',
      });
      continue;
    }

    remainingCandidates.push({
      oldIdx: i,
      newIdx: best.newIdx,
      score: best.score,
      margin,
      cgBoosted: best.cgBoosted,
    });
  }

  // N:1 conflict isolation among remaining candidates
  const remByNew = new Map();
  for (const c of remainingCandidates) {
    if (!remByNew.has(c.newIdx)) remByNew.set(c.newIdx, []);
    remByNew.get(c.newIdx).push(c);
  }
  const remNTo1BlockedNew = new Set();
  const remNTo1BlockedOld = new Set();
  for (const [newIdx, list] of remByNew.entries()) {
    if (list.length > 1) {
      list.sort((a, b) => b.score - a.score);
      if (list[0].score - list[1].score < DELTA_PORT_CONFLICT_MARGIN) {
        remNTo1BlockedNew.add(newIdx);
        for (const c of list) remNTo1BlockedOld.add(c.oldIdx);
        pendingConflicts.push({
          newVa: toVaKey(newFuncs[newIdx].va),
          candidates: list.slice(0, 4).map((c) => ({
            oldVa: toVaKey(oldFuncs[c.oldIdx].va),
            score: c.score,
          })),
          reason: 'ambiguous_n_to_1',
        });
      }
    }
  }

  remainingCandidates.sort((a, b) => (b.score - a.score) || (b.margin - a.margin));
  for (const cand of remainingCandidates) {
    if (remNTo1BlockedOld.has(cand.oldIdx) || remNTo1BlockedNew.has(cand.newIdx)) continue;
    if (matchedOld.has(cand.oldIdx) || matchedNew.has(cand.newIdx)) continue;
    matchedOld.add(cand.oldIdx);
    matchedNew.add(cand.newIdx);
    matches.push({
      oldVa: toVaKey(oldFuncs[cand.oldIdx].va),
      newVa: toVaKey(newFuncs[cand.newIdx].va),
      score: cand.score,
      margin: cand.margin,
      confidence: Math.min(1, Number((cand.score / 1000).toFixed(3))),
      matchReason: cand.cgBoosted ? 'callgraph_propagated' : 'structural_match',
    });
  }

  return {
    matches,
    pendingConflicts,
    unmatchedOld: oldFuncs.filter((_, i) => !matchedOld.has(i)).map((f) => toVaKey(f.va)),
    unmatchedNew: newFuncs.filter((_, j) => !matchedNew.has(j)).map((f) => toVaKey(f.va)),
  };
}

/**
 * Port user annotations (`names`, `comments`, `vars`, `types`, `structs`, including `fn:<va>:<slot>` and `data:<va>`).
 */
export function portDeltaAnnotations(oldDelta = {}, oldFuncs = [], newFuncs = [], opts = {}) {
  const diff = matchFunctionsCrossVersion(oldFuncs, newFuncs, opts);
  const vaMap = new Map();
  for (const m of diff.matches) {
    vaMap.set(m.oldVa, m);
  }
  // Optional global/data VA mapping table (`opts.dataVaMap`: Map<oldVa, newVa> | Record)
  const dataVaMap = new Map();
  if (opts.dataVaMap instanceof Map) {
    for (const [k, v] of opts.dataVaMap.entries()) dataVaMap.set(toVaKey(k), toVaKey(v));
  } else if (opts.dataVaMap && typeof opts.dataVaMap === 'object') {
    for (const [k, v] of Object.entries(opts.dataVaMap)) dataVaMap.set(toVaKey(k), toVaKey(v));
  }

  const ported = {
    names: {},
    comments: {},
    vars: {},
    types: {},
    structs: Array.isArray(oldDelta.structs) ? structuredClone(oldDelta.structs) : [],
    confidenceByVa: {},
    portedCount: 0,
    skippedCount: 0,
  };

  function portRecord(srcMap, dstMap) {
    if (!srcMap || typeof srcMap !== 'object') return;
    for (const [key, value] of Object.entries(srcMap)) {
      const fnSlotMatch = /^fn:([^:]+):(.+)$/.exec(key);
      if (fnSlotMatch) {
        const oldVa = toVaKey(fnSlotMatch[1]);
        const slot = fnSlotMatch[2];
        const m = vaMap.get(oldVa);
        if (m) {
          dstMap[`fn:${m.newVa}:${slot}`] = value;
          ported.confidenceByVa[m.newVa] = m.confidence;
          ported.portedCount++;
        } else {
          ported.skippedCount++;
        }
        continue;
      }

      const dataMatch = /^data:([^:]+)$/.exec(key);
      if (dataMatch) {
        const oldDataVa = toVaKey(dataMatch[1]);
        const newDataVa = dataVaMap.get(oldDataVa);
        if (newDataVa) {
          dstMap[`data:${newDataVa}`] = value;
          ported.portedCount++;
        } else {
          ported.skippedCount++;
        }
        continue;
      }

      const normVa = toVaKey(key);
      const m = vaMap.get(normVa);
      if (m) {
        dstMap[m.newVa] = value;
        ported.confidenceByVa[m.newVa] = m.confidence;
        ported.portedCount++;
      } else {
        ported.skippedCount++;
      }
    }
  }

  portRecord(oldDelta.names, ported.names);
  portRecord(oldDelta.comments, ported.comments);
  portRecord(oldDelta.vars, ported.vars);
  portRecord(oldDelta.types, ported.types);

  return {
    ported,
    matches: diff.matches,
    pendingConflicts: diff.pendingConflicts,
    unmatchedOld: diff.unmatchedOld,
    unmatchedNew: diff.unmatchedNew,
  };
}
