import { createAppAnalysisQueryAdapter as createProductAdapter } from './product-adapter.js';
import { runtimeEvidenceForApp } from '../../runtime/app-runtime.js';
import { weakestCompleteness } from '../status.js';

const CANONICAL_VERDICTS = new Set([
  'confirmed', 'supported', 'likely', 'unverified', 'contradicted', 'unknown', 'inconclusive',
]);
const MAX_EVIDENCE_ROWS = 5_000;
const MAX_UPSTREAM_TOTAL_CACHE = 64;

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('AbortError');
  error.name = 'AbortError';
  throw error;
}

function upstreamTotalCacheKey(snapshot, query) {
  const snapshotId = typeof snapshot?.snapshotId === 'string' && snapshot.snapshotId ? snapshot.snapshotId : null;
  if (!snapshotId) return null;
  try {
    return `${snapshotId}:${JSON.stringify(query ?? {}, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`;
  } catch {
    return null;
  }
}

function addressOf(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^(?:fn|function):/i, '');
  if (!text) return null;
  try {
    const parsed = BigInt(text);
    return parsed >= 0n ? parsed : null;
  } catch { return null; }
}

function pageOf(page = {}) {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 200;
  return {
    offset: typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    limit: typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? Math.min(MAX_EVIDENCE_ROWS, limit) : 200,
  };
}

function pageOffset(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalVerdict(value, fallback = 'unverified') {
  const candidates = [value?.verdict, value?.status?.verdict, value?.evidence?.verdict, value?.proof?.verdict, value?.evidence?.status?.verdict];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().toLowerCase();
    if (CANONICAL_VERDICTS.has(normalized)) return normalized;
  }
  return fallback;
}

function canonicalEvidenceId(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null;
}

function projectEvidence(kind, value, extra = {}, fallbackVerdict = 'unverified') {
  const evidence = value?.evidence ?? value;
  const source = extra.source ?? value?.source ?? evidence?.source ?? evidence?.provenance?.source ?? null;
  const detail = extra.detail ?? value?.detail ?? evidence?.detail ?? evidence?.reason ?? null;
  const rawEvidenceId = extra.evidenceId ?? value?.evidenceId ?? value?.id ?? evidence?.evidenceId ?? evidence?.id ?? null;
  const evidenceId = canonicalEvidenceId(rawEvidenceId);
  return { ...extra, evidenceId, kind: typeof value?.kind === 'string' && value.kind.trim() ? value.kind : kind, verdict: canonicalVerdict(value, fallbackVerdict), source, detail, evidence };
}

function combinedCompleteness(base, functionResult, baseHasNext) {
  const baseCompleteness = base?.status?.completeness ?? 'partial';
  const functionCompleteness = functionResult?.status?.completeness ?? 'complete';
  return weakestCompleteness(
    baseCompleteness,
    functionCompleteness,
    baseHasNext ? 'partial' : 'complete',
  );
}

