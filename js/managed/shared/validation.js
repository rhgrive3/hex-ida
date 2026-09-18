import { deepFreeze, jsonSafe, stableDigest } from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';

export const MANAGED_VALIDATION_STATUS = Object.freeze(['valid', 'invalid', 'partial', 'unsupported']);
const STATUS_SET = new Set(MANAGED_VALIDATION_STATUS);
const STRUCTURAL_SET = new Set(['complete', 'partial', 'failed']);
const SPEC_VALIDATION_SET = new Set(['valid', 'partial', 'failed']);
const SEMANTIC_EFFECT_SET = new Set(['complete', 'partial']);
const RESOLUTION_SET = new Set(['complete', 'partial']);

function fail(code) { throw new TypeError(code); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}
function enumValue(value, allowed, code) {
  const normalized = nonEmpty(value, code);
  if (!allowed.has(normalized)) fail(code);
  return normalized;
}

function defaultCompleteness(status) {
  if (status === 'invalid') {
    return {
      structural: 'partial',
      specValidation: 'failed',
      semanticEffect: 'partial',
      resolution: 'partial',
    };
  }
  return {
    structural: 'partial',
    specValidation: 'partial',
    semanticEffect: 'partial',
    resolution: 'partial',
  };
}

function assertCompletenessConsistency(status, completeness) {
  const fullyComplete = completeness.structural === 'complete'
    && completeness.specValidation === 'valid'
    && completeness.semanticEffect === 'complete'
    && completeness.resolution === 'complete';
  const hasFailure = completeness.structural === 'failed'
    || completeness.specValidation === 'failed';

  if (status === 'valid') {
    if (!fullyComplete) fail('managed-validation-completeness-inconsistent');
    return;
  }
  if (status === 'invalid') {
    if (!hasFailure) fail('managed-validation-completeness-inconsistent');
    return;
  }
  if (hasFailure || fullyComplete) fail('managed-validation-completeness-inconsistent');
}

function normalizeCompleteness(status, inputCompleteness, { requireExplicit = false } = {}) {
  if (requireExplicit && inputCompleteness === undefined) {
    fail('managed-validation-completeness-required');
  }
  const source = inputCompleteness === undefined
    ? {}
    : object(inputCompleteness, 'managed-validation-completeness-invalid');
  const defaults = defaultCompleteness(status);
  const completeness = {
    structural: enumValue(
      source.structural ?? (requireExplicit ? undefined : defaults.structural),
      STRUCTURAL_SET,
      'managed-validation-structural-completeness-invalid',
    ),
    specValidation: enumValue(
      source.specValidation ?? (requireExplicit ? undefined : defaults.specValidation),
      SPEC_VALIDATION_SET,
      'managed-validation-spec-completeness-invalid',
    ),
    semanticEffect: enumValue(
      source.semanticEffect ?? (requireExplicit ? undefined : defaults.semanticEffect),
      SEMANTIC_EFFECT_SET,
      'managed-validation-semantic-completeness-invalid',
    ),
    resolution: enumValue(
      source.resolution ?? (requireExplicit ? undefined : defaults.resolution),
      RESOLUTION_SET,
      'managed-validation-resolution-completeness-invalid',
    ),
  };
  assertCompletenessConsistency(status, completeness);
  return completeness;
}

function validateCompleteness(status, completeness) {
  const source = object(completeness, 'managed-validation-completeness-required');
  const normalized = {
    structural: enumValue(source.structural, STRUCTURAL_SET, 'managed-validation-structural-completeness-invalid'),
    specValidation: enumValue(source.specValidation, SPEC_VALIDATION_SET, 'managed-validation-spec-completeness-invalid'),
    semanticEffect: enumValue(source.semanticEffect, SEMANTIC_EFFECT_SET, 'managed-validation-semantic-completeness-invalid'),
    resolution: enumValue(source.resolution, RESOLUTION_SET, 'managed-validation-resolution-completeness-invalid'),
  };
  assertCompletenessConsistency(status, normalized);
}

export function createManagedValidationReport(input) {
  input = object(input, 'managed-validation-report-invalid');
  const targetId = nonEmpty(input.targetId ?? input.methodId ?? input.moduleId, 'managed-validation-target-id-required');
  const profileId = input.profileId == null ? null : nonEmpty(input.profileId, 'managed-validation-profile-id-invalid');
  const status = nonEmpty(input.status, 'managed-validation-status-required');
  if (!STATUS_SET.has(status)) fail('managed-validation-invalid-status');

  const errors = array(input.errors ?? [], 'managed-validation-invalid-errors');
  const warnings = array(input.warnings ?? [], 'managed-validation-invalid-warnings');
  const verifierFacts = array(input.verifierFacts ?? [], 'managed-validation-invalid-facts');
  const completeness = normalizeCompleteness(status, input.completeness, {
    requireExplicit: status === 'valid',
  });

  return deepFreeze({
    // Report identity is a canonical typed tuple, not delimiter-joined fields:
    // null and every string profile id stay distinct, and ':' inside target or
    // profile ids cannot move a field boundary (#5294).
    id: `val-rep:${stableDigest({ targetId, profileId, status })}`,
    targetId,
    profileId,
    status,
    completeness: deepFreeze(completeness),
    errors: deepFreeze(errors.map((e) => jsonSafe(e))),
    warnings: deepFreeze(warnings.map((w) => jsonSafe(w))),
    verifierFacts: deepFreeze(verifierFacts.map((f) => jsonSafe(f))),
    origin: createOriginSet(input.origin ?? { parentEntityIds: [targetId] }),
  });
}

export function validateManagedValidationReport(report) {
  report = object(report, 'managed-validation-report-invalid');
  const targetId = nonEmpty(report.targetId, 'managed-validation-report-incomplete');
  const status = nonEmpty(report.status, 'managed-validation-report-incomplete');
  const profileId = report.profileId == null
    ? null
    : nonEmpty(report.profileId, 'managed-validation-report-incomplete');
  if (targetId !== report.targetId
      || status !== report.status
      || (report.profileId != null && profileId !== report.profileId)
      || !STATUS_SET.has(status)) {
    fail('managed-validation-report-incomplete');
  }

  // Preserve the existing completeness error contract before identity/schema
  // checks so malformed authority axes remain diagnosed at their first divergence.
  validateCompleteness(status, report.completeness);

  const expectedId = `val-rep:${stableDigest({ targetId, profileId, status })}`;
  if (report.id !== expectedId) fail('managed-validation-report-id-mismatch');

  array(report.errors, 'managed-validation-invalid-errors');
  array(report.warnings, 'managed-validation-invalid-warnings');
  array(report.verifierFacts, 'managed-validation-invalid-facts');
  if (report.origin == null) fail('managed-validation-origin-required');
  createOriginSet(report.origin);
  return true;
}
