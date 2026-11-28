/**
 * Tier-1 TIL Auto-Loader (Track 1)
 * Selects up to 2 matching TIL packs for a binary from a TIL-Hub manifest,
 * enforces platform/conflict/transitive-requires rules and safe URL resolution,
 * and mounts them into TilPackManager with TID-base reclamation and TOCTOU-safe abort rollback.
 *
 * INV-005: ZERO imports from js/targets/architecture/ or js/semantics/.
 */

import { validateManifestPayload, validateCommunityMirrorUrl } from './til-pack-manager.js';
import {
  isSafeAssetUrl,
  AUTO_ANALYSIS_STATUS,
  safeInvokeCallback,
} from '../../common/v6-auto-contracts.js';

const SCHEME_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const FRAMEWORK_SEGMENT_RE = /([^\\/]+)\.framework(?:[\\/]|$)/;

/**
 * Normalize a platform identifier into canonical TIL-Hub platform names.
 * @param {string|null|undefined} platform
 * @param {string[]} [dylibs=[]]
 * @returns {string}
 */
export function normalizePlatformName(platform, dylibs = []) {
  if (typeof platform !== 'string') return '';
  const raw = platform.trim().toLowerCase();
  if (!raw) return '';

  if (raw.includes('android')) return 'android';
  if (
    raw === 'gnu/linux' ||
    raw === 'linux-gnu' ||
    raw === 'linux' ||
    raw.startsWith('linux-') ||
    raw.endsWith('-linux')
  ) {
    return 'linux';
  }
  if (
    raw === 'ios simulator' ||
    raw === 'ios-simulator' ||
    raw === 'ios_simulator' ||
    raw === 'iphonesimulator'
  ) {
    return 'ios-simulator';
  }
  if (
    raw === 'mac catalyst' ||
    raw === 'mac-catalyst' ||
    raw === 'mac_catalyst' ||
    raw === 'maccatalyst'
  ) {
    return 'mac-catalyst';
  }
  if (raw === 'ios' || raw === 'iphoneos') return 'ios';
  if (
    raw === 'darwin' ||
    raw === 'osx' ||
    raw === 'os x' ||
    raw === 'macos' ||
    raw === 'macosx' ||
    raw === 'mac os x'
  ) {
    return 'macos';
  }
  if (
    raw === 'win32' ||
    raw === 'win64' ||
    raw === 'windows' ||
    raw === 'win' ||
    raw === 'mingw' ||
    raw === 'msvc'
  ) {
    return 'windows';
  }
  if (raw === 'apple') {
    const list = Array.isArray(dylibs) ? dylibs : [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const lower = item.toLowerCase();
      if (
        lower.includes('uikit') ||
        lower.includes('coreui') ||
        lower.includes('mobilecoreservices')
      ) {
        return 'ios';
      }
    }
    return 'macos';
  }

  return raw;
}

function normalizeArchName(arch) {
  if (typeof arch !== 'string') return '';
  const raw = arch.trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'aarch64' || raw === 'arm64e' || raw === 'arm64') return 'arm64';
  if (raw === 'x86_64' || raw === 'amd64' || raw === 'x64') return 'x64';
  return raw;
}

function buildLibEntries(dylibs, frameworks) {
  const seen = new Set();
  const entries = [];
  const sources = [
    ...(Array.isArray(dylibs) ? dylibs : []),
    ...(Array.isArray(frameworks) ? frameworks : []),
  ];

  for (const raw of sources) {
    if (typeof raw !== 'string') continue;
    const full = raw.trim().toLowerCase();
    if (!full || seen.has(full)) continue;
    seen.add(full);

    const segments = full.split(/[\\/]/).filter(Boolean);
    const basename = segments.length > 0 ? segments[segments.length - 1] : full;
    const fwMatch = full.match(FRAMEWORK_SEGMENT_RE);
    const frameworkName = fwMatch ? fwMatch[1] : '';

    entries.push({ full, basename, frameworkName });
  }
  return entries;
}

