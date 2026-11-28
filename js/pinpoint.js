/*
 * Audited facade over the preserved implementation.
 *
 * The legacy engine already narrows exact/literal-name queries before
 * verification. Its verification loop accidentally reset the Bayesian prior
 * to the full field universe. Re-fuse the final evidence using the same
 * narrowed candidate set so additional verified evidence cannot reduce
 * confidence merely because a round ran. See issue #274.
 *
 * Automatic analysis also arrives here with a whole-program value-shape index.
 * The legacy pinpoint stages used to call fieldAccess repeatedly per goal even
 * though that worker API can inspect many offsets in one pass. The facade now
 * turns those calls into one superset scan, caches the complete groups, and
 * serves each legacy request from that cache. Requested size filtering is
 * applied after the scan, so batching does not relax the caller's contract.
 */
import {
  pinpointField as legacyPinpointField,
  pinpointFunction as legacyPinpointFunction,
  pinpointLocation as legacyPinpointLocation,
  groupSites,
} from './pinpoint-legacy.js';
import { fuse, decide, explain, starsOf, verdictRank, VERDICT } from './evidence.js';
import { withCxxSemanticPreference } from './analysis/query/cxx-semantic-preference.js';

export * from './pinpoint-legacy.js';

export const DEFAULT_PER_FUNCTION_BUDGET_MS = 1500;
export const PER_FUNCTION_BUDGET_EXCEEDED_REASON = 'per-function-budget-exceeded';
const DEFAULT_PINPOINT_ANALYSIS_TIMEOUT_MS = DEFAULT_PER_FUNCTION_BUDGET_MS;
const MAX_PINPOINT_ANALYSIS_TIMEOUT_MS = 120_000;
const DEFAULT_ACCESS_SCAN_TIMEOUT_MS = 45_000;
const MAX_ACCESS_SCAN_TIMEOUT_MS = 120_000;
const DEFAULT_AUTO_UNIQUE_ANALYSES = 48;
const MAX_AUTO_UNIQUE_ANALYSES = 256;
const ANALYZE_CACHE_MAX_ENTRIES = 512;
const ANALYZE_CACHE_ALLOWED_OPT_KEYS = new Set(['signal', 'perFunctionBudgetMs']);
const ANALYZE_GUARDS = new WeakMap();
const ACCESS_BATCHES = new WeakMap();

function isObjectKey(value) {
  return value != null && (typeof value === 'object' || typeof value === 'function');
}

function burstScopedState(registry, callback, opts, createState) {
  let entry = registry.get(callback);
  if (!entry) {
    entry = { shared: null, bursts: new WeakMap() };
    registry.set(callback, entry);
  }
  const burst = opts?.shapes;
  if (isObjectKey(burst)) {
    let state = entry.bursts.get(burst);
    if (!state) {
      state = createState();
      entry.bursts.set(burst, state);
    }
    return state;
  }
  if (!entry.shared) entry.shared = createState();
  return entry.shared;
}

/*
 * 測定（confidence replay / oracle harness）と production が同じ prior 計算を
 * 共有するための export。measurement 側へ複製を作らない。
 */
export function narrowedPriorCount(candidates, universe) {
  if (!candidates.length) return Math.max(1, universe || 1);
  /*
   * 名前がまるごと一致した枠があるなら、事前オッズはその数で据え置く。
   * 候補集合の後ろに bounded な recall lane（語並び・語彙の一致）が足されても、
   * 完全一致クエリの確率を不当に下げないため。
   */
  const exact = candidates.filter((c) => c && c.askedByName);
  if (exact.length) return exact.length;
  const primary = candidates.filter((c) => c && !c.recallLane);
  const literal = primary.filter((c) => c.askedBySequence || c.askedByWords);
  if (literal.length && literal.length === primary.length) return literal.length;
  return Math.max(1, universe || candidates.length);
}

/*
 * 完全一致の枠（askedByName）は、candidate narrowing が後ろへ足した
 * 語並び・語彙の recall lane より必ず先に並ぶ。recall lane が完全一致を
 * 押しのけると、名前で探した人へ名前の違う値を返す元の不具合に戻るため。
 * recall lane が無い通常のクエリでは、従来どおり fusion だけで並ぶ。
 *
 * oracle replay も production と同じこの比較子を使う（export して共有）。
 */
export function byRecallLane(a, b) {
  return ((a.recallLane ? 1 : 0) - (b.recallLane ? 1 : 0))
    || (b.fusion.logOdds - a.fusion.logOdds)
    || ((b.fusion.rawLogOdds ?? b.fusion.logOdds) - (a.fusion.rawLogOdds ?? a.fusion.logOdds))
    || (a.source === 'cxx' || b.source === 'cxx'
      ? Number(a.source === 'cxx') - Number(b.source === 'cxx') || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      : 0);
}

