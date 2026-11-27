/**
 * Deterministic SDK/Pack Auto-Matcher & Integer Scorer (0..1000).
 * Spec: hex_ida_beyond_ida_design.md §18.2
 * S = clamp(0, 1000, S_platform[0..250] + S_version[0..350] + S_dylib[0..300] + S_hint[0..100])
 * Thresholds: OS/runtime >= 550, OSS/engine >= 420.
 * Conflict resolution + requires DAG expansion -> Pack A / Pack B / JS LRU slot plan.
 * INV-005: ZERO imports from js/targets/architecture/.
 */

import { compareVersionStr } from './sdk-fingerprint.js';

export const MATCH_THRESHOLD = Object.freeze({
  OS_RUNTIME: 550,
  OSS_ENGINE: 420,
});

const SOURCE_PRIORITY = Object.freeze({
  'local-compiled': 3,
  official: 2,
  community: 1,
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function parseMajorVersion(verStr) {
  const m = /^(\d+)/.exec(String(verStr || '').trim());
  return m ? parseInt(m[1], 10) : null;
}

function parseMinorVersion(verStr) {
  const m = /^\d+\.(\d+)/.exec(String(verStr || '').trim());
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Scores a single TIL-Hub pack entry against a BinarySdkFingerprint (0..1000).
 */
export function scorePackAgainstFingerprint(pack, fp) {
  const rules = pack.matchRules || {};
  const packCategory = String(pack.category || 'os').toLowerCase();
  const isOssOrEngine = packCategory === 'oss' || packCategory === 'engine';

  // 1. Platform score [0..250]
  let sPlatform = 0;
  const platforms = Array.isArray(rules.platforms) ? rules.platforms : [];
  if (platforms.length === 0 || platforms.includes('any')) {
    sPlatform = isOssOrEngine ? 200 : 120;
  } else if (platforms.includes(fp.platform)) {
    sPlatform = 250;
  } else if (
    (fp.platform === 'ios-simulator' && platforms.includes('ios')) ||
    (fp.platform === 'mac-catalyst' && platforms.includes('macos'))
  ) {
    sPlatform = 220;
  } else if (!isOssOrEngine) {
    // Hard platform mismatch for OS/runtime packs
    return {
      score: 0,
      breakdown: { platform: 0, version: 0, dylib: 0, hint: 0 },
      qualified: false,
    };
  }

  // Optional libc check for runtime packs
  if (rules.libc && fp.libc && rules.libc.toLowerCase() !== fp.libc.toLowerCase()) {
    return {
      score: 0,
      breakdown: { platform: 0, version: 0, dylib: 0, hint: 0 },
      qualified: false,
    };
  }

  // 2. Version score [0..350]
  let sVersion = 0;
  const packVer = pack.sdkVersion || rules.sdkVersion || '';
  if (!packVer || isOssOrEngine) {
    sVersion = isOssOrEngine ? 150 : 175;
  } else if (fp.sdkVersion) {
    const cmp = compareVersionStr(packVer, fp.sdkVersion);
    if (cmp === 0) {
      sVersion = 350;
    } else {
      const pMaj = parseMajorVersion(packVer);
      const fMaj = parseMajorVersion(fp.sdkVersion);
      if (pMaj !== null && fMaj !== null) {
        const diff = Math.abs(pMaj - fMaj);
        if (diff === 0) {
          const mDiff = Math.abs(parseMinorVersion(packVer) - parseMinorVersion(fp.sdkVersion));
          sVersion = Math.max(260, 340 - mDiff * 15);
        } else if (packVer && cmp < 0) {
          // Slightly older SDK pack is better than a future SDK
          sVersion = Math.max(80, 300 - diff * 50);
        } else {
          sVersion = Math.max(40, 260 - diff * 65);
        }
      }
    }
  } else {
    sVersion = 150;
  }

  // 3. Dylib / DT_NEEDED match score [0..300]
  let sDylib = 0;
  const requiredDylibs = Array.isArray(rules.dylibs) ? rules.dylibs : [];
  if (requiredDylibs.length > 0 && fp.dylibs && fp.dylibs.length > 0) {
    const lowerDylibs = fp.dylibs.map((d) => d.toLowerCase());
    let hits = 0;
    for (const pat of requiredDylibs) {
      const lp = String(pat).toLowerCase();
      if (lowerDylibs.some((d) => d.includes(lp))) hits++;
    }
    sDylib = Math.round((hits / requiredDylibs.length) * 300);
  } else if (requiredDylibs.length === 0) {
    sDylib = isOssOrEngine ? 0 : 120;
  }

  // 4. Hint match score [0..100]
  let sHint = 0;
  const requiredHints = Array.isArray(rules.hints) ? rules.hints : [];
  if (requiredHints.length > 0 && fp.hints && fp.hints.length > 0) {
    const fpHintSet = new Set(fp.hints.map((h) => h.toLowerCase()));
    let hits = 0;
    for (const h of requiredHints) {
      if (fpHintSet.has(String(h).toLowerCase())) hits++;
    }
    sHint = Math.round((hits / requiredHints.length) * 100);
    // Strong hint boost for OSS/engine packs that have no dylibs (e.g. statically linked IL2CPP/Unreal/OpenSSL)
    if (isOssOrEngine && hits > 0 && requiredDylibs.length === 0) {
      sDylib = Math.round((hits / requiredHints.length) * 150);
    }
  }

  const total = clamp(sPlatform + sVersion + sDylib + sHint, 0, 1000);
  const threshold = isOssOrEngine ? MATCH_THRESHOLD.OSS_ENGINE : MATCH_THRESHOLD.OS_RUNTIME;
  return {
    score: total,
    breakdown: { platform: sPlatform, version: sVersion, dylib: sDylib, hint: sHint },
    qualified: total >= threshold,
  };
}

function compareCandidates(a, b, fpSdkVersion) {
  if (a.score !== b.score) return b.score - a.score;
  const srcA = SOURCE_PRIORITY[a.pack.source || 'official'] || 0;
  const srcB = SOURCE_PRIORITY[b.pack.source || 'official'] || 0;
  if (srcA !== srcB) return srcB - srcA;
  // Prefer highest sdkVersion <= binary sdkVersion
  if (fpSdkVersion && a.pack.sdkVersion && b.pack.sdkVersion) {
    const aLe = compareVersionStr(a.pack.sdkVersion, fpSdkVersion) <= 0;
    const bLe = compareVersionStr(b.pack.sdkVersion, fpSdkVersion) <= 0;
    if (aLe !== bLe) return aLe ? -1 : 1;
    const vCmp = compareVersionStr(b.pack.sdkVersion, a.pack.sdkVersion);
    if (vCmp !== 0) return vCmp;
  }
  const semCmp = compareVersionStr(b.pack.version || '0', a.pack.version || '0');
  if (semCmp !== 0) return semCmp;
  return String(a.pack.id).localeCompare(String(b.pack.id));
}

/**
 * Matches a BinarySdkFingerprint against a catalog of TIL-Hub packs.
 * Returns ranked matches, selected packs (conflict-free + requires expanded, max 8),
 * and a slot assignment plan (`packA`, `packB`, `jsLru`).
 */
export function matchSdkPacks(fingerprint, catalogPacks = [], { maxPacks = 8 } = {}) {
  const packById = new Map();
  for (const p of catalogPacks) {
    if (p && p.id) packById.set(p.id, p);
  }

  // Score all packs
  const scored = catalogPacks.map((pack) => {
    const res = scorePackAgainstFingerprint(pack, fingerprint);
    return { pack, ...res };
  });

  const qualified = scored
    .filter((s) => s.qualified)
    .sort((a, b) => compareCandidates(a, b, fingerprint.sdkVersion));

  // Conflict resolution & requires DAG expansion
  const selected = [];
  const selectedIds = new Set();
  const excludedIds = new Set();

  function addWithDependencies(entry, visiting = new Set()) {
    const id = entry.pack.id;
    if (selectedIds.has(id) || excludedIds.has(id) || visiting.has(id)) return;
    if (selected.length >= maxPacks) return;

    // Check conflicts with already selected packs
    const packConflicts = new Set(entry.pack.conflicts || []);
    for (const chosen of selected) {
      if (packConflicts.has(chosen.pack.id) || (chosen.pack.conflicts || []).includes(id)) {
        excludedIds.add(id);
        return;
      }
    }

    visiting.add(id);
    // Expand requires DAG first (dependencies must be present)
    for (const reqId of (entry.pack.requires || [])) {
      if (!selectedIds.has(reqId) && packById.has(reqId)) {
        const reqPack = packById.get(reqId);
        const reqScore = scored.find((s) => s.pack.id === reqId) || {
          pack: reqPack,
          score: entry.score,
          breakdown: { platform: 0, version: 0, dylib: 0, hint: 0 },
          qualified: true,
          addedViaRequires: true,
        };
        addWithDependencies(reqScore, visiting);
      }
    }
    visiting.delete(id);

    if (selected.length < maxPacks && !selectedIds.has(id)) {
      selectedIds.add(id);
      selected.push(entry);
    }
  }

  for (const cand of qualified) {
    addWithDependencies(cand);
    if (selected.length >= maxPacks) break;
  }

  // Re-sort final selected list by score descending for hot slot assignment
  const ordered = [...selected].sort((a, b) => compareCandidates(a, b, fingerprint.sdkVersion));

  return {
    fingerprintHash: fingerprint.fingerprintHash,
    allScored: scored,
    selected: ordered,
    slots: {
      packA: ordered[0]?.pack || null,
      packB: ordered[1]?.pack || null,
      jsLru: ordered.slice(2).map((s) => s.pack),
    },
  };
}
