import {
  buildClassificationInput,
  createProductSurfaceQueries as createBaseProductSurfaceQueries,
} from './product-surface-base.js';

export { buildClassificationInput };

const CANONICAL_VERDICTS = new Set(['confirmed','supported','likely','unverified','contradicted','unknown']);
const CURRENT_VERDICTS = new Set(['confirmed','supported','likely','unverified','contradicted','unknown']);

function normalizeVerdict(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return CANONICAL_VERDICTS.has(normalized) ? normalized : null;
}

/**
 * Claim verdict authority is proof/evidence, never a compatibility report's
 * presentation fields. `item.verdict`, `item.confirmed`, and confidence remain
 * display/history inputs only and cannot promote a claim.
 */
export function canonicalClaimVerdict(item) {
  if (!item || typeof item !== 'object') return 'unverified';
  if (item.superseded === true || item.supersededBy != null) return 'unknown';
  if (Array.isArray(item.contradictions) && item.contradictions.length) return 'contradicted';
  if (item.contradicted === true) return 'contradicted';

  const proofVerdict = normalizeVerdict(item?.proof?.verdict ?? item?.claim?.proof?.verdict ?? null);
  if (proofVerdict) return proofVerdict;

  const evidenceVerdict = normalizeVerdict(item?.evidenceVerdict ?? item?.evidence?.verdict ?? null);
  if (evidenceVerdict) return evidenceVerdict;

  const canonicalClaimVerdictValue = normalizeVerdict(item?.claim?.verdict ?? null);
  return canonicalClaimVerdictValue || 'unverified';
}

function pageOf(page = {}) {
  const offset = Number(page.offset ?? 0);
  const limit = Number(page.limit ?? 200);
  return {
    offset:Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    limit:Number.isSafeInteger(limit) && limit > 0 ? Math.min(5000, limit) : 200,
  };
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('AbortError');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

async function assertCurrentSnapshot(app, snapshot, options = {}) {
  abortIfNeeded(options.signal);
  const current = await app.analysisQueries.snapshot(options);
  abortIfNeeded(options.signal);
  if (!current || current.snapshotId !== snapshot?.snapshotId) {
    const error = new Error('analysis-product-snapshot-stale');
    error.name = 'AnalysisSnapshotStaleError';
    error.code = 'ANALYSIS_SNAPSHOT_STALE';
    throw error;
  }
}

function historicalRows(report) {
  const source = report?.findings || report?.results || report?.goals || [];
  return Array.isArray(source) ? source : [];
}

function claimRows(report, snapshot) {
  return historicalRows(report)
    .filter((item) => item && typeof item === 'object')
    .filter((item) => item.superseded !== true && item.supersededBy == null)
    .map((item, index) => {
      const address = item.addr ?? item.address ?? item.functionAddr ?? item.function ?? null;
      const claimId = String(item.claimId ?? item.id ?? item.key ?? `claim-${index}`);
      return Object.freeze({
        claimId,
        targetEntityId:item.targetEntityId ?? (address == null ? null : `function:${BigInt(address).toString(16)}`),
        title:String(item.title || item.label || item.goal?.text || item.goal || 'Finding'),
        address,
        verdict:canonicalClaimVerdict(item),
        confidence:Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
        evidenceIds:Array.isArray(item.evidenceIds) ? item.evidenceIds.filter((value) => typeof value === 'string') : [],
        contradictions:Array.isArray(item.contradictions) ? item.contradictions.slice() : [],
        assumptions:Array.isArray(item.assumptions) ? item.assumptions.slice() : [],
        summary:item.summary || item.description || item.detail || null,
        snapshotId:snapshot.snapshotId,
        source:item,
      });
    });
}

function claimsEnvelope(snapshot, value, completeness, status, page) {
  return Object.freeze({
    snapshotId:snapshot.snapshotId,
    analysisEpoch:snapshot.analysisEpoch,
    completeness,
    value:Object.freeze(value),
    status:Object.freeze({ ...status, completeness }),
    page:page ? Object.freeze(page) : null,
  });
}

export function createProductSurfaceQueries(app) {
  const base = createBaseProductSurfaceQueries(app);
  return Object.freeze({
    ...base,
    async claims(snapshot, query = {}, page = {}, options = {}) {
      await assertCurrentSnapshot(app, snapshot, options);
      const holder = app?.autoReport ?? null;
      const report = holder?.report ?? null;
      const { offset, limit } = pageOf(page);
      if (!report || typeof report !== 'object') {
        return claimsEnvelope(snapshot, [], 'complete', { producer:'canonical-claim-adapter/v2' }, { offset, limit, returned:0, total:0, next:null });
      }

      if (holder?.snapshotId != null && holder.snapshotId !== snapshot.snapshotId) {
        return claimsEnvelope(snapshot, [], 'unsupported', { reason:'claim-report-snapshot-mismatch', producer:'canonical-claim-adapter/v2' }, null);
      }

      let rows = claimRows(report, snapshot);
      if (query.claimId != null) rows = rows.filter((row) => row.claimId === String(query.claimId));
      if (Array.isArray(query.verdict) && query.verdict.length) {
        const accepted = new Set(query.verdict.map(normalizeVerdict).filter((value) => value && CURRENT_VERDICTS.has(value)));
        rows = rows.filter((row) => accepted.has(row.verdict));
      }

      const value = rows.slice(offset, offset + limit);
      await assertCurrentSnapshot(app, snapshot, options);
      const partial = report.truncated === true || holder?.complete === false;
      return claimsEnvelope(snapshot, value, partial ? 'partial' : 'complete', {
        reason:partial ? (report.truncationReason || holder?.reason || 'auto-report-incomplete') : null,
        producer:'canonical-claim-adapter/v2',
        sourceIdentity:holder?.sourceIdentity ?? null,
        projectRevision:holder?.sourceIdentity?.projectRevision ?? null,
      }, {
        offset,
        limit,
        returned:value.length,
        total:partial ? null : rows.length,
        next:offset + value.length < rows.length ? offset + value.length : null,
      });
    },
  });
}