/**
 * Deterministic <=255 shortlist for external Jev assistance.
 * Takes the candidates array (budget up to 400), preserves existing Hex score
 * order with stable tiebreak on candidate key/id/address, and bounds to max (<=255).
 * The full candidate lattice is NOT pruned; only the Jev request uses the shortlist.
 */
export function jevShortlist(candidates, opts = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const max = Math.max(1, Math.min(255, Number.isSafeInteger(opts?.max) ? opts.max : 64));
  return candidates.slice().sort((a, b) => {
    const laneA = a?.recallLane ? 1 : 0;
    const laneB = b?.recallLane ? 1 : 0;
    if (laneA !== laneB) return laneA - laneB;

    // If candidates have an explicit input index, preserve existing rank order within the lane
    const idxA = Number.isInteger(a?.index) ? a.index : null;
    const idxB = Number.isInteger(b?.index) ? b.index : null;
    if (idxA !== null && idxB !== null && idxA !== idxB) return idxA - idxB;

    const scoreA = Number.isFinite(a?.fusion?.logOdds) ? a.fusion.logOdds
      : (Number.isFinite(a?.probability) ? a.probability : (Number.isFinite(a?.score) ? a.score : 0));
    const scoreB = Number.isFinite(b?.fusion?.logOdds) ? b.fusion.logOdds
      : (Number.isFinite(b?.probability) ? b.probability : (Number.isFinite(b?.score) ? b.score : 0));
    if (scoreB !== scoreA) return scoreB - scoreA;

    const keyA = String(a?.key ?? a?.id ?? a?.addr ?? a?.fieldName ?? '');
    const keyB = String(b?.key ?? b?.id ?? b?.addr ?? b?.fieldName ?? '');
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  }).slice(0, max);
}

async function boundedJevCall(client, input, opts) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new RangeError('Invalid Jev timeout');
  if (opts.signal?.aborted) throw new Error('Jev query cancelled');
  const controller = new AbortController();
  let timer;
  let abort;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Jev query timeout')); }, timeoutMs);
    abort = () => { controller.abort(); reject(new Error('Jev query cancelled')); };
    opts.signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => client.call({ ...input, signal: controller.signal })), deadline]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Safe optional preference router for Jev assistance.
 * 
 * Rules:
 * - Default disabled: { enabled = false }
 * - Jev may only express a preference among EXISTING Hex candidates.
 * - Call Jev only for partial-mode queries when Hex top1 is not strong (verdict !== 'confirmed' && verdict !== 'likely')
 * - Take Jev's choice only if it is inside the shortlist
 * - Jev's choice can change top1, but the verdict strength stays at most 'likely/ambiguous' (never promoted to strong by Jev alone)
 * - Returns { top1, source: 'hex'|'jev', advisory: { jevChoice, withinShortlist } }
 * - Returns the Hex result unchanged on any error/timeout/malformed/out-of-shortlist response (fail closed).
 */
