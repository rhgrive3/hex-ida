// Background CFF/MBA/STL auto-analysis queue (Track 3).
// INV-005: ZERO imports from js/targets/architecture/, js/targets/abi/, or js/semantics/.

import {
  AUTO_ANALYSIS_STATUS,
  normalizeVaHex,
  safeInvokeCallback,
  toSafeByteSize,
} from '../common/v6-auto-contracts.js';

const DEFAULT_MAX_BUDGET_MS = 1200;
const DEFAULT_MAX_FUNCTIONS = 64;
const DEFAULT_MAX_MEMORY_BYTES = 16 * 1024 * 1024;
const MAX_PRIORITY_SCORE = 1000;

const HIGH_PRIORITY_TAGS = new Set([
  'obfuscated',
  'cff',
  'mba',
  'crypto',
  'high_entropy',
]);

const MANGLED_NAME_RE = /^(?:_?_Z|\?|_?\$[sS]|_?R)/;

function normalizeNonNegativeLimit(value, fallback) {
  if (value == null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return num;
}

function extractFiniteNonNegativeBytes(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) return null;
    return toSafeByteSize(value, Number.MAX_SAFE_INTEGER);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return null;
}

function safeNow(nowFn) {
  if (typeof nowFn !== 'function') return Date.now();
  try {
    const t = Number(nowFn());
    return Number.isFinite(t) ? t : Date.now();
  } catch {
    return Date.now();
  }
}