function matchesLibRule(ruleLower, libEntries) {
  for (const entry of libEntries) {
    if (
      entry.full === ruleLower ||
      entry.basename === ruleLower ||
      (entry.frameworkName && entry.frameworkName === ruleLower) ||
      entry.full.includes(ruleLower) ||
      entry.basename.includes(ruleLower)
    ) {
      return true;
    }
  }
  return false;
}

function isPlatformExcluded(pack, normPlatform) {
  if (!normPlatform) return false;
  const rulePlatforms = Array.isArray(pack?.matchRules?.platforms) ? pack.matchRules.platforms : [];
  const topPlatforms = Array.isArray(pack?.platforms) ? pack.platforms : [];
  const combined = [...rulePlatforms, ...topPlatforms]
    .filter((p) => typeof p === 'string' && p.trim() !== '')
    .map((p) => normalizePlatformName(p));

  if (combined.length === 0) return false;
  if (combined.includes('any') || combined.includes(normPlatform)) return false;
  return true;
}

function hasBidirectionalConflict(packA, packB) {
  const conflictsA = Array.isArray(packA?.conflicts) ? packA.conflicts : [];
  const conflictsB = Array.isArray(packB?.conflicts) ? packB.conflicts : [];
  return conflictsA.includes(packB.id) || conflictsB.includes(packA.id);
}

function scorePack(pack, { normPlatform, libEntries, metaHints, normLibc, normArch }) {
  let score = 0;
  let nonPlatformRuleMatched = false;

  const rules = pack?.matchRules && typeof pack.matchRules === 'object' ? pack.matchRules : null;
  if (rules) {
    if (Array.isArray(rules.dylibs) && libEntries.length > 0) {
      const uniqueRules = new Set();
      for (const item of rules.dylibs) {
        if (typeof item !== 'string') continue;
        const lower = item.trim().toLowerCase();
        if (!lower || uniqueRules.has(lower)) continue;
        uniqueRules.add(lower);
        if (matchesLibRule(lower, libEntries)) {
          score += 5;
          nonPlatformRuleMatched = true;
        }
      }
    }

    if (typeof rules.libc === 'string' && rules.libc.trim() && normLibc) {
      const ruleLibc = rules.libc.trim().toLowerCase();
      if (normLibc === ruleLibc || normLibc.includes(ruleLibc)) {
        score += 4;
        nonPlatformRuleMatched = true;
      }
    }

    if (Array.isArray(rules.hints) && metaHints.size > 0) {
      const uniqueHints = new Set();
      for (const item of rules.hints) {
        if (typeof item !== 'string') continue;
        const lower = item.trim().toLowerCase();
        if (!lower || uniqueHints.has(lower)) continue;
        uniqueHints.add(lower);
        if (metaHints.has(lower)) {
          score += 3;
          nonPlatformRuleMatched = true;
        }
      }
    }

    if (Array.isArray(rules.platforms)) {
      const normRulePlatforms = rules.platforms
        .filter((p) => typeof p === 'string' && p.trim() !== '')
        .map((p) => normalizePlatformName(p));
      if (normPlatform && normRulePlatforms.includes(normPlatform)) {
        score += 10;
      } else if (normRulePlatforms.includes('any') && nonPlatformRuleMatched) {
        score += 2;
      }
    }
  }

  // Simplified shorthand fields on pack
  if (Array.isArray(pack?.platforms) && normPlatform) {
    const normTopPlatforms = pack.platforms
      .filter((p) => typeof p === 'string' && p.trim() !== '')
      .map((p) => normalizePlatformName(p));
    if (normTopPlatforms.includes(normPlatform)) {
      score += 5;
    }
  }

  if (Array.isArray(pack?.frameworks) && libEntries.length > 0) {
    const uniqueFws = new Set();
    for (const item of pack.frameworks) {
      if (typeof item !== 'string') continue;
      const lower = item.trim().toLowerCase();
      if (!lower || uniqueFws.has(lower)) continue;
      uniqueFws.add(lower);
      if (matchesLibRule(lower, libEntries)) {
        score += 5;
      }
    }
  }

  if (Array.isArray(pack?.archs) && normArch) {
    const normPackArchs = pack.archs
      .filter((a) => typeof a === 'string' && a.trim() !== '')
      .map((a) => normalizeArchName(a));
    if (normPackArchs.includes(normArch)) {
      score += 5;
    }
  }

  return score;
}