export async function rerankWithJev(query, hexResult, opts = {}) {
  const fallback = {
    top1: hexResult?.top ?? null,
    source: 'hex',
    advisory: { jevChoice: null, withinShortlist: false },
    hexResult,
  };

  if (!opts?.enabled) return fallback;
  if (!hexResult || !Array.isArray(hexResult.candidates) || hexResult.candidates.length < 2) return fallback;

  // Determine query mode
  const mode = opts?.mode ?? (typeof query === 'object' ? query?.mode : null) ?? 'partial';
  if (mode !== 'partial') return fallback;

  // Gate: only call Jev when Hex top1 is not strong
  const verdict = hexResult.verdict ?? 'none';
  const isStrong = verdict === 'confirmed' || verdict === 'likely';
  if (isStrong) return fallback;

  // Shortlist up to 255 candidates
  const shortlist = jevShortlist(hexResult.candidates, { max: opts?.maxChoices ?? 255 });
  if (!shortlist.length) return fallback;

  try {
    const client = opts?.client;
    if (!client || typeof client.call !== 'function') return fallback;

    const lattice = hexResult.candidates;
    const top = hexResult.top;
    const keys = lattice.map(c => c.key ?? c.id);
    if (new Set(keys).size !== keys.length) return fallback;
    if (opts.isCurrent != null && (typeof opts.isCurrent !== 'function' || opts.isCurrent() !== true)) return fallback;

    const jevResponse = await boundedJevCall(client, {
      query: typeof query === 'string' ? query : (query?.text ?? query?.query ?? ''),
      mode,
      candidates: shortlist,
    }, opts);

    // The response belongs to the exact candidate view that was sent. An
    // interactive query owner can additionally bind its snapshot/revision.
    if (hexResult.candidates !== lattice || hexResult.top !== top
      || lattice.length !== keys.length || lattice.some((c, i) => (c.key ?? c.id) !== keys[i])
      || opts.signal?.aborted || (opts.isCurrent != null && opts.isCurrent() !== true)) return fallback;

    if (!jevResponse || typeof jevResponse !== 'object') return fallback;

    const hasKey = Object.hasOwn(jevResponse, 'selectedKey');
    const hasIndex = Object.hasOwn(jevResponse, 'choiceIndex');
    const choiceKey = hasKey ? jevResponse.selectedKey : null;
    const choiceIndex = hasIndex ? jevResponse.choiceIndex : null;

    // Two identities cannot contradict each other. A malformed supplied
    // identity is rejected instead of being hidden by the other valid one.
    if ((!hasKey && !hasIndex)
      || (hasKey && (typeof choiceKey !== 'string' || !choiceKey.length))
      || (hasIndex && (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= shortlist.length))) {
      return fallback;
    }

    let chosenCandidate = null;
    if (hasIndex) {
      chosenCandidate = shortlist[choiceIndex];
      if (hasKey && (chosenCandidate.key ?? chosenCandidate.id) !== choiceKey) return fallback;
    } else if (hasKey) {
      chosenCandidate = shortlist.find((c) => (c.key ?? c.id) === choiceKey) ?? null;
    }

    if (!chosenCandidate) {
      return {
        ...fallback,
        advisory: { jevChoice: choiceKey, withinShortlist: false },
      };
    }

    // Candidate must belong to existing Hex candidate lattice
    const matching = hexResult.candidates.filter((c) => (c.key ?? c.id) === (chosenCandidate.key ?? chosenCandidate.id));
    const inLattice = matching.length === 1 ? matching[0] : null;
    if (!inLattice) {
      return {
        ...fallback,
        advisory: { jevChoice: chosenCandidate.key ?? chosenCandidate.id, withinShortlist: false },
      };
    }

    return {
      top1: inLattice,
      source: 'jev',
      advisory: {
        jevChoice: inLattice.key ?? inLattice.id,
        withinShortlist: true,
        confidence: jevResponse.confidence ?? null,
        preference: jevResponse.preference ?? null,
      },
      hexResult,
    };
  } catch (_err) {
    return fallback;
  }
}

// An optional remote suggestion is separated from the committed local result.
// This removes remote-driven destruction and effective decision instability;
// it does not claim that the underlying model's suggestions became stable.
export async function adviseWithJev(query, localResult, opts = {}) {
  const proposal = await rerankWithJev(query, localResult, opts);
  return {
    ...proposal, top1: localResult?.top ?? null, source: 'hex', hexResult: localResult,
    advisory: { ...proposal.advisory, advisoryOnly: true,
      candidate: proposal.source === 'jev' ? proposal.top1 : null },
  };
}

// The public facade accepts only safe, non-negative integer limits. Explicit
// zero is meaningful; malformed values use the historical default rather than
// reaching Array#slice coercion or relative-index semantics.
function resultLimit(value, fallback = 12) {
  if (value == null) return fallback;
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function timeoutMs(opts) {
  const raw = opts?.perFunctionBudgetMs != null ? opts.perFunctionBudgetMs : opts?.analysisTimeoutMs;
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_PINPOINT_ANALYSIS_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_PINPOINT_ANALYSIS_TIMEOUT_MS, Math.floor(requested)));
}

function accessTimeoutMs(opts) {
  const requested = Number(opts?.accessScanTimeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_ACCESS_SCAN_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_ACCESS_SCAN_TIMEOUT_MS, Math.floor(requested)));
}

function uniqueAnalysisLimit(opts) {
  // `shapes` is the automatic-analysis marker: prepare() builds that one-pass
  // index before autoAnalyze. Direct pinpoint callers without shapes retain the
  // historical unlimited unique-function envelope.
  if (opts?.shapes == null) return Infinity;
  const requested = Number(opts?.maxPinpointAnalyses);
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_AUTO_UNIQUE_ANALYSES;
  return Math.max(1, Math.min(MAX_AUTO_UNIQUE_ANALYSES, Math.floor(requested)));
}

function timeoutError(ms) {
  const error = new Error(`pinpoint analysis timed out after ${ms}ms`);
  error.code = 'pinpoint-analysis-timeout';
  error.reason = PER_FUNCTION_BUDGET_EXCEEDED_REASON;
  return error;
}

function accessTimeoutError(ms) {
  const error = new Error(`pinpoint access scan timed out after ${ms}ms`);
  error.code = 'pinpoint-access-timeout';
  return error;
}

function analysisBudgetError(limit) {
  const error = new Error(`pinpoint unique-analysis budget exhausted at ${limit} functions`);
  error.code = 'pinpoint-analysis-budget';
  return error;
}

function abortError(reason) {
  const error = new Error(typeof reason === 'string' && reason ? reason : 'pinpoint analysis aborted');
  error.name = 'AbortError';
  error.code = 'pinpoint-analysis-aborted';
  if (reason !== undefined) error.reason = reason;
  return error;
}

