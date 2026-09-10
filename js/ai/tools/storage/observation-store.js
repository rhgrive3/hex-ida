import { CursorCodec, shortHash, stableSerialize } from '../paging/cursor.js';
import { completenessOf } from '../projections/index.js';

const FORBIDDEN_PATH = new Set(['__proto__', 'prototype', 'constructor']);

function textIdentity(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'bigint') return `0x${value.toString(16)}`;
  if (typeof value === 'object') {
    if (value.identity != null) return textIdentity(value.identity);
    if (value.id != null) return textIdentity(value.id);
    if (value.uuid != null) return textIdentity(value.uuid);
    if (value.address != null) return textIdentity(value.address);
    return null;
  }
  return String(value);
}

export function analysisBinding(context = {}, extra = {}) {
  const binaryIdentity = textIdentity(
    extra.binaryIdentity ?? context.binaryIdentity ?? context.binaryId ?? context.binary?.identity ?? context.binary?.id ?? context.binary?.uuid ??
    context.program?.binaryIdentity ?? context.program?.binaryId ?? context.program?.id ?? context.project?.binaryIdentity ?? context.project?.binaryId ?? 'binary:unknown'
  ) || 'binary:unknown';
  const analysisRevision = textIdentity(
    extra.analysisRevision ?? context.analysisRevision ?? context.analysis?.revision ?? context.binary?.analysisRevision ?? context.binary?.revision ?? context.program?.analysisRevision ?? context.program?.revision ?? context.revision ?? context.project?.analysisRevision ?? 'analysis:0'
  ) || 'analysis:0';
  const sliceIdentity = textIdentity(extra.sliceIdentity ?? context.sliceIdentity ?? context.binary?.sliceIdentity ?? context.binary?.slice ?? 'slice:default') || 'slice:default';
  const projectRevision = textIdentity(
    extra.projectRevision ?? context.projectRevision ?? context.project?.revision ?? context.project?.analysisRevision ??
    context.project?.analysisSemanticRevision ?? context.project?.modifiedAt ?? 'project:0'
  ) || 'project:0';
  const runtimeSession = textIdentity(extra.runtimeSession ?? context.runtimeSessionId ?? context.runtimeSession?.id ?? context.runtime?.sessionId ?? 'runtime:none') || 'runtime:none';
  const key = shortHash({ binaryIdentity, analysisRevision, sliceIdentity, projectRevision, runtimeSession });
  return { binaryIdentity, analysisRevision, sliceIdentity, projectRevision, runtimeSession, key };
}

function parsePath(path) {
  if (path == null || path === '' || path === '$') return [];
  const raw = String(path).replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1');
  if (!raw) return [];
  const parts = raw.split('.').filter(Boolean);
  if (parts.length > 32) throw new Error('detail-path-too-deep');
  for (const part of parts) if (FORBIDDEN_PATH.has(part)) throw new Error('invalid-detail-path');
  return parts;
}

function atPath(root, path) {
  let value = root;
  for (const part of parsePath(path)) {
    if (value == null || (typeof value !== 'object' && !Array.isArray(value))) throw new Error('detail-path-not-found');
    if (!Object.prototype.hasOwnProperty.call(value, part)) throw new Error('detail-path-not-found');
    value = value[part];
  }
  return value;
}