/**
 * Select up to `maxPacks` (capped to 0..2) non-core TIL packs matching binary metadata,
 * resolving transitive `requires` closures in dependency-first order and enforcing
 * bidirectional `conflicts` and platform exclusions.
 *
 * @param {object|string|Uint8Array} manifest
 * @param {object} [binaryMeta={}]
 * @param {{ maxPacks?: number }} [opts={}]
 * @returns {object[]}
 */
export function selectTilPacksForBinary(manifest, binaryMeta = {}, { maxPacks = 2 } = {}) {
  const validated = validateManifestPayload(manifest);
  if (!validated.ok) return [];

  const n = maxPacks == null ? 2 : Number(maxPacks);
  const cap = Number.isFinite(n) ? Math.min(2, Math.max(0, Math.floor(n))) : 2;
  if (cap === 0) return [];

  const validManifest = validated.manifest;
  const allPacksById = new Map();
  for (const pack of validManifest.packs) {
    if (!allPacksById.has(pack.id)) {
      allPacksById.set(pack.id, pack);
    }
  }

  const meta = binaryMeta && typeof binaryMeta === 'object' ? binaryMeta : {};
  const libEntries = buildLibEntries(meta.dylibs, meta.frameworks);
  const combinedLibNames = libEntries.map((e) => e.full);
  const normPlatform = normalizePlatformName(meta.platform, combinedLibNames);
  const normLibc = typeof meta.libc === 'string' ? meta.libc.trim().toLowerCase() : '';
  const normArch = normalizeArchName(meta.arch);
  const metaHints = new Set();
  if (Array.isArray(meta.hints)) {
    for (const h of meta.hints) {
      if (typeof h !== 'string') continue;
      const lower = h.trim().toLowerCase();
      if (lower) metaHints.add(lower);
    }
  }

  const candidates = [];
  for (const pack of allPacksById.values()) {
    if (pack.isCore === true) continue;
    if (isPlatformExcluded(pack, normPlatform)) continue;

    const score = scorePack(pack, {
      normPlatform,
      libEntries,
      metaHints,
      normLibc,
      normArch,
    });
    if (score <= 0) continue;

    const priority = typeof pack.priority === 'number' && Number.isFinite(pack.priority)
      ? pack.priority
      : 0;
    candidates.push({ pack, priority, score });
  }

  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.score !== a.score) return b.score - a.score;
    return a.pack.id < b.pack.id ? -1 : a.pack.id > b.pack.id ? 1 : 0;
  });

  const selected = [];
  const selectedIds = new Set();

  function resolveDependencyClosure(rootPack) {
    const toAdd = [];
    const toAddIds = new Set();
    const visiting = new Set();

    function visit(pack) {
      if (selectedIds.has(pack.id) || toAddIds.has(pack.id)) return true;
      if (pack.isCore === true) return true;
      if (isPlatformExcluded(pack, normPlatform)) return false;
      if (visiting.has(pack.id)) return false;

      visiting.add(pack.id);
      const reqs = Array.isArray(pack.requires) ? pack.requires : [];
      for (const reqId of reqs) {
        if (typeof reqId !== 'string' || !reqId) {
          visiting.delete(pack.id);
          return false;
        }
        const depPack = allPacksById.get(reqId);
        if (!depPack) {
          visiting.delete(pack.id);
          return false;
        }
        if (!visit(depPack)) {
          visiting.delete(pack.id);
          return false;
        }
      }
      visiting.delete(pack.id);

      if (!selectedIds.has(pack.id) && !toAddIds.has(pack.id)) {
        toAddIds.add(pack.id);
        toAdd.push(pack);
      }
      return true;
    }

    return visit(rootPack) ? toAdd : null;
  }

  for (const { pack } of candidates) {
    if (selected.length >= cap) break;
    if (selectedIds.has(pack.id)) continue;

    const toAdd = resolveDependencyClosure(pack);
    if (!toAdd || toAdd.length === 0) continue;
    if (toAdd.length > cap - selected.length) continue;

    let conflictFound = false;
    for (let i = 0; i < toAdd.length && !conflictFound; i++) {
      for (let j = i + 1; j < toAdd.length; j++) {
        if (hasBidirectionalConflict(toAdd[i], toAdd[j])) {
          conflictFound = true;
          break;
        }
      }
      if (!conflictFound) {
        for (const existing of selected) {
          if (hasBidirectionalConflict(toAdd[i], existing)) {
            conflictFound = true;
            break;
          }
        }
      }
    }
    if (conflictFound) continue;

    for (const addPack of toAdd) {
      selected.push(addPack);
      selectedIds.add(addPack.id);
    }
  }

  return selected;
}

