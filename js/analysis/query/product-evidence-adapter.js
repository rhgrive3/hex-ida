import { createAppAnalysisQueryAdapter as createProductAdapter } from './product-adapter.js';
import { runtimeEvidenceForApp } from '../../runtime/app-runtime.js';

const CANONICAL_VERDICTS = new Set([
  'confirmed', 'supported', 'likely', 'unverified', 'contradicted', 'unknown',
]);
const MAX_EVIDENCE_ROWS = 5_000;

function addressOf(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^(?:fn|function):/i, '');
  if (!text) return null;
  try { return BigInt(text); } catch { return null; }
}

function pageOf(page = {}) {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 200;
  return {
    offset: typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    limit: typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? Math.min(MAX_EVIDENCE_ROWS, limit) : 200,
  };
}

function canonicalVerdict(value, fallback = 'unverified') {
  const candidates = [
    value?.verdict,
    value?.status?.verdict,
    value?.evidence?.verdict,
    value?.proof?.verdict,
    value?.evidence?.status?.verdict,
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().toLowerCase();
    if (CANONICAL_VERDICTS.has(normalized)) return normalized;
  }
  return fallback;
}

function projectEvidence(kind, value, extra = {}, fallbackVerdict = 'unverified') {
  const evidence = value?.evidence ?? value;
  const source = extra.source ?? value?.source ?? evidence?.source ?? evidence?.provenance?.source ?? null;
  const detail = extra.detail ?? value?.detail ?? evidence?.detail ?? evidence?.reason ?? null;
  const evidenceId = extra.evidenceId ?? value?.evidenceId ?? value?.id ?? evidence?.evidenceId ?? evidence?.id ?? null;
  return {
    ...extra,
    evidenceId,
    kind: typeof value?.kind === 'string' && value.kind.trim() ? value.kind : kind,
    verdict: canonicalVerdict(value, fallbackVerdict),
    source,
    detail,
    evidence,
  };
}

function combinedCompleteness(base, functionResult, baseHasNext) {
  const baseCompleteness = base?.status?.completeness ?? 'partial';
  const functionCompleteness = functionResult?.status?.completeness ?? 'complete';
  if (baseCompleteness === 'truncated' || functionCompleteness === 'truncated') return 'truncated';
  if (baseHasNext || baseCompleteness === 'partial' || functionCompleteness === 'partial') return 'partial';
  if (baseCompleteness === 'unsupported' && functionCompleteness === 'unsupported') return 'unsupported';
  if (baseCompleteness === 'unsupported' || functionCompleteness === 'unsupported') return 'partial';
  return 'complete';
}

/**
 * Product-facing AnalysisQuery adapter.
 *
 * Historical Product Evidence rendered symbols, function-analysis evidence,
 * runtime observations, and rewrite proof by reading each live owner from UI
 * code. This adapter is the compatibility join point instead: the public
 * AnalysisQueryAPI wraps this method in one AnalysisSnapshot stale check, and
 * the UI only receives typed rows with a producer-owned verdict.
 */
export function createAppAnalysisQueryAdapter(app) {
  const base = createProductAdapter(app);
  return {
    ...base,
    async evidence(snapshot, query = {}, page = {}, options = {}) {
      const requested = pageOf(page);
      const baseResult = await base.evidence(
        snapshot,
        query,
        { offset: 0, limit: MAX_EVIDENCE_ROWS },
        options,
      );
      const rows = [];
      for (const item of Array.isArray(baseResult?.value) ? baseResult.value : []) {
        rows.push(projectEvidence('evidence', item));
      }

      const rawTarget = query?.functionId ?? query?.address ?? null;
      const address = addressOf(rawTarget);
      let functionResult = null;
      if (address != null) {
        functionResult = await base.functionById(snapshot, address, options);
        const value = functionResult?.value ?? null;

        const boundaryEvidence = app?.symbols?.functionEvidence?.(address) ?? null;
        if (boundaryEvidence) {
          rows.unshift(projectEvidence('function-boundary', boundaryEvidence, {
            title: 'Function boundary',
            address,
          }));
        }

        const name = app?.symbols?.nameAt?.(address) ?? null;
        const nameEvidence = app?.symbols?.nameEvidence?.(address) ?? null;
        if (name != null || nameEvidence) {
          rows.unshift(projectEvidence('function-name', nameEvidence ?? {}, {
            title: 'Function name',
            address,
            detail: typeof name === 'string' ? name : null,
          }));
        }

        for (const evidence of Array.isArray(value?.evidence) ? value.evidence : []) {
          rows.push(projectEvidence('function-analysis', evidence, { address }));
        }
        for (const proof of Array.isArray(value?.rewriteProof) ? value.rewriteProof : []) {
          rows.push(projectEvidence('rewrite-proof', proof, {
            address,
            title: typeof proof?.rule === 'string' ? proof.rule : typeof proof?.name === 'string' ? proof.name : 'Decompiler rewrite',
          }));
        }
        for (const observation of runtimeEvidenceForApp(app, address)) {
          rows.push(projectEvidence('runtime-observation', observation, {
            address,
            binaryHash: observation?.binaryHash ?? null,
            sliceIdentity: observation?.sliceIdentity ?? null,
          }, 'confirmed'));
        }
      }

      const capped = rows.length > MAX_EVIDENCE_ROWS;
      const source = capped ? rows.slice(0, MAX_EVIDENCE_ROWS) : rows;
      const value = source.slice(requested.offset, requested.offset + requested.limit);
      const baseHasNext = baseResult?.page?.next != null;
      let completeness = combinedCompleteness(baseResult, functionResult, baseHasNext);
      if (capped) completeness = 'truncated';
      if (source.length && completeness === 'unsupported') completeness = 'partial';
      const next = requested.offset + value.length < source.length
        ? requested.offset + value.length
        : null;

      return {
        value,
        status: {
          ...(baseResult?.status && typeof baseResult.status === 'object' ? baseResult.status : {}),
          completeness,
          reason: capped
            ? 'product-evidence-row-cap'
            : baseHasNext
              ? 'upstream-evidence-page-cap'
              : baseResult?.status?.reason ?? functionResult?.status?.reason ?? null,
          producer: 'canonical-product-evidence-adapter/v1',
        },
        page: {
          offset: requested.offset,
          limit: requested.limit,
          returned: value.length,
          total: completeness === 'complete' ? source.length : null,
          next,
        },
      };
    },
  };
}
