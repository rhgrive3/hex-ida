/**
 * First-class, bounded taint values for symbolic analysis.
 *
 * Taint is deliberately separate from the Expr DAG.  An unknown semantic
 * value, an unknown sanitizer, or an incomplete memory/control edge can never
 * become clean merely because its expression happens to simplify.
 */

import { stableDigest } from '../../core/identity/index.js';

export const TAINT_VERSION = 'symbolic-taint-proof-v1';

export const TAINT_KIND = Object.freeze({
  CLEAN: 'clean',
  TAINTED: 'tainted',
  UNKNOWN: 'unknown',
});

export const TAINT_STATUS = Object.freeze({
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  UNKNOWN: 'unknown',
  BUDGET_LIMITED: 'budget-limited',
  CANCELLED: 'cancelled',
});

function nonEmpty(value, code) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(code);
  return value.trim();
}

function freezeObject(value) {
  if (value == null || typeof value !== 'object') return value ?? null;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  return value;
}

function normalizeLabel(label, fallback = {}) {
  if (typeof label === 'string') label = { id: label, source: label };
  if (!label || typeof label !== 'object' || Array.isArray(label)) throw new TypeError('taint-label-object-required');
  const source = nonEmpty(String(label.source ?? label.origin ?? fallback.source ?? label.id ?? 'unknown'), 'taint-label-source-required');
  const category = nonEmpty(String(label.category ?? fallback.category ?? 'data'), 'taint-label-category-required');
  const id = nonEmpty(String(label.id ?? `taint_${stableDigest({ source, category, origin: label.origin ?? fallback.origin ?? null }).slice(0, 24)}`), 'taint-label-id-required');
  return {
    id,
    source,
    category,
    origin: label.origin ?? fallback.origin ?? null,
    implicit: label.implicit === true || fallback.implicit === true,
    metadata: label.metadata && typeof label.metadata === 'object' ? { ...label.metadata } : null,
  };
}

export function createTaintLabel(label, fallback = {}) {
  const normalized = normalizeLabel(label, fallback);
  return Object.freeze({
    version: TAINT_VERSION,
    ...normalized,
    metadata: normalized.metadata == null ? null : Object.freeze(normalized.metadata),
  });
}