function analysisKey(args) {
  return args.slice(0, 2).map((value) => value == null ? 'null' : value.toString()).join(':');
}

function serializeTypedCacheArg(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undef';
  const type = typeof value;
  if (type === 'bigint') return `b:${value}`;
  if (type === 'number') return `n:${Object.is(value, -0) ? '-0' : value}`;
  if (type === 'string') return `s:${JSON.stringify(value)}`;
  if (type === 'boolean') return `bool:${value}`;
  return null;
}

function analyzeCacheKey(args) {
  if (args.length > 3) return null;
  if (args.length === 3 && args[2] !== undefined) {
    const third = args[2];
    if (third === null || typeof third !== 'object') return null;
    const proto = Object.getPrototypeOf(third);
    if (proto !== Object.prototype && proto !== null) return null;
    for (const k of Object.keys(third)) {
      if (!ANALYZE_CACHE_ALLOWED_OPT_KEYS.has(k)) return null;
    }
  }
  const k0 = serializeTypedCacheArg(args[0]);
  if (k0 === null) return null;
  const k1 = serializeTypedCacheArg(args[1]);
  if (k1 === null) return null;
  return `${k0}|${k1}`;
}

function cacheAnalyzeResult(cache, key, value) {
  if (key === null || value == null) return;
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= ANALYZE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function analyzeArgsWithSignal(args, signal, budgetMs) {
  const out = args.slice();
  const third = out[2];
  if (third && typeof third === 'object' && !Array.isArray(third)) {
    out[2] = { ...third, signal, perFunctionBudgetMs: budgetMs };
  } else {
    out[2] = { signal, perFunctionBudgetMs: budgetMs };
  }
  return out;
}

function yieldToEventLoop(signal = null) {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const onAbort = () => {
      if (done) return;
      done = true;
      if (timer != null) clearTimeout(timer);
      reject(abortError(signal?.reason));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, 0);
  });
}

function safeAddrKey(addr) {
  if (addr == null) return null;
  try { return BigInt(addr).toString(); } catch { return String(addr); }
}

function recordBudgetExceeded(budgetTracker, addr, elapsedMs, budgetMs) {
  if (!budgetTracker) return;
  const key = safeAddrKey(addr);
  if (key == null) return;
  budgetTracker.set(key, {
    addr,
    elapsedMs,
    budgetMs,
    status: 'unverified',
    label: '未確認',
    reason: PER_FUNCTION_BUDGET_EXCEEDED_REASON,
  });
}

function candidateMatchesBudgetTracker(c, budgetTracker) {
  if (!c || !budgetTracker || budgetTracker.size === 0) return false;
  const direct = safeAddrKey(c.addr);
  if (direct != null && budgetTracker.has(direct)) return true;
  const getter = safeAddrKey(c.accessors?.getter?.addr);
  if (getter != null && budgetTracker.has(getter)) return true;
  const setter = safeAddrKey(c.accessors?.setter?.addr);
  if (setter != null && budgetTracker.has(setter)) return true;
  if (Array.isArray(c.functions)) {
    for (const fn of c.functions) {
      const fk = safeAddrKey(fn?.addr);
      if (fk != null && budgetTracker.has(fk)) return true;
    }
  }
  return false;
}

function applyBudgetExceededMetadata(result, budgetTracker) {
  if (!result || !budgetTracker || budgetTracker.size === 0) return result;
  const exceeded = Array.from(budgetTracker.values());
  for (const c of result.candidates || []) {
    if (!candidateMatchesBudgetTracker(c, budgetTracker)) continue;
    if (!c.verified) {
      c.verified = false;
      c.unconfirmed = true;
      c.verificationStatus = 'unverified';
      c.statusLabel = '未確認';
      c.unverifiedReason = PER_FUNCTION_BUDGET_EXCEEDED_REASON;
    }
  }
  const missing = Array.isArray(result.missing) ? result.missing.slice() : [];
  if (!missing.includes(PER_FUNCTION_BUDGET_EXCEEDED_REASON)) {
    missing.push(PER_FUNCTION_BUDGET_EXCEEDED_REASON);
  }
  return {
    ...result,
    missing,
    budgetExceeded: exceeded,
    unconfirmedFunctions: exceeded,
  };
}

function linkParentSignal(controller, parentSignal) {
  if (!parentSignal) return () => {};
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal.reason ?? 'cancelled');
  };
  parentSignal.addEventListener('abort', abort, { once: true });
  if (parentSignal.aborted) abort();
  return () => parentSignal.removeEventListener('abort', abort);
}

/*
 * One stuck function analysis must not hold the whole automatic analysis open.
 * A short circuit breaker is shared by all pinpoint calls using the same
 * analyzer, so one orphaned backend request cannot spawn dozens more while the
 * remaining goals are being examined. Automatic analysis also has a shared
 * unique-function ceiling; repeated reads of the same function remain free.
 *
 * The timeout is not merely a UI race: it aborts the analysis signal and calls
 * a cancellable operation's cancel hook when available, so backend work cannot
 * survive as a detached orphan after the pinpoint phase has moved on.
 */