function boundedLimit(value, fallback = 100, max = 500) {
  // Paging budgets are schema numbers: structured values must never coerce
  // into a page limit authority (#5428).
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

const SCOPE_WIDTH = Object.freeze({ selection: 0, function: 1, neighborhood: 2, auto: 3, binary: 3, project: 3, runtime: 3 });

export function assertScopeAccess(record, requestedScope = null, requestedBoundary = null) {
  if (!record || typeof record !== 'object') return;
  const requested = typeof requestedScope === 'string' ? requestedScope : null;
  const requestedWidth = requested ? SCOPE_WIDTH[requested] : null;
  if (!requested || requested === 'auto' || requestedWidth == null || requestedWidth >= 3) return;
  const acquired = typeof record.effectiveScope === 'string' ? record.effectiveScope : null;
  const acquiredWidth = acquired == null ? null : SCOPE_WIDTH[acquired];
  if (acquiredWidth == null || acquiredWidth > requestedWidth ||
      !requestedBoundary || !record.scopeBoundary || record.scopeBoundary !== requestedBoundary) {
    throw new Error('scope_violation');
  }
}

// Detail refs are Map identity keys, not coercible text: only a canonical
// primitive string may reach a record, so a structured value can never alias
// another observation's payload/provenance (#5425).
function observationRefKey(detailRef) {
  return typeof detailRef === 'string' && detailRef ? detailRef : '';
}

function finiteConfiguredNumber(value, fallback) {
  // Retention budgets are schema numbers: only a primitive finite number is
  // an explicit configured value; strings/arrays/booleans fall back (#5428).
  return typeof value === 'number' && Number.isFinite(value) && value !== 0 ? value : fallback;
}

function pageValue(value, offset, limit) {
  if (Array.isArray(value)) {
    const total = value.length;
    const start = Math.max(0, Math.min(total, offset));
    const page = value.slice(start, start + limit);
    return { value: page, total, returned: page.length, offset: start, nextOffset: start + page.length < total ? start + page.length : null, kind: 'array' };
  }
  if (typeof value === 'string') {
    const total = value.length;
    const start = Math.max(0, Math.min(total, offset));
    const page = value.slice(start, start + Math.max(256, limit * 64));
    return { value: page, total, returned: page.length, offset: start, nextOffset: start + page.length < total ? start + page.length : null, kind: 'string' };
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const total = entries.length;
    const start = Math.max(0, Math.min(total, offset));
    const selected = entries.slice(start, start + limit);
    return {
      value: Object.fromEntries(selected), total, returned: selected.length, offset: start,
      nextOffset: start + selected.length < total ? start + selected.length : null, kind: 'object',
    };
  }
  return { value, total: value == null ? 0 : 1, returned: value == null ? 0 : 1, offset: 0, nextOffset: null, kind: 'scalar' };
}

function sourceCompleteness(fullResult, selected) {
  const root = completenessOf(fullResult);
  if (root.complete === false || selected === fullResult) return root;
  const selectedCompleteness = completenessOf(selected);
  return selectedCompleteness.complete === false ? selectedCompleteness : root;
}

function detailCompleteness(page, source) {
  const pageComplete = page.nextOffset == null;
  const sourceComplete = source.complete !== false;
  const pageCoverage = page.total ? Math.min(1, (page.offset + page.returned) / page.total) : 1;
  return {
    // Exhausting a page cannot upgrade a source that was already bounded or
    // otherwise incomplete. Keep the source reason ahead of page navigation.
    complete: sourceComplete && pageComplete,
    returned: page.returned,
    total: page.total,
    coverage: sourceComplete ? pageCoverage : source.coverage,
    reason: sourceComplete ? (pageComplete ? null : 'result-limit') : source.reason,
  };
}

export class ObservationStore {
  constructor({ context = {}, maxEntries = DEFAULT_MAX_ENTRIES, maxAgeMs = DEFAULT_MAX_AGE_MS, cursorCodec = null } = {}) {
    this.context = context;
    this.maxEntries = Math.min(Number.MAX_SAFE_INTEGER, Math.max(16, Math.floor(finiteConfiguredNumber(maxEntries, DEFAULT_MAX_ENTRIES))));
    this.maxAgeMs = Math.min(Number.MAX_SAFE_INTEGER, Math.max(10_000, Math.floor(finiteConfiguredNumber(maxAgeMs, DEFAULT_MAX_AGE_MS))));
    this.cursorCodec = cursorCodec || new CursorCodec({ maxAgeMs: this.maxAgeMs });
    this.records = new Map();
    this.cache = new Map();
    this.sequence = 0;
  }

  binding(extra = {}) { return analysisBinding(this.context, extra); }

  setContext(context) { this.context = context || {}; return this; }

  pin(detailRef) {
    const record = this.records.get(observationRefKey(detailRef));
    if (!record) return false;
    record.pinned = true;
    return true;
  }

  unpin(detailRef) {
    const record = this.records.get(observationRefKey(detailRef));
    if (!record) return false;
    record.pinned = false;
    this.evict();
    return true;
  }

  cacheKey(tool, args, extra = {}) {
    const binding = this.binding(extra);
    return `${binding.key}:${tool}:${shortHash(stableSerialize(args || {}))}`;
  }

  getCached(tool, args, extra = {}, requestedScope = null, requestedBoundary = null) {
    const key = this.cacheKey(tool, args, extra);
    const id = this.cache.get(key);
    if (!id) return null;
    try { return this.get(id, requestedScope, requestedBoundary); } catch { this.cache.delete(key); return null; }
  }

  put({ tool, arguments: args = {}, fullResult, functionIdentity = null, deterministic = true, extraBinding = {}, effectiveScope = null, scopeBoundary = null } = {}) {
    const binding = this.binding(extraBinding);
    const cacheKey = deterministic ? this.cacheKey(tool, args, extraBinding) : null;
    if (cacheKey) {
      const existing = this.cache.get(cacheKey);
      if (existing) {
        try { return this.get(existing, effectiveScope, scopeBoundary); } catch { this.cache.delete(cacheKey); }
      }
    }
    this.sequence += 1;
    const id = `obs_${binding.key}_${this.sequence.toString(36)}_${shortHash(`${Date.now()}:${Math.random()}`)}`;
    const record = {
      id, tool: String(tool || 'unknown'), arguments: args, fullResult, binding,
      binaryIdentity: binding.binaryIdentity,
      functionIdentity: functionIdentity == null ? null : textIdentity(functionIdentity),
      effectiveScope: typeof effectiveScope === 'string' && effectiveScope ? effectiveScope : null,
      scopeBoundary: typeof scopeBoundary === 'string' && scopeBoundary ? scopeBoundary : null,
      createdAt: Date.now(), cacheKey, pinned: false,
    };
    this.records.set(id, record);
    if (cacheKey) this.cache.set(cacheKey, id);
    this.evict();
    return record;
  }

  evict() {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.pinned || now - record.createdAt <= this.maxAgeMs) continue;
      this.records.delete(id);
      if (record.cacheKey && this.cache.get(record.cacheKey) === id) this.cache.delete(record.cacheKey);
    }
    while (this.records.size > this.maxEntries) {
      let victim = null;
      for (const entry of this.records) {
        if (!entry[1].pinned) { victim = entry; break; }
      }
      // Evidence provenance is lossless. If every observation is pinned by an
      // evidence record, prefer correctness over silently dropping provenance.
      if (!victim) break;
      const [id, record] = victim;
      this.records.delete(id);
      if (record.cacheKey && this.cache.get(record.cacheKey) === id) this.cache.delete(record.cacheKey);
    }
  }

  get(detailRef, requestedScope = null, requestedBoundary = null) {
    this.evict();
    const record = this.records.get(observationRefKey(detailRef));
    if (!record) throw new Error('unknown-detail-ref');
    assertScopeAccess(record, requestedScope, requestedBoundary);
    const current = this.binding();
    if (record.binding.key !== current.key || record.binaryIdentity !== current.binaryIdentity) throw new Error('stale-detail-ref');
    if (!record.pinned && Date.now() - record.createdAt > this.maxAgeMs) throw new Error('stale-detail-ref');
    return record;
  }

  detail({ detailRef, path = '$', cursor = null, limit = 100, effectiveScope = null, scopeBoundary = null } = {}) {
    const record = this.get(detailRef, effectiveScope, scopeBoundary);
    const currentBinding = this.binding();
    let offset = 0;
    let effectivePath = path || '$';
    if (cursor) {
      const payload = this.cursorCodec.decode(cursor, { bindingKey: currentBinding.key, kind: 'observation-detail' });
      if (payload.detailRef !== record.id) throw new Error('cursor-detail-mismatch');
      effectivePath = payload.path || '$';
      offset = Math.max(0, Number(payload.offset) || 0);
    }
    const safeLimit = boundedLimit(limit);
    const selected = atPath(record.fullResult, effectivePath);
    const page = pageValue(selected, offset, safeLimit);
    const completeness = detailCompleteness(page, sourceCompleteness(record.fullResult, selected));
    const nextCursor = page.nextOffset == null ? null : this.cursorCodec.encode({
      kind: 'observation-detail', bindingKey: currentBinding.key, detailRef: record.id,
      path: effectivePath, offset: page.nextOffset,
    });
    return {
      detailRef: record.id,
      tool: record.tool,
      path: effectivePath,
      data: page.value,
      completeness,
      continuation: nextCursor ? { cursor: nextCursor } : null,
      origin: {
        tool: record.tool,
        arguments: record.arguments,
        binaryIdentity: record.binaryIdentity,
        functionIdentity: record.functionIdentity,
        effectiveScope: record.effectiveScope,
        scopeBoundary: record.scopeBoundary,
        createdAt: record.createdAt,
      },
    };
  }

  clear() { this.records.clear(); this.cache.clear(); }
}