function hasHighPriorityTag(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return false;
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (typeof tag === 'string' && HIGH_PRIORITY_TAGS.has(tag.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

function isCxxOrMangled(candidate) {
  if (candidate.isCxx === true) return true;
  const rawName = typeof candidate.name === 'string'
    ? candidate.name.trim()
    : (typeof candidate.rawName === 'string' ? candidate.rawName.trim() : '');
  return rawName.length > 0 && MANGLED_NAME_RE.test(rawName);
}

function computeCandidatePriorityScore(candidate) {
  let score = 0;
  if (candidate.isEntry === true || candidate.isEntrypoint === true) score += 40;
  if (hasHighPriorityTag(candidate.tags)) score += 30;
  if (typeof candidate.blockCount === 'number' && Number.isFinite(candidate.blockCount) && candidate.blockCount >= 16) {
    score += 20;
  }
  if (toSafeByteSize(candidate.size, 0) >= 512) score += 15;
  if (typeof candidate.jumpTableCount === 'number' && Number.isFinite(candidate.jumpTableCount) && candidate.jumpTableCount > 0) {
    score += 10;
  }
  if (isCxxOrMangled(candidate)) score += 10;
  if (typeof candidate.priorityScore === 'number' && Number.isFinite(candidate.priorityScore)) {
    score += candidate.priorityScore;
  }
  return Math.min(MAX_PRIORITY_SCORE, Math.max(0, score));
}

function estimateCandidateMemoryBytes(candidate, input, estimateMemoryBytes) {
  if (typeof estimateMemoryBytes === 'function') {
    try {
      const est = extractFiniteNonNegativeBytes(estimateMemoryBytes(candidate, input));
      if (est !== null) return est;
    } catch {
      // Fall through to input/candidate/heuristic estimation.
    }
  }

  const fromInput = extractFiniteNonNegativeBytes(input?.estimatedBytes);
  if (fromInput !== null) return fromInput;

  const fromCandidate = extractFiniteNonNegativeBytes(candidate?.estimatedBytes);
  if (fromCandidate !== null) return fromCandidate;

  const blockCount = Array.isArray(input?.cfg?.blocks)
    ? input.cfg.blocks.length
    : (typeof candidate?.blockCount === 'number' && Number.isFinite(candidate.blockCount) && candidate.blockCount > 0
      ? Math.floor(candidate.blockCount)
      : 0);
  const mbaCount = Array.isArray(input?.mbaNodes) ? input.mbaNodes.length : 0;
  const stlBytes = input?.stlInput && typeof input.stlInput === 'object' ? 1024 : 0;
  const funcSize = toSafeByteSize(candidate?.size, 0);
  return Math.max(1024, blockCount * 1024 + mbaCount * 512 + funcSize * 4 + stlBytes);
}

/**
 * Score, deduplicate, and deterministically rank candidate functions for background deobfuscation / STL analysis.
 * @param {Array<object>} [candidates=[]]
 * @param {{ maxFunctions?: number }} [opts={}]
 * @returns {Array<object>}
 */
export function prioritizeDeobfCandidates(candidates = [], { maxFunctions = DEFAULT_MAX_FUNCTIONS } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const cap = Math.floor(normalizeNonNegativeLimit(maxFunctions, DEFAULT_MAX_FUNCTIONS));
  if (cap <= 0) return [];

  const mergeUniqueStrings = (a, b) => {
    const out = [];
    const seen = new Set();
    for (const list of [a, b]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item == null || seen.has(item)) continue;
        seen.add(item);
        out.push(item);
      }
    }
    return out;
  };
  const deduped = new Map();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c || typeof c !== 'object') continue;
    const vaHex = normalizeVaHex(c.vaHex ?? c.funcVa ?? c.va ?? c.addr ?? c.address);
    if (!vaHex) continue;
    const priorityScore = computeCandidatePriorityScore(c);
    const existing = deduped.get(vaHex);
    if (!existing) {
      deduped.set(vaHex, {
        ...c,
        vaHex,
        priorityScore,
        ...(Array.isArray(c.tags) ? { tags: mergeUniqueStrings(c.tags) } : {}),
        ...(Array.isArray(c.reasons) ? { reasons: mergeUniqueStrings(c.reasons) } : {}),
      });
    } else {
      const winner = priorityScore > existing.priorityScore ? c : existing;
      const loser = priorityScore > existing.priorityScore ? existing : c;
      const mergedTags = (Array.isArray(existing.tags) || Array.isArray(c.tags))
        ? mergeUniqueStrings(winner.tags, loser.tags)
        : undefined;
      const mergedReasons = (Array.isArray(existing.reasons) || Array.isArray(c.reasons))
        ? mergeUniqueStrings(winner.reasons, loser.reasons)
        : undefined;
      deduped.set(vaHex, {
        ...winner,
        vaHex,
        priorityScore: Math.max(existing.priorityScore, priorityScore),
        ...(mergedTags !== undefined ? { tags: mergedTags } : {}),
        ...(mergedReasons !== undefined ? { reasons: mergedReasons } : {}),
      });
    }
  }

  const ranked = [...deduped.values()];
  ranked.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    const aVa = BigInt(a.vaHex);
    const bVa = BigInt(b.vaHex);
    if (aVa < bVa) return -1;
    if (aVa > bVa) return 1;
    return 0;
  });

  return ranked.slice(0, cap);
}

/**
 * Create a budgeted, generation-aware background queue for CFF/MBA deobfuscation and STL pattern recognition.
 * @param {object} [opts={}]
 * @returns {{ run: (params?: object) => Promise<{ status: string, processed: number, deobfHits: number, stlHits: number, skipped: number, errors: Array<object> }> }}
 */