function guardedAnalyze(analyze, opts, budgetTracker = null) {
  if (typeof analyze !== 'function') return analyze;
  const burstScoped = isObjectKey(opts?.shapes);
  const state = burstScopedState(ANALYZE_GUARDS, analyze, opts,
    () => (burstScoped ? { uniqueKeys: new Set(), resultCache: new Map() } : { uniqueKeys: new Set() }));
  const resultCache = burstScoped
    ? (state.resultCache || (state.resultCache = new Map()))
    : new Map();
  const ms = timeoutMs(opts);
  const uniqueLimit = uniqueAnalysisLimit(opts);
  let callCount = 0;
  return async (...args) => {
    const argSignal = args[2] && typeof args[2] === 'object' ? args[2].signal : null;
    if (opts?.signal?.aborted || opts?.isCancelled?.() || argSignal?.aborted) {
      throw abortError(argSignal?.aborted ? argSignal.reason : opts?.signal?.reason);
    }
    const cacheKey = analyzeCacheKey(args);
    if (cacheKey !== null && resultCache.has(cacheKey)) {
      return resultCache.get(cacheKey);
    }
    if (callCount > 0) {
      await yieldToEventLoop(opts?.signal || null);
      if (opts?.signal?.aborted || opts?.isCancelled?.() || argSignal?.aborted) {
        throw abortError(argSignal?.aborted ? argSignal.reason : opts?.signal?.reason);
      }
    }
    callCount++;
    const key = analysisKey(args);
    if (!state.uniqueKeys.has(key)) {
      if (state.uniqueKeys.size >= uniqueLimit) throw analysisBudgetError(uniqueLimit);
      state.uniqueKeys.add(key);
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    const unlinkParent = linkParentSignal(controller, opts?.signal || null);
    const unlinkArg = linkParentSignal(controller, argSignal || null);
    let timer = null;
    let operation = null;
    let onControllerAbort = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(PER_FUNCTION_BUDGET_EXCEEDED_REASON);
        try { operation?.cancel?.(); } catch { /* timeout remains authoritative */ }
        recordBudgetExceeded(budgetTracker, args[0], Date.now() - startedAt, ms);
        reject(timeoutError(ms));
      }, ms);
      onControllerAbort = () => {
        if (controller.signal.reason === PER_FUNCTION_BUDGET_EXCEEDED_REASON) return;
        try { operation?.cancel?.(); } catch { /* abort remains authoritative */ }
        reject(abortError(controller.signal.reason));
      };
      controller.signal.addEventListener('abort', onControllerAbort, { once: true });
    });
    timeout.catch(() => {});
    try {
      operation = analyze(...analyzeArgsWithSignal(args, controller.signal, ms));
      const res = await Promise.race([Promise.resolve(operation), timeout]);
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > ms) {
        recordBudgetExceeded(budgetTracker, args[0], elapsedMs, ms);
        throw timeoutError(ms);
      }
      if (res != null && !controller.signal.aborted && !opts?.isCancelled?.() && !argSignal?.aborted) {
        cacheAnalyzeResult(resultCache, cacheKey, res);
      }
      return res;
    } catch (error) {
      if (error?.code === 'pinpoint-analysis-timeout' || error?.reason === PER_FUNCTION_BUDGET_EXCEEDED_REASON) {
        recordBudgetExceeded(budgetTracker, args[0], Date.now() - startedAt, ms);
      }
      throw error;
    } finally {
      if (timer != null) clearTimeout(timer);
      if (onControllerAbort) controller.signal.removeEventListener('abort', onControllerAbort);
      unlinkArg();
      unlinkParent();
    }
  };
}

function addOffset(set, value) {
  if (value == null) return;
  try { set.add(BigInt(value).toString()); } catch { /* invalid metadata is ignored */ }
}

function automaticOffsets(opts, requested) {
  const keys = new Set();
  for (const item of requested || []) addOffset(keys, item?.offset);
  for (const entry of opts?.shapes?.values?.() || []) addOffset(keys, entry?.offset);
  for (const cls of opts?.fields?.classes?.values?.() || []) {
    for (const ivar of cls?.ivars || []) addOffset(keys, ivar?.offset);
  }
  // The worker indexes requested offsets by displacement. Scanning with size=0
  // captures a lossless superset once; each legacy request is size-filtered
  // when read back from the cache below.
  return Array.from(keys, (key) => ({ offset: BigInt(key), size: 0 }));
}

function emptyGroups() { return new Map(); }
function groupAt(groups, key) {
  if (!groups) return [];
  return (groups.get ? groups.get(key) : (Object.hasOwn(groups, key) ? groups[key] : null)) || [];
}
function sizeMatches(site, size) {
  const wanted = Number(size) || 0;
  if (wanted <= 0) return true;
  return site?.size == null || site.size === wanted || (wanted > 8 && site.size === 8);
}