function deriveManifestBaseUrl(manifestUrl) {
  if (typeof manifestUrl !== 'string' || !manifestUrl) return '';
  const schemeIdx = manifestUrl.indexOf('://');
  if (schemeIdx !== -1) {
    const afterHost = manifestUrl.indexOf('/', schemeIdx + 3);
    if (afterHost === -1) return manifestUrl;
  }
  return manifestUrl.replace(/\/[^/]*$/, '');
}

/**
 * Safely resolve a TIL pack download URL and its compressed/raw SHA-256 expectations.
 *
 * @param {string} baseUrl
 * @param {object} pack
 * @param {{ isCommunityMirror?: boolean, manifestUrl?: string|null }} [opts={}]
 * @returns {{ url: string, expectedSha256: string|null, expectedRawSha256: string|null }|null}
 */
export function resolveSafePackUrl(baseUrl, pack, { isCommunityMirror = false, manifestUrl = null } = {}) {
  if (!pack || typeof pack !== 'object') return null;

  const useGz = Boolean(pack.gzFile);

  if (pack.url != null && pack.url !== '') {
    if (typeof pack.url !== 'string') return null;
    if (!isSafeAssetUrl(pack.url, { allowRelative: !isCommunityMirror })) return null;
    if (isCommunityMirror) {
      const check = validateCommunityMirrorUrl(pack.url);
      if (!check.ok) return null;
    }
    return {
      url: pack.url,
      expectedSha256: pack.gzSha256 || pack.sha256 || null,
      expectedRawSha256: pack.sha256 || null,
    };
  }

  const relFile = useGz ? pack.gzFile : pack.file;
  if (typeof relFile !== 'string' || relFile.length === 0) return null;
  if (SCHEME_PREFIX_RE.test(relFile) || relFile.startsWith('/')) return null;
  if (!isSafeAssetUrl(relFile, { allowRelative: true })) return null;

  const effectiveBase = baseUrl || (isCommunityMirror && manifestUrl ? deriveManifestBaseUrl(manifestUrl) : '');
  let resolvedUrl;
  if (effectiveBase) {
    if (typeof effectiveBase !== 'string') return null;
    if (!isSafeAssetUrl(effectiveBase, { allowRelative: !isCommunityMirror })) return null;
    resolvedUrl = effectiveBase.endsWith('/') ? `${effectiveBase}${relFile}` : `${effectiveBase}/${relFile}`;
  } else {
    resolvedUrl = relFile;
  }

  if (!isSafeAssetUrl(resolvedUrl, { allowRelative: !isCommunityMirror })) return null;
  if (isCommunityMirror) {
    const check = validateCommunityMirrorUrl(resolvedUrl);
    if (!check.ok) return null;
  }

  return {
    url: resolvedUrl,
    expectedSha256: useGz ? (pack.gzSha256 || null) : (pack.sha256 || null),
    expectedRawSha256: pack.sha256 || null,
  };
}