export function createAutoAnalysisQueue({
  runDeobfuscationPass = null,
  recognizeStlPattern = null,
  maxBudgetMs = DEFAULT_MAX_BUDGET_MS,
  maxFunctions = DEFAULT_MAX_FUNCTIONS,
  maxMemoryBytes = DEFAULT_MAX_MEMORY_BYTES,
  estimateMemoryBytes = null,
  yieldFn = null,
  nowFn = () => Date.now(),
} = {}) {
  const safeMaxBudgetMs = normalizeNonNegativeLimit(maxBudgetMs, DEFAULT_MAX_BUDGET_MS);
  const safeMaxFunctions = Math.floor(normalizeNonNegativeLimit(maxFunctions, DEFAULT_MAX_FUNCTIONS));
  const safeMaxMemoryBytes = Math.floor(normalizeNonNegativeLimit(maxMemoryBytes, DEFAULT_MAX_MEMORY_BYTES));

  const hasDeobfRunner = typeof runDeobfuscationPass === 'function';
  const hasStlRunner = typeof recognizeStlPattern === 'function';

  async function doYield() {
    if (typeof yieldFn === 'function') {
      try {
        await yieldFn();
      } catch {
        // Isolate yield errors so queue progression remains safe.
      }
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 0);
      timer.unref?.();
    });
  }

  async function run({
    candidates = [],
    loadCandidateInput = null,
    signal = null,
    generation = 0,
    getCurrentGeneration = () => generation,
    onResult = null,
    onProgress = null,
  } = {}) {
    const errors = [];
    let processed = 0;
    let deobfHits = 0;
    let stlHits = 0;
    let skipped = 0;

    function isAborted() {
      return Boolean(signal?.aborted);
    }

    function isStale() {
      if (typeof getCurrentGeneration !== 'function') return false;
      try {
        return getCurrentGeneration() !== generation;
      } catch {
        return true;
      }
    }

    function finish(status, completed, total, detail = undefined) {
      const payload = detail !== undefined
        ? { phase: 'deobf', status, completed, total, detail }
        : { phase: 'deobf', status, completed, total };
      safeInvokeCallback(onProgress, payload);
      return { status, processed, deobfHits, stlHits, skipped, errors };
    }

    if (isAborted()) {
      return finish(AUTO_ANALYSIS_STATUS.ABORTED, 0, 0);
    }
    if (isStale()) {
      return finish(AUTO_ANALYSIS_STATUS.STALE, 0, 0);
    }
    if (!hasDeobfRunner && !hasStlRunner) {
      return finish(AUTO_ANALYSIS_STATUS.SKIPPED, 0, 0, 'no_analyzers');
    }

    const queue = prioritizeDeobfCandidates(candidates, { maxFunctions: safeMaxFunctions });
    const total = queue.length;
    if (total === 0) {
      return finish(AUTO_ANALYSIS_STATUS.SKIPPED, 0, 0, 'no_candidates');
    }

    const startMs = safeNow(nowFn);
    let usedMemoryBytes = 0;

    safeInvokeCallback(onProgress, {
      phase: 'deobf',
      status: AUTO_ANALYSIS_STATUS.RUNNING,
      completed: 0,
      total,
    });

    for (let i = 0; i < total; i++) {
      if (isAborted()) {
        return finish(AUTO_ANALYSIS_STATUS.ABORTED, i, total);
      }
      if (isStale()) {
        return finish(AUTO_ANALYSIS_STATUS.STALE, i, total);
      }
      const elapsedBefore = Math.max(0, safeNow(nowFn) - startMs);
      if (elapsedBefore >= safeMaxBudgetMs) {
        return finish(AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED, i, total);
      }

      const candidate = queue[i];
      let input = candidate;

      if (typeof loadCandidateInput === 'function') {
        try {
          input = await loadCandidateInput(candidate, { signal, generation });
        } catch (err) {
          errors.push({
            vaHex: candidate.vaHex,
            stage: 'load',
            reason: err?.message || String(err),
          });
          skipped++;
          safeInvokeCallback(onProgress, {
            phase: 'deobf',
            status: AUTO_ANALYSIS_STATUS.RUNNING,
            completed: i + 1,
            total,
          });
          if (i + 1 < total) await doYield();
          continue;
        }
      }

      if (isAborted()) {
        return finish(AUTO_ANALYSIS_STATUS.ABORTED, i, total);
      }
      if (isStale()) {
        return finish(AUTO_ANALYSIS_STATUS.STALE, i, total);
      }
      const elapsedAfterLoad = Math.max(0, safeNow(nowFn) - startMs);
      if (elapsedAfterLoad >= safeMaxBudgetMs) {
        return finish(AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED, i, total);
      }

      const hasDeobfInput = Boolean(
        (input?.cfg && typeof input.cfg === 'object') ||
        (Array.isArray(input?.mbaNodes) && input.mbaNodes.length > 0),
      );
      const hasStlInput = Boolean(input?.stlInput && typeof input.stlInput === 'object');

      const canRunDeobf = hasDeobfRunner && hasDeobfInput;
      const canRunStl = hasStlRunner && hasStlInput;

      if (!canRunDeobf && !canRunStl) {
        skipped++;
        safeInvokeCallback(onProgress, {
          phase: 'deobf',
          status: AUTO_ANALYSIS_STATUS.RUNNING,
          completed: i + 1,
          total,
        });
        if (i + 1 < total) await doYield();
        continue;
      }

      const itemBytes = estimateCandidateMemoryBytes(candidate, input, estimateMemoryBytes);
      if (usedMemoryBytes + itemBytes > safeMaxMemoryBytes) {
        return finish(AUTO_ANALYSIS_STATUS.MEMORY_LIMIT, i, total);
      }
      usedMemoryBytes += itemBytes;

      let deobf = null;
      let stl = null;

      if (canRunDeobf) {
        try {
          const baseOpts = input?.deobfOpts && typeof input.deobfOpts === 'object' ? input.deobfOpts : {};
          deobf = await runDeobfuscationPass({
            funcVa: candidate.vaHex,
            cfg: input?.cfg && typeof input.cfg === 'object' ? input.cfg : null,
            mbaNodes: Array.isArray(input?.mbaNodes) && input.mbaNodes.length > 0 ? input.mbaNodes : null,
            opts: { ...baseOpts, commit: false, signal },
            commit: false,
            signal,
          });
        } catch (err) {
          errors.push({
            vaHex: candidate.vaHex,
            stage: 'deobf',
            reason: err?.message || String(err),
          });
        }

        if (isAborted()) {
          return finish(AUTO_ANALYSIS_STATUS.ABORTED, i, total);
        }
        if (isStale()) {
          return finish(AUTO_ANALYSIS_STATUS.STALE, i, total);
        }
      }

      if (canRunStl) {
        try {
          stl = await recognizeStlPattern({
            ...input.stlInput,
            funcVa: candidate.vaHex,
            commit: false,
            signal,
          });
        } catch (err) {
          errors.push({
            vaHex: candidate.vaHex,
            stage: 'stl',
            reason: err?.message || String(err),
          });
        }

        if (isAborted()) {
          return finish(AUTO_ANALYSIS_STATUS.ABORTED, i, total);
        }
        if (isStale()) {
          return finish(AUTO_ANALYSIS_STATUS.STALE, i, total);
        }
      }

      const deobfHit = Boolean(
        deobf?.cffRecovered ||
        (deobf?.mba?.simplifiedCount > 0) ||
        (deobf?.overlayCount > 0) ||
        (deobf?.pendingAnnotations?.length > 0),
      );
      const stlHit = Boolean(stl && stl.recognized === true);

      if (deobf != null || stl != null) {
        processed++;
        if (deobfHit) deobfHits++;
        if (stlHit) stlHits++;
        safeInvokeCallback(onResult, {
          vaHex: candidate.vaHex,
          candidate,
          deobf,
          stl,
          deobfHit,
          stlHit,
          generation,
        });
      } else {
        skipped++;
      }

      safeInvokeCallback(onProgress, {
        phase: 'deobf',
        status: AUTO_ANALYSIS_STATUS.RUNNING,
        completed: i + 1,
        total,
      });

      if (i + 1 < total) {
        await doYield();
      }
    }

    if (isAborted()) {
      return finish(AUTO_ANALYSIS_STATUS.ABORTED, total, total);
    }
    if (isStale()) {
      return finish(AUTO_ANALYSIS_STATUS.STALE, total, total);
    }

    return finish(AUTO_ANALYSIS_STATUS.DONE, total, total);
  }

  return { run };
}