function normalizeLabels(labels = []) {
  const all = [];
  for (const label of labels || []) all.push(createTaintLabel(label));
  const byId = new Map(all.map((label) => [label.id, label]));
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeReasons(reasons = []) {
  const values = Array.isArray(reasons) ? reasons : [reasons];
  return [...new Set(values.filter((reason) => reason != null).map(String).filter(Boolean))].sort();
}

function normalizeProvenance(provenance) {
  if (provenance == null) return Object.freeze({});
  if (typeof provenance !== 'object' || Array.isArray(provenance)) return Object.freeze({ value: String(provenance) });
  return Object.freeze({ ...provenance });
}

export function createTaint({
  labels = [],
  control = [],
  unknown = false,
  reasons = [],
  provenance = null,
  status = null,
} = {}) {
  const normalizedLabels = normalizeLabels(labels);
  const normalizedControl = normalizeLabels(control);
  const isUnknown = unknown === true || status === TAINT_KIND.UNKNOWN || status === TAINT_STATUS.UNKNOWN;
  const normalizedReasons = normalizeReasons(reasons);
  const kind = isUnknown
    ? TAINT_KIND.UNKNOWN
    : (normalizedLabels.length || normalizedControl.length ? TAINT_KIND.TAINTED : TAINT_KIND.CLEAN);
  return Object.freeze({
    version: TAINT_VERSION,
    kind,
    status: isUnknown ? TAINT_STATUS.UNKNOWN : TAINT_STATUS.COMPLETE,
    labels: Object.freeze(normalizedLabels),
    control: Object.freeze(normalizedControl),
    unknown: isUnknown,
    reasons: Object.freeze(normalizedReasons),
    provenance: normalizeProvenance(provenance),
  });
}

export const CLEAN_TAINT = createTaint();

export function cleanTaint(provenance = null) {
  return provenance == null ? CLEAN_TAINT : createTaint({ provenance });
}

export function unknownTaint(reason = 'unknown-taint', provenance = null, extra = {}) {
  return createTaint({
    unknown: true,
    reasons: [reason, ...(Array.isArray(extra.reasons) ? extra.reasons : [])],
    labels: extra.labels || [],
    control: extra.control || [],
    provenance,
  });
}

export function sourceTaint(source, options = {}) {
  const label = createTaintLabel({
    id: options.id,
    source,
    category: options.category ?? 'source',
    origin: options.origin ?? null,
    metadata: options.metadata ?? null,
  });
  return createTaint({ labels: [label], provenance: { source: label.source, labelId: label.id, ...(options.provenance || {}) } });
}

function asTaint(value) {
  if (value && typeof value === 'object' && value.version === TAINT_VERSION && Array.isArray(value.labels)) return value;
  if (value == null) return CLEAN_TAINT;
  return unknownTaint('malformed-taint-value', { valueType: typeof value });
}

export function joinTaint(...inputs) {
  const values = inputs.flat().map(asTaint);
  const labels = values.flatMap((value) => value.labels || []);
  const control = values.flatMap((value) => value.control || []);
  const reasons = values.flatMap((value) => value.reasons || []);
  const unknown = values.some((value) => value.unknown === true || value.status !== TAINT_STATUS.COMPLETE);
  const provenance = {
    parents: values.map((value) => taintDigest(value)),
  };
  return createTaint({ labels, control, unknown, reasons, provenance });
}

export function withControl(value, control, provenance = null) {
  const base = asTaint(value);
  const condition = asTaint(control);
  if (!condition.unknown && condition.labels.length === 0 && condition.control.length === 0) {
    return provenance == null ? base : createTaint({
      labels: base.labels,
      control: base.control,
      unknown: base.unknown,
      reasons: base.reasons,
      provenance: { ...base.provenance, ...provenance },
    });
  }
  return createTaint({
    labels: [...base.labels, ...condition.labels],
    control: [...base.control, ...condition.labels, ...condition.control],
    unknown: base.unknown || condition.unknown,
    reasons: [...base.reasons, ...condition.reasons],
    provenance: { ...base.provenance, ...(provenance || {}), implicit: true },
  });
}

export function sanitizeTaint(value, sanitizer = null, provenance = null) {
  const base = asTaint(value);
  if (!sanitizer || typeof sanitizer !== 'object' || sanitizer.known !== true || sanitizer.proven !== true) {
    return unknownTaint('unknown-sanitizer', provenance, {
      labels: base.labels,
      control: base.control,
      reasons: base.reasons,
    });
  }
  const removes = new Set((Array.isArray(sanitizer.removes) ? sanitizer.removes : []).map(String));
  const labels = base.labels.filter((label) => !removes.has(label.id) && !removes.has(label.category) && !removes.has(label.source));
  return createTaint({
    labels,
    control: base.control,
    unknown: base.unknown,
    reasons: base.reasons,
    provenance: { ...base.provenance, ...(provenance || {}), sanitizer: sanitizer.id ?? sanitizer.name ?? 'known' },
  });
}

export function isTaint(value) {
  return !!value && typeof value === 'object' && value.version === TAINT_VERSION && Array.isArray(value.labels);
}

export function isTainted(value) {
  const taint = asTaint(value);
  return taint.unknown === true || taint.labels.length > 0 || taint.control.length > 0;
}

export function hasUnknownTaint(value) {
  const taint = asTaint(value);
  return taint.unknown === true || taint.status !== TAINT_STATUS.COMPLETE;
}

export function taintDigest(value) {
  const taint = asTaint(value);
  return stableDigest({
    version: TAINT_VERSION,
    kind: taint.kind,
    labels: taint.labels,
    control: taint.control,
    unknown: taint.unknown,
    reasons: taint.reasons,
    provenance: taint.provenance,
  });
}

export function taintKind(value) {
  return asTaint(value).kind;
}