function safeOffsetKey(offset) {
  if (offset == null) return null;
  try { return BigInt(offset).toString(); } catch { return null; }
}

function mergeScannedGroups(state, scannedList, groups) {
  if (!state.groups) state.groups = new Map();
  const resolved = groups || emptyGroups();
  if (resolved instanceof Map) {
    for (const [k, v] of resolved.entries()) {
      const key = safeOffsetKey(k) ?? String(k);
      state.groups.set(key, Array.isArray(v) ? v : []);
    }
  } else if (resolved && typeof resolved === 'object') {
    for (const [k, v] of Object.entries(resolved)) {
      const key = safeOffsetKey(k) ?? String(k);
      state.groups.set(key, Array.isArray(v) ? v : []);
    }
  }
  for (const item of scannedList) {
    const key = safeOffsetKey(item?.offset);
    if (key == null) continue;
    state.scannedOffsets.add(key);
    if (!state.groups.has(key)) state.groups.set(key, []);
  }
}

function missingOffsets(state, opts, requested) {
  const candidates = state.groups == null
    ? automaticOffsets(opts, requested)
    : (() => {
        const keys = new Set();
        for (const item of requested || []) addOffset(keys, item?.offset);
        return Array.from(keys, (key) => ({ offset: BigInt(key), size: 0 }));
      })();
  return candidates.filter((item) => !state.scannedOffsets.has(item.offset.toString()));
}

async function waitWithSignal(promise, signal) {
  if (!signal) {
    await promise;
    return false;
  }
  if (signal.aborted) return true;
  let onAbort = null;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(true);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([
      promise.then(() => false, () => false),
      aborted,
    ]);
    return result === true;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/*
 * fieldAccessMany is specifically designed to inspect many displacements in a
 * single executable-region pass. Build that superset on the first pinpoint
 * request and reuse it for every later goal. Supplemental scans cover any
 * requested offsets absent from the initial superset. A failed/timed-out scan
 * marks the burst as failed while preserving already-scanned groups; an aborted
 * caller never poisons the burst for subsequent non-cancelled callers.
 */
function batchedScanAccess(scanAccess, opts) {
  if (typeof scanAccess !== 'function') return scanAccess;
  const state = burstScopedState(ACCESS_BATCHES, scanAccess, opts,
    () => ({ promise: null, groups: null, scannedOffsets: new Set(), failed: false }));
  const isAborted = () => Boolean(opts?.signal?.aborted || opts?.isCancelled?.());
  return async (requested = []) => {
    if (isAborted()) return emptyGroups();
    while (!state.failed && !isAborted()) {
      const toScan = missingOffsets(state, opts, requested);
      if (!toScan.length) break;

      if (state.promise) {
        if (opts?.deferAccessScan === true && !state.groups) {
          state.promise.catch(() => {});
          return emptyGroups();
        }
        const waiterAborted = await waitWithSignal(state.promise, opts?.signal || null);
        if (waiterAborted || isAborted()) return emptyGroups();
        continue;
      }

      const ms = accessTimeoutMs(opts);
      const controller = new AbortController();
      let timer = null;
      let operation = null;
      let timedOut = false;
      let onControllerAbort = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          if (!controller.signal.aborted) controller.abort('pinpoint-access-timeout');
          try { operation?.cancel?.(); } catch { /* timeout remains authoritative */ }
          reject(accessTimeoutError(ms));
        }, ms);
        onControllerAbort = () => {
          if (timedOut) return;
          try { operation?.cancel?.(); } catch { /* abort remains authoritative */ }
          reject(abortError(controller.signal.reason));
        };
        controller.signal.addEventListener('abort', onControllerAbort, { once: true });
      });
      timeout.catch(() => {});
      try {
        operation = scanAccess(toScan, { signal: controller.signal });
      } catch (error) {
        if (timer != null) clearTimeout(timer);
        if (onControllerAbort) controller.signal.removeEventListener('abort', onControllerAbort);
        state.failed = true;
        throw error;
      }
      const inFlight = Promise.race([Promise.resolve(operation), timeout])
        .then((groups) => {
          if (timedOut || controller.signal.aborted) return state.groups || emptyGroups();
          mergeScannedGroups(state, toScan, groups);
          return state.groups;
        })
        .catch(() => {
          if (timedOut || (!controller.signal.aborted && !isAborted())) {
            state.failed = true;
          }
          return state.groups || emptyGroups();
        })
        .finally(() => {
          if (timer != null) clearTimeout(timer);
          if (onControllerAbort) controller.signal.removeEventListener('abort', onControllerAbort);
          if (state.promise === inFlight) state.promise = null;
        });
      state.promise = inFlight;

      if (opts?.deferAccessScan === true && !state.groups) {
        // Avoid stalling the initial interactive query on a whole-binary scan.
        inFlight.catch(() => {});
        return emptyGroups();
      }
      const waiterAborted = await waitWithSignal(inFlight, opts?.signal || null);
      if (waiterAborted || isAborted()) return emptyGroups();
    }
    if (isAborted()) return emptyGroups();
    const groups = state.groups;
    const out = new Map();
    if (!groups) return out;
    for (const item of requested || []) {
      const offKey = safeOffsetKey(item?.offset);
      if (offKey == null || !state.scannedOffsets.has(offKey)) continue;
      const size = Number(item?.size) || 0;
      const compKey = size > 0 ? `${offKey}:${size}` : offKey;
      const filtered = groupAt(groups, offKey).filter((site) => sizeMatches(site, size));
      out.set(compKey, filtered);
      if (compKey !== offKey && !out.has(offKey)) {
        out.set(offKey, filtered);
      }
    }
    return out;
  };
}