/**
 * Create an automatic TIL loader bound to a TilPackManager and manifest source.
 *
 * @param {object} [opts={}]
 * @returns {{ run: (params?: { binaryMeta?: object, signal?: AbortSignal|null, onProgress?: Function|null }) => Promise<object> }}
 */
export function createTilAutoLoader({
  tilPackManager,
  fetchManifest = null,
  manifestUrl = null,
  baseUrl = '',
  isCommunityMirror = false,
  maxPacks = 2,
} = {}) {
  function rollbackMounted(entries) {
    if (
      !tilPackManager ||
      typeof tilPackManager.getMountedSlots !== 'function' ||
      typeof tilPackManager.unmountSlot !== 'function'
    ) {
      return;
    }
    for (const entry of entries) {
      if (!entry || !entry.slot) continue;
      const slots = tilPackManager.getMountedSlots();
      const slotInfo = slots ? slots[entry.slot] : null;
      if (slotInfo && slotInfo.packId === entry.packId && slotInfo.lastAccess === entry.lastAccess) {
        tilPackManager.unmountSlot(entry.slot, { releaseTidBase: true });
      }
    }
  }

  async function run({ binaryMeta = {}, signal = null, onProgress = null } = {}) {
    if (signal?.aborted) {
      safeInvokeCallback(onProgress, {
        phase: 'til',
        status: AUTO_ANALYSIS_STATUS.ABORTED,
        completed: 0,
        total: 0,
        detail: 'aborted',
      });
      return {
        status: AUTO_ANALYSIS_STATUS.ABORTED,
        loadedPacks: [],
        selectedPacks: [],
        mountedSlots: [],
        errors: [],
      };
    }

    if (!tilPackManager || (!manifestUrl && typeof fetchManifest !== 'function')) {
      safeInvokeCallback(onProgress, {
        phase: 'til',
        status: AUTO_ANALYSIS_STATUS.SKIPPED,
        completed: 0,
        total: 0,
        detail: 'skipped',
      });
      return {
        status: AUTO_ANALYSIS_STATUS.SKIPPED,
        loadedPacks: [],
        selectedPacks: [],
        mountedSlots: [],
        errors: [],
      };
    }

    if (manifestUrl != null && manifestUrl !== '') {
      if (!isSafeAssetUrl(manifestUrl, { allowRelative: !isCommunityMirror })) {
        safeInvokeCallback(onProgress, {
          phase: 'til',
          status: AUTO_ANALYSIS_STATUS.OFFLINE,
          completed: 0,
          total: 0,
          detail: 'unsafe-manifest-url',
        });
        return {
          status: AUTO_ANALYSIS_STATUS.OFFLINE,
          loadedPacks: [],
          selectedPacks: [],
          mountedSlots: [],
          errors: [{ packId: 'manifest', reason: 'unsafe-manifest-url' }],
        };
      }
      if (isCommunityMirror) {
        const check = validateCommunityMirrorUrl(manifestUrl);
        if (!check.ok) {
          safeInvokeCallback(onProgress, {
            phase: 'til',
            status: AUTO_ANALYSIS_STATUS.OFFLINE,
            completed: 0,
            total: 0,
            detail: check.error,
          });
          return {
            status: AUTO_ANALYSIS_STATUS.OFFLINE,
            loadedPacks: [],
            selectedPacks: [],
            mountedSlots: [],
            errors: [{ packId: 'manifest', reason: check.error }],
          };
        }
      }
    }

    safeInvokeCallback(onProgress, {
      phase: 'til',
      status: AUTO_ANALYSIS_STATUS.RUNNING,
      completed: 0,
      total: 0,
      detail: 'fetching-manifest',
    });

    let rawManifest;
    try {
      if (typeof fetchManifest === 'function') {
        rawManifest = await fetchManifest(manifestUrl, { signal, isCommunityMirror });
      } else if (typeof tilPackManager.fetchManifest === 'function') {
        rawManifest = await tilPackManager.fetchManifest(manifestUrl, { isCommunityMirror });
      } else {
        throw new Error('No manifest fetcher available');
      }
    } catch (err) {
      if (signal?.aborted) {
        safeInvokeCallback(onProgress, {
          phase: 'til',
          status: AUTO_ANALYSIS_STATUS.ABORTED,
          completed: 0,
          total: 0,
          detail: 'aborted',
        });
        return {
          status: AUTO_ANALYSIS_STATUS.ABORTED,
          loadedPacks: [],
          selectedPacks: [],
          mountedSlots: [],
          errors: [],
        };
      }
      const reason = err?.message || 'manifest-fetch-failed';
      safeInvokeCallback(onProgress, {
        phase: 'til',
        status: AUTO_ANALYSIS_STATUS.OFFLINE,
        completed: 0,
        total: 0,
        detail: reason,
      });
      return {
        status: AUTO_ANALYSIS_STATUS.OFFLINE,
        loadedPacks: [],
        selectedPacks: [],
        mountedSlots: [],
        errors: [{ packId: 'manifest', reason }],
      };
    }

    if (signal?.aborted) {
      safeInvokeCallback(onProgress, {
        phase: 'til',
        status: AUTO_ANALYSIS_STATUS.ABORTED,
        completed: 0,
        total: 0,
        detail: 'aborted',
      });
      return {
        status: AUTO_ANALYSIS_STATUS.ABORTED,
        loadedPacks: [],
        selectedPacks: [],
        mountedSlots: [],
        errors: [],
      };
    }

    const validated = validateManifestPayload(rawManifest);
    if (!validated.ok) {
      const reason = validated.error || 'invalid-manifest';
      safeInvokeCallback(onProgress, {
        phase: 'til',
        status: AUTO_ANALYSIS_STATUS.OFFLINE,
        completed: 0,
        total: 0,
        detail: reason,
      });
      return {
        status: AUTO_ANALYSIS_STATUS.OFFLINE,
        loadedPacks: [],
        selectedPacks: [],
        mountedSlots: [],
        errors: [{ packId: 'manifest', reason }],
      };
    }

    const selected = selectTilPacksForBinary(validated.manifest, binaryMeta, { maxPacks });
    const selectedPacks = selected.map((p) => p.id);
    if (selected.length === 0) {
      safeInvokeCallback(onProgress, {
        phase: 'til',
        status: AUTO_ANALYSIS_STATUS.SKIPPED,
        completed: 0,
        total: 0,
        detail: 'no-matching-packs',
      });
      return {
        status: AUTO_ANALYSIS_STATUS.SKIPPED,
        loadedPacks: [],
        selectedPacks: [],
        mountedSlots: [],
        errors: [],
      };
    }

    safeInvokeCallback(onProgress, {
      phase: 'til',
      status: AUTO_ANALYSIS_STATUS.RUNNING,
      completed: 0,
      total: selected.length,
      detail: 'loading-packs',
    });

    const loadedPacks = [];
    const mountedSlots = [];
    const errors = [];

    for (let i = 0; i < selected.length; i++) {
      const pack = selected[i];

      if (signal?.aborted) {
        rollbackMounted(mountedSlots);
        safeInvokeCallback(onProgress, {
          phase: 'til',
          status: AUTO_ANALYSIS_STATUS.ABORTED,
          completed: i,
          total: selected.length,
          detail: 'aborted',
        });
        return {
          status: AUTO_ANALYSIS_STATUS.ABORTED,
          loadedPacks: [],
          selectedPacks,
          mountedSlots: [],
          errors,
        };
      }

      const resolved = resolveSafePackUrl(baseUrl, pack, { isCommunityMirror, manifestUrl });
      if (!resolved) {
        errors.push({ packId: pack.id, reason: 'unsafe-pack-url' });
        safeInvokeCallback(onProgress, {
          phase: 'til',
          status: AUTO_ANALYSIS_STATUS.RUNNING,
          completed: i + 1,
          total: selected.length,
          detail: pack.id,
        });
        continue;
      }

      let res;
      try {
        res = await tilPackManager.loadPackWithFallback(pack.id, {
          url: resolved.url,
          isCommunityMirror,
          expectedSha256: resolved.expectedSha256,
          expectedRawSha256: resolved.expectedRawSha256,
          meta: {
            name: pack.name || pack.id,
            version: pack.version || '',
            sdkVersion: pack.sdkVersion || '',
            category: pack.category || '',
            source: pack.source || '',
          },
        });
      } catch (err) {
        if (signal?.aborted) {
          rollbackMounted(mountedSlots);
          safeInvokeCallback(onProgress, {
            phase: 'til',
            status: AUTO_ANALYSIS_STATUS.ABORTED,
            completed: i,
            total: selected.length,
            detail: 'aborted',
          });
          return {
            status: AUTO_ANALYSIS_STATUS.ABORTED,
            loadedPacks: [],
            selectedPacks,
            mountedSlots: [],
            errors,
          };
        }
        errors.push({ packId: pack.id, reason: err?.message || 'load-pack-failed' });
        safeInvokeCallback(onProgress, {
          phase: 'til',
          status: AUTO_ANALYSIS_STATUS.RUNNING,
          completed: i + 1,
          total: selected.length,
          detail: pack.id,
        });
        continue;
      }

      // Always release evicted pack's TID base immediately, even if aborted (including cache-fallback path)
      if (res?.evictedPackId) {
        tilPackManager.releasePackTidBase?.(res.evictedPackId);
      }

      let currentMountEntry = null;
      if (res?.mounted && res?.slot) {
        let lastAccess = res.entry?.lastAccess ?? null;
        if (lastAccess == null && typeof tilPackManager.getMountedSlots === 'function') {
          const slots = tilPackManager.getMountedSlots();
          lastAccess = slots?.[res.slot]?.lastAccess ?? null;
        }
        currentMountEntry = {
          slot: res.slot,
          packId: pack.id,
          lastAccess,
          source: res.source || 'remote',
        };
      }

      if (signal?.aborted) {
        const toRollback = currentMountEntry ? [...mountedSlots, currentMountEntry] : mountedSlots;
        rollbackMounted(toRollback);
        safeInvokeCallback(onProgress, {
          phase: 'til',
          status: AUTO_ANALYSIS_STATUS.ABORTED,
          completed: i,
          total: selected.length,
          detail: 'aborted',
        });
        return {
          status: AUTO_ANALYSIS_STATUS.ABORTED,
          loadedPacks: [],
          selectedPacks,
          mountedSlots: [],
          errors,
        };
      }

      if (currentMountEntry) {
        loadedPacks.push(pack.id);
        mountedSlots.push(currentMountEntry);
      } else {
        errors.push({ packId: pack.id, reason: res?.reason || 'mount-failed' });
      }

      safeInvokeCallback(onProgress, {
        phase: 'til',
        status: AUTO_ANALYSIS_STATUS.RUNNING,
        completed: i + 1,
        total: selected.length,
        detail: pack.id,
      });
    }

    const finalStatus = loadedPacks.length > 0
      ? AUTO_ANALYSIS_STATUS.DONE
      : AUTO_ANALYSIS_STATUS.OFFLINE;

    safeInvokeCallback(onProgress, {
      phase: 'til',
      status: finalStatus,
      completed: selected.length,
      total: selected.length,
      detail: loadedPacks.length > 0 ? 'loaded' : 'offline',
    });

    return {
      status: finalStatus,
      loadedPacks,
      selectedPacks,
      mountedSlots,
      errors,
    };
  }

  return { run };
}