export function createAppAnalysisQueryAdapter(app) {
  const base = createProductAdapter(app);
  const upstreamTotals = new Map();
  const rememberUpstreamTotal = (key, total) => {
    if (!key || total == null) return;
    upstreamTotals.delete(key);
    upstreamTotals.set(key, total);
    while (upstreamTotals.size > MAX_UPSTREAM_TOTAL_CACHE) {
      const oldest = upstreamTotals.keys().next().value;
      if (oldest === undefined) break;
      upstreamTotals.delete(oldest);
    }
  };
  const resolveUnknownUpstreamTotal = async (snapshot, query, upperBound, options) => {
    const key = upstreamTotalCacheKey(snapshot, query);
    if (key && upstreamTotals.has(key)) {
      const cached = upstreamTotals.get(key);
      if (cached <= upperBound) return { total: cached, invalid: false };
    }
    // Upstream omitted page.total and returned an empty page past the end of
    // its stream (upstreamOffset > 0). Binary-search [0, upperBound] with
    // limit=1 probes to find the exact upstream boundary so suffixOffset
    // advances monotonically instead of resetting to 0.
    let lo = 0;
    let hi = upperBound;
    while (lo < hi) {
      abortIfNeeded(options?.signal);
      const mid = Math.floor((lo + hi) / 2);
      const probe = await base.evidence(snapshot, query, { offset: mid, limit: 1 }, options);
      const probeTotal = pageOffset(probe?.page?.total);
      if (probeTotal != null) {
        rememberUpstreamTotal(key, probeTotal);
        return { total: probeTotal, invalid: false };
      }
      const probeRows = Array.isArray(probe?.value) ? probe.value : [];
      const rawProbeNext = probe?.page?.next ?? null;
      const parsedProbeNext = rawProbeNext == null ? null : pageOffset(rawProbeNext);
      if (rawProbeNext != null && (parsedProbeNext == null || parsedProbeNext <= mid)) {
        return { total: null, invalid: true };
      }
      if (probeRows.length > 0) {
        if (parsedProbeNext == null) {
          const exact = mid + probeRows.length;
          rememberUpstreamTotal(key, exact);
          return { total: exact, invalid: false };
        }
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    rememberUpstreamTotal(key, lo);
    return { total: lo, invalid: false };
  };
  return {
    ...base,
    async evidence(snapshot, query = {}, page = {}, options = {}) {
      const requested = pageOf(page);
      const rawTarget = query?.functionId ?? query?.address ?? null;
      const address = addressOf(rawTarget);

      // Supplemental evidence has a stable position around the upstream stream:
      // symbol identity/boundary rows precede it; analysis/runtime rows follow it.
      // This lets a numeric product offset map to the upstream offset without
      // materializing or truncating the entire upstream evidence corpus.
      const prefix = [];
      if (address != null) {
        const boundaryEvidence = app?.symbols?.functionEvidence?.(address) ?? null;
        const name = app?.symbols?.nameAt?.(address) ?? null;
        const nameEvidence = app?.symbols?.nameEvidence?.(address) ?? null;
        if (name != null || nameEvidence) prefix.push(projectEvidence('function-name', nameEvidence ?? {}, { title: 'Function name', address, detail: typeof name === 'string' ? name : null }));
        if (boundaryEvidence) prefix.push(projectEvidence('function-boundary', boundaryEvidence, { title: 'Function boundary', address }));
      }

      const prefixValue = prefix.slice(requested.offset, requested.offset + requested.limit);
      const upstreamOffset = Math.max(0, requested.offset - prefix.length);
      const upstreamLimit = Math.max(1, requested.limit - prefixValue.length);
      const baseResult = await base.evidence(snapshot, query, { offset: upstreamOffset, limit: upstreamLimit }, options);
      const baseRows = (Array.isArray(baseResult?.value) ? baseResult.value : []).map((item) => projectEvidence('evidence', item));

      const rawBaseNext = baseResult?.page?.next ?? null;
      const parsedBaseNext = rawBaseNext == null ? null : pageOffset(rawBaseNext);
      let baseContinuationInvalid = rawBaseNext != null && (parsedBaseNext == null || parsedBaseNext <= upstreamOffset);
      const baseNext = baseContinuationInvalid ? null : parsedBaseNext;
      const baseHasNext = baseNext != null;
      const baseTotal = pageOffset(baseResult?.page?.total);

      const value = [...prefixValue];
      let remaining = requested.limit - value.length;
      let consumedBaseRows = 0;
      if (remaining > 0) {
        const upstreamRows = baseRows.slice(0, remaining);
        consumedBaseRows = upstreamRows.length;
        value.push(...upstreamRows);
        remaining = requested.limit - value.length;
      }

      let upstreamTotal = null;
      if (!baseHasNext && !baseContinuationInvalid) {
        const cacheKey = upstreamTotalCacheKey(snapshot, query);
        if (baseTotal != null) {
          upstreamTotal = baseTotal;
          rememberUpstreamTotal(cacheKey, upstreamTotal);
        } else if (upstreamOffset === 0 || baseRows.length > 0) {
          upstreamTotal = upstreamOffset + baseRows.length;
          rememberUpstreamTotal(cacheKey, upstreamTotal);
        } else {
          const resolved = await resolveUnknownUpstreamTotal(snapshot, query, upstreamOffset, options);
          if (resolved.invalid) baseContinuationInvalid = true;
          else upstreamTotal = resolved.total;
        }
      }
      const localCursorBeforeSuffix = requested.offset + value.length;
      const needsSuffix = address != null
        && !baseHasNext
        && !baseContinuationInvalid
        && (remaining > 0 || localCursorBeforeSuffix >= prefix.length + upstreamTotal);

      let functionResult = null;
      const suffix = [];
      if (needsSuffix) {
        functionResult = await base.functionById(snapshot, address, options);
        const value = functionResult?.value ?? null;
        for (const evidence of Array.isArray(value?.evidence) ? value.evidence : []) suffix.push(projectEvidence('function-analysis', evidence, { address }));
        for (const proof of Array.isArray(value?.rewriteProof) ? value.rewriteProof : []) suffix.push(projectEvidence('rewrite-proof', proof, { address, title: typeof proof?.rule === 'string' ? proof.rule : typeof proof?.name === 'string' ? proof.name : 'Decompiler rewrite' }));
        for (const observation of runtimeEvidenceForApp(app, address)) suffix.push(projectEvidence('runtime-observation', observation, { address, binaryHash: observation?.binaryHash ?? null, sliceIdentity: observation?.sliceIdentity ?? null }, 'unverified'));
      }

      // Preserve the existing supplemental row budget without applying it to
      // upstream pagination. The old global cap made upstream row 5001+ forever
      // unreachable; now only locally materialized supplemental evidence is capped.
      const supplementalCapped = prefix.length + suffix.length > MAX_EVIDENCE_ROWS;
      if (supplementalCapped) suffix.length = Math.max(0, MAX_EVIDENCE_ROWS - prefix.length);

      if (needsSuffix && remaining > 0) {
        const suffixStart = prefix.length + upstreamTotal;
        const suffixOffset = Math.max(0, localCursorBeforeSuffix - suffixStart);
        value.push(...suffix.slice(suffixOffset, suffixOffset + remaining));
      }

      const suffixDeferred = address != null && !needsSuffix;
      let completeness = combinedCompleteness(baseResult, functionResult, baseHasNext || baseContinuationInvalid || suffixDeferred);
      if (supplementalCapped) completeness = 'truncated';
      if ((prefix.length || baseRows.length || suffix.length) && completeness === 'unsupported') completeness = 'partial';

      let next = null;
      const localCursor = requested.offset + value.length;
      if (value.length === requested.limit && localCursor <= prefix.length) {
        next = localCursor;
      } else if (baseHasNext && consumedBaseRows > 0) {
        next = prefix.length + baseNext;
      } else if (!baseContinuationInvalid && upstreamTotal != null) {
        const availableTotal = prefix.length + upstreamTotal + suffix.length;
        if (localCursor < availableTotal) next = localCursor;
      }

      const completeTotal = completeness === 'complete' && upstreamTotal != null
        ? prefix.length + upstreamTotal + suffix.length
        : null;
      return {
        value,
        status: {
          ...(baseResult?.status && typeof baseResult.status === 'object' ? baseResult.status : {}),
          completeness,
          reason: supplementalCapped ? 'product-evidence-row-cap'
            : baseContinuationInvalid ? 'upstream-evidence-page-invalid'
              : baseHasNext ? 'upstream-evidence-pagination'
                : baseResult?.status?.reason ?? functionResult?.status?.reason ?? null,
          producer: 'canonical-product-evidence-adapter/v1',
        },
        page: { offset: requested.offset, limit: requested.limit, returned: value.length, total: completeTotal, next },
      };
    },
  };
}