function guardedScanAccess(scanAccess, opts) {
  if (typeof scanAccess !== 'function') return scanAccess;
  const isAborted = () => Boolean(opts?.signal?.aborted || opts?.isCancelled?.());
  return async (requested = []) => {
    if (isAborted()) return emptyGroups();
    const ms = accessTimeoutMs(opts);
    const controller = new AbortController();
    const unlinkParent = linkParentSignal(controller, opts?.signal || null);
    let timer = null;
    let operation = null;
    let timedOut = false;
    let onControllerAbort = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        if (!controller.signal.aborted) controller.abort('pinpoint-access-timeout');
        try { operation?.cancel?.(); } catch { /* timeout remains authoritative */ }
        reject(accessTimeoutError(ms));
      }, ms);
      onControllerAbort = () => {
        if (timedOut) return;
        try { operation?.cancel?.(); } catch { /* abort remains authoritative */ }
        reject(abortError(controller.signal.reason));
      };
      controller.signal.addEventListener('abort', onControllerAbort, { once: true });
    });
    try {
      operation = scanAccess(requested, { signal: controller.signal });
      const groups = await Promise.race([Promise.resolve(operation), timeout]);
      if (isAborted()) return emptyGroups();
      return groups;
    } catch {
      return emptyGroups();
    } finally {
      if (timer != null) clearTimeout(timer);
      if (onControllerAbort) controller.signal.removeEventListener('abort', onControllerAbort);
      unlinkParent();
    }
  };
}

function composeIsCancelled(opts) {
  const prev = typeof opts?.isCancelled === 'function' ? opts.isCancelled : null;
  const signal = opts?.signal || null;
  if (!prev && !signal) return opts?.isCancelled;
  return () => Boolean(signal?.aborted) || Boolean(prev?.());
}

function preparedOptions(opts, budgetTracker = null) {
  const o = opts || {};
  const isCancelled = composeIsCancelled(o);
  const effectiveOpts = isCancelled !== o.isCancelled ? { ...o, isCancelled } : o;
  const automaticBatch = o.shapes != null && o.forceAccessScan !== true;
  const deferScan = o.deferAccessScan === true && !automaticBatch;
  return {
    ...effectiveOpts,
    analyze: guardedAnalyze(o.analyze, effectiveOpts, budgetTracker),
    scanAccess: deferScan
      ? null
      : (automaticBatch ? batchedScanAccess(o.scanAccess, effectiveOpts) : guardedScanAccess(o.scanAccess, effectiveOpts)),
  };
}

function shapeMutationSites(shapes, offset) {
  if (!shapes || typeof shapes.values !== 'function' || offset == null) return [];
  const wanted = Number(offset);
  if (!Number.isFinite(wanted)) return [];
  const out = [];
  const seen = new Set();
  let family = null;
  let hasFamily = false;
  for (const entry of shapes.values()) {
    if (!entry || Number(entry.offset) !== wanted) continue;
    const entryFamily = entry.identity ?? null;
    for (const site of entry.sites || []) {
      if (site?.addr == null) continue;
      if (!hasFamily) {
        family = entryFamily;
        hasFamily = true;
      } else if (family !== entryFamily) {
        // Equal displacements in different objects cannot identify this field.
        return [];
      }
      const key = site.addr.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ addr: site.addr, kind: 'store' });
    }
  }
  return out;
}

/* Shape sites are only a fallback when the exhaustive batched access scan did
 * not produce a change site. Never replace stronger full-scan evidence. */
function hydrateShapeChangeSites(pin, opts) {
  if (pin?.top?.source === 'cxx') return pin;
  if (!pin?.top || opts?.shapes == null || pin.changeSites?.length) return pin;
  const sites = shapeMutationSites(opts.shapes, pin.top.offset);
  if (!sites.length) return pin;
  const className = pin.kind === 'field' ? pin.top.className : null;
  const grouped = groupSites(sites, opts.program || null, opts.fields || null, className);
  pin.top.sites = grouped;
  pin.top.siteCount = sites.length;
  pin.changeSites = grouped;
  return pin;
}

export async function pinpointField(opts = {}) {
  const requestedLimit = resultLimit(opts.limit);
  const budgetTracker = new Map();
  /* The preserved implementation internally keeps at most 400 candidates.
     Ask it to return that whole ranked set so the prior is not inferred from a
     UI-truncated top-12 list. */
  const raw = await legacyPinpointField({ ...preparedOptions(opts, budgetTracker), limit: 400 });
  if (!raw || !Array.isArray(raw.candidates) || !raw.candidates.length) {
    return applyBudgetExceededMetadata(raw, budgetTracker);
  }

  const ranked = raw.candidates.slice();
  const priorCandidates = narrowedPriorCount(ranked, raw.universe);
  for (const c of ranked) c.fusion = fuse(c.evidence || [], { candidates: priorCandidates });
  ranked.sort(byRecallLane);
  /* P4: field 経路でのみ trusted 2-group（metadata+structural）の likely を許可。 */
  const decision = decide(ranked, { allowTrustedTwoGroup: true });
  const oldTopKey = raw.top && raw.top.key;
  const newTopKey = decision.top && decision.top.key;

  for (const c of ranked) {
    c.probability = c.fusion.probability;
    c.stars = starsOf(c.fusion.probability, c === decision.top ? decision.verdict : null);
    c.why = explain(c.fusion);
  }

  const result = {
    ...raw,
    verdict: decision.verdict,
    top: decision.top || null,
    runnerUp: decision.runnerUp || null,
    margin: decision.margin,
    marginRatio: decision.marginRatio,
    missing: decision.missing,
    candidates: ranked,
    priorCandidates,
    priorStableAcrossVerification: true,
    changeSites: oldTopKey === newTopKey ? raw.changeSites : ((decision.top && (decision.top.changeSites || decision.top.sites)) || []),
  };
  const preferred = opts.binaryContextPreference === true
    ? withCxxSemanticPreference(opts.goal?.text, result, opts.symbols, { policy: opts.cxxSemanticPolicy || 'object-context-v4', goal: opts.goal }) : result;
  const hydrated = hydrateShapeChangeSites({ ...preferred, candidates: preferred.candidates.slice(0, requestedLimit) }, opts);
  return applyBudgetExceededMetadata(hydrated, budgetTracker);
}

export async function pinpointLocation(opts = {}) {
  const requestedLimit = resultLimit(opts.limit, 10);
  const budgetTracker = new Map();
  const result = await legacyPinpointLocation({ ...preparedOptions(opts, budgetTracker), limit: requestedLimit });
  return applyBudgetExceededMetadata(hydrateShapeChangeSites(result, opts), budgetTracker);
}

export async function pinpointFunction(opts = {}) {
  const requestedLimit = resultLimit(opts.limit, 12);
  const budgetTracker = new Map();
  const result = await legacyPinpointFunction({ ...preparedOptions(opts, budgetTracker), limit: requestedLimit });
  return applyBudgetExceededMetadata(result, budgetTracker);
}

function bestVerdict(field, fn) {
  const a = field ? field.verdict : VERDICT.NONE;
  const b = fn ? fn.verdict : VERDICT.NONE;
  return verdictRank(a) >= verdictRank(b) ? a : b;
}

export async function pinpoint(opts = {}) {
  const o = opts || {};
  const cancelled = () => Boolean(o.signal?.aborted || o.isCancelled?.());
  let field = await pinpointField(o);

  if (!cancelled() && !field.top && ((o.ranked && o.ranked.length) || (o.shapes && o.shapes.size))) {
    const loc = await pinpointLocation(o);
    if (loc.top) field = loc;
  }

  let fn = null;
  if (!cancelled() && ((o.ranked && o.ranked.length) || (o.shapes && o.shapes.size) || o.shapesByGoal)) {
    fn = await pinpointFunction(Object.assign({}, o, {
      // Offset-only function verification cannot establish a C++ owner.
      field: field.top && field.top.source !== 'cxx' ? {
        offset: field.top.offset, className: field.top.className,
        plain: field.top.plain, name: field.top?.field?.name ?? null,
      } : null,
    }));
  }

  const budgetExceeded = [
    ...(Array.isArray(field?.budgetExceeded) ? field.budgetExceeded : []),
    ...(Array.isArray(fn?.budgetExceeded) ? fn.budgetExceeded : []),
  ];
  return {
    goal: o.goal,
    field,
    function: fn,
    verdict: bestVerdict(field, fn),
    ...(budgetExceeded.length ? { budgetExceeded, unconfirmedFunctions: budgetExceeded } : {}),
  };
}

export { guardedAnalyze as __guardedAnalyzeForTests };
